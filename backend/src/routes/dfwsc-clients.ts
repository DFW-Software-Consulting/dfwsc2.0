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
};

export default dfwscClientRoutes;
