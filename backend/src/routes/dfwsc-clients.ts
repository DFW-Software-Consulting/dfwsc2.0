import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
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

        const [existingClient] = await db
          .select()
          .from(clients)
          .where(eq(clients.email, email))
          .limit(1);

        if (existingClient) {
          return res.status(400).send({ error: "A client with this email already exists." });
        }

        const stripeCustomer = await stripe.customers.create({
          email,
          name,
          phone,
        });

        const [createdClient] = await db
          .insert(clients)
          .values({
            id: stripeCustomer.id,
            workspace: "dfwsc_services",
            name,
            email,
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
            stripeCustomerId: stripeCustomer.id,
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
      } catch (error) {
        req.log.error(error, "Error creating DFWSC client");
        return res.status(500).send({ error: "Internal server error" });
      }
    }
  );
};

export default dfwscClientRoutes;
