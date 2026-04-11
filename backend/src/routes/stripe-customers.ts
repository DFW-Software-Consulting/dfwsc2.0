import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { db } from "../db/client";
import { clients, onboardingTokens } from "../db/schema";
import { hashApiKey, requireAdminJwt, sha256Lookup } from "../lib/auth";
import { stripe } from "../lib/stripe";

function generateApiKey(): string {
  return crypto.randomBytes(32).toString("hex");
}

const stripeCustomerRoutes: FastifyPluginAsync = async (app) => {
  // GET /stripe/customers - List Stripe customers not yet in the system
  app.get<{ Querystring: { limit?: number; starting_after?: string } }>(
    "/stripe/customers",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      try {
        const { limit = 100, starting_after } = req.query;

        // Fetch local clients to filter them out
        const existingClients = await db
          .select({ stripeCustomerId: clients.stripeCustomerId })
          .from(clients);
        const existingStripeIds = existingClients
          .map((c) => c.stripeCustomerId)
          .filter(Boolean) as string[];

        // List customers from Stripe
        const customers = await stripe.customers.list({
          limit,
          starting_after,
        });

        // Filter out customers already in the local database
        const filteredCustomers = customers.data.filter((c) => !existingStripeIds.includes(c.id));

        return res.status(200).send({
          data: filteredCustomers.map((c) => ({
            id: c.id,
            name: c.name || "Unnamed",
            email: c.email || "No email",
            created: c.created,
          })),
          has_more: customers.has_more,
        });
      } catch (error) {
        req.log.error(error, "Error fetching Stripe customers");
        return res.status(500).send({ error: "Internal server error" });
      }
    }
  );

  // POST /stripe/import-customer - Create a local client from a Stripe customer ID
  app.post<{ Body: { stripeCustomerId: string } }>(
    "/stripe/import-customer",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      try {
        const { stripeCustomerId } = req.body;

        if (!stripeCustomerId) {
          return res.status(400).send({ error: "stripeCustomerId is required." });
        }

        // Check if client already exists locally
        const [existing] = await db
          .select()
          .from(clients)
          .where(eq(clients.stripeCustomerId, stripeCustomerId))
          .limit(1);
        if (existing) {
          return res.status(409).send({ error: "Client already exists in the portal." });
        }

        // Fetch customer details from Stripe
        const customer = await stripe.customers.retrieve(stripeCustomerId);
        if (customer.deleted) {
          return res.status(400).send({ error: "Stripe customer has been deleted." });
        }

        const name = customer.name || "Imported Client";
        const email = customer.email || "unknown@imported.com";

        // Logic from createClientWithOnboardingToken
        const clientId = uuidv4();
        const apiKey = generateApiKey();
        const apiKeyHash = await hashApiKey(apiKey);
        const apiKeyLookup = sha256Lookup(apiKey);

        await db.insert(clients).values({
          id: clientId,
          name,
          email,
          apiKeyHash,
          apiKeyLookup,
          stripeCustomerId,
        });

        // Generate onboarding token (copied from connect.ts logic)
        const token = crypto.randomBytes(32).toString("hex");
        const onboardingTokenId = uuidv4();
        await db.insert(onboardingTokens).values({
          id: onboardingTokenId,
          clientId: clientId,
          token: token,
          status: "pending",
          email: email,
        });

        const frontendOrigin = process.env.FRONTEND_ORIGIN?.split(",")[0].trim().replace(/\/$/, "");
        const onboardingUrlHint = `${frontendOrigin}/onboard?token=${token}`;

        return res.status(201).send({
          name,
          clientId,
          apiKey,
          onboardingToken: token,
          onboardingUrlHint,
        });
      } catch (error) {
        req.log.error(error, "Error importing Stripe customer");
        return res.status(500).send({ error: "Internal server error" });
      }
    }
  );
};

export default stripeCustomerRoutes;
