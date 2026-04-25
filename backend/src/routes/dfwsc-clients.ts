import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import validator from "validator";
import { db } from "../db/client";
import { clients } from "../db/schema";
import { requireAdminJwt } from "../lib/auth";
import { stripe } from "../lib/stripe-billing";

interface DfwscClientBody {
  name: string;
  email: string;
  phone?: string;
  billingContactName?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  notes?: string;
  defaultPaymentTermsDays?: number;
}

interface LeadBody {
  name: string;
  email: string;
  phone?: string;
  notes?: string;
}

interface ConvertParams {
  id: string;
}

const dfwscClientRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: DfwscClientBody }>(
    "/dfwsc/clients",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      try {
        const {
          name,
          email,
          phone,
          billingContactName,
          addressLine1,
          addressLine2,
          city,
          state,
          postalCode,
          country,
          notes,
          defaultPaymentTermsDays,
        } = req.body;

        if (!name || !email) {
          return res.status(400).send({ error: "name and email are required." });
        }

        if (!validator.isEmail(email)) {
          return res.status(400).send({ error: "Invalid email format." });
        }

        const workspace = "dfwsc_services";
        const normalizedEmail = email.toLowerCase().trim();

        // Check for existing client with same email in this workspace (race condition protection)
        const [existingClient] = await db
          .select()
          .from(clients)
          .where(and(eq(clients.email, normalizedEmail), eq(clients.workspace, workspace)))
          .limit(1);

        if (existingClient) {
          return res
            .status(409)
            .send({ error: "A client with this email already exists in this workspace." });
        }

        let stripeCustomerId: string | null = null;
        try {
          const stripeCustomer = await stripe.customers.create({
            email: normalizedEmail,
            name,
            phone,
            address: {
              line1: addressLine1 ?? undefined,
              line2: addressLine2 ?? undefined,
              city: city ?? undefined,
              state: state ?? undefined,
              postal_code: postalCode ?? undefined,
              country: country ?? undefined,
            },
            metadata: {
              billingContactName: billingContactName ?? "",
              notes: notes ?? "",
              defaultPaymentTermsDays:
                defaultPaymentTermsDays != null ? String(defaultPaymentTermsDays) : "",
            },
          });
          stripeCustomerId = stripeCustomer.id;

          const [createdClient] = await db
            .insert(clients)
            .values({
              id: stripeCustomerId,
              workspace,
              name,
              email: normalizedEmail,
              phone: phone ?? null,
              billingContactName: billingContactName ?? null,
              addressLine1: addressLine1 ?? null,
              addressLine2: addressLine2 ?? null,
              city: city ?? null,
              state: state ?? null,
              postalCode: postalCode ?? null,
              country: country ?? null,
              notes: notes ?? null,
              defaultPaymentTermsDays: defaultPaymentTermsDays ?? null,
              stripeCustomerId,
              status: "active",
            })
            .returning();

          return res.status(201).send({
            id: createdClient.id,
            name: createdClient.name,
            email: createdClient.email,
            phone: createdClient.phone,
            billingContactName: createdClient.billingContactName,
            addressLine1: createdClient.addressLine1,
            addressLine2: createdClient.addressLine2,
            city: createdClient.city,
            state: createdClient.state,
            postalCode: createdClient.postalCode,
            country: createdClient.country,
            notes: createdClient.notes,
            defaultPaymentTermsDays: createdClient.defaultPaymentTermsDays,
            stripeCustomerId: createdClient.stripeCustomerId,
            status: createdClient.status,
            createdAt: createdClient.createdAt?.toISOString(),
          });
        } catch (dbError) {
          // Rollback: Delete the Stripe customer if DB insert fails
          if (stripeCustomerId) {
            try {
              await stripe.customers.del(stripeCustomerId);
              req.log.info(
                { stripeCustomerId },
                "Rolled back Stripe customer creation due to DB error"
              );
            } catch (rollbackError) {
              req.log.error(
                { stripeCustomerId, rollbackError },
                "Failed to rollback Stripe customer"
              );
            }
          }
          throw dbError;
        }
      } catch (error) {
        req.log.error(error, "Error creating DFWSC client");
        // Check for unique constraint violation (race condition where another request created the client)
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes("unique constraint") || errorMessage.includes("duplicate key")) {
          return res.status(400).send({ error: "A client with this email already exists." });
        }
        return res.status(500).send({ error: "Internal server error" });
      }
    }
  );
  // POST /dfwsc/leads — create a potential client (no Stripe, no billing yet)
  app.post<{ Body: LeadBody }>("/dfwsc/leads", { preHandler: requireAdminJwt }, async (req, res) => {
    try {
      const { name, email, phone, notes } = req.body;

      if (!name || !email) {
        return res.status(400).send({ error: "name and email are required." });
      }
      if (!validator.isEmail(email)) {
        return res.status(400).send({ error: "Invalid email format." });
      }

      const workspace = "dfwsc_services";
      const normalizedEmail = email.toLowerCase().trim();

      const [existing] = await db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.email, normalizedEmail), eq(clients.workspace, workspace)))
        .limit(1);

      if (existing) {
        return res.status(409).send({ error: "A client or lead with this email already exists." });
      }

      const [lead] = await db
        .insert(clients)
        .values({
          id: randomUUID(),
          workspace,
          name: name.trim(),
          email: normalizedEmail,
          phone: phone?.trim() ?? null,
          notes: notes?.trim() ?? null,
          status: "lead",
        })
        .returning();

      return res.status(201).send({
        id: lead.id,
        name: lead.name,
        email: lead.email,
        phone: lead.phone,
        notes: lead.notes,
        status: lead.status,
        createdAt: lead.createdAt?.toISOString(),
      });
    } catch (error) {
      req.log.error(error, "Error creating lead");
      return res.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /dfwsc/leads/:id/convert — promote a lead to a real client by creating their Stripe customer
  app.post<{ Params: ConvertParams }>(
    "/dfwsc/leads/:id/convert",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      try {
        const { id } = req.params;

        const [lead] = await db
          .select()
          .from(clients)
          .where(and(eq(clients.id, id), eq(clients.workspace, "dfwsc_services")))
          .limit(1);

        if (!lead) return res.status(404).send({ error: "Lead not found." });
        if (lead.status !== "lead") {
          return res.status(400).send({ error: "This record is already a client." });
        }

        let stripeCustomerId: string | null = null;
        try {
          const stripeCustomer = await stripe.customers.create({
            email: lead.email,
            name: lead.name,
            phone: lead.phone ?? undefined,
            address: {
              line1: lead.addressLine1 ?? undefined,
              line2: lead.addressLine2 ?? undefined,
              city: lead.city ?? undefined,
              state: lead.state ?? undefined,
              postal_code: lead.postalCode ?? undefined,
              country: lead.country ?? undefined,
            },
            metadata: {
              billingContactName: lead.billingContactName ?? "",
              notes: lead.notes ?? "",
            },
          });
          stripeCustomerId = stripeCustomer.id;

          const [updated] = await db
            .update(clients)
            .set({ stripeCustomerId, status: "active", updatedAt: new Date() })
            .where(eq(clients.id, id))
            .returning();

          const { apiKeyHash, apiKeyLookup, ...safe } = updated;
          return res.status(200).send({
            ...safe,
            createdAt: updated.createdAt?.toISOString(),
            updatedAt: updated.updatedAt?.toISOString(),
            suspendedAt: null,
            paymentStatusSyncedAt: null,
          });
        } catch (stripeOrDbError) {
          if (stripeCustomerId) {
            try {
              await stripe.customers.del(stripeCustomerId);
            } catch (rollbackError) {
              req.log.error({ stripeCustomerId, rollbackError }, "Failed to rollback Stripe customer");
            }
          }
          throw stripeOrDbError;
        }
      } catch (error) {
        req.log.error(error, "Error converting lead to client");
        return res.status(500).send({ error: "Internal server error" });
      }
    }
  );
};

export default dfwscClientRoutes;
