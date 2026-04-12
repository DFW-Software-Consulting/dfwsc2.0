import { and, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import validator from "validator";
import { db } from "../db/client";
import { clientGroups, clients } from "../db/schema";
import { requireAdminJwt } from "../lib/auth";
import { createClientWithOnboardingToken } from "../lib/client-factory";
import { stripe } from "../lib/stripe";
import { isWorkspace, type Workspace } from "../lib/workspace";

const stripeCustomerRoutes: FastifyPluginAsync = async (app) => {
  // GET /stripe/customers - List Stripe customers not yet in the system
  app.get<{ Querystring: { limit?: number; starting_after?: string; workspace?: string } }>(
    "/stripe/customers",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      try {
        const { limit = 100, starting_after, workspace } = req.query;

        if (!isWorkspace(workspace)) {
          return res.status(400).send({
            error: "workspace query parameter is required (dfwsc_services|client_portal).",
          });
        }

        // List customers from Stripe
        const customers = await stripe.customers.list({
          limit,
          starting_after,
        });

        const stripeIds = customers.data.map((c) => c.id);
        const existingStripeIds =
          stripeIds.length > 0
            ? await db
                .select({ stripeCustomerId: clients.stripeCustomerId })
                .from(clients)
                .where(
                  and(
                    inArray(clients.stripeCustomerId, stripeIds),
                    eq(clients.workspace, workspace)
                  )
                )
            : [];
        const existingIdSet = new Set(
          existingStripeIds.map((c) => c.stripeCustomerId).filter(Boolean)
        );

        // Filter out customers already in the local database
        const filteredCustomers = customers.data.filter((c) => !existingIdSet.has(c.id));

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
  app.post<{ Body: { stripeCustomerId: string; groupId?: string; workspace: Workspace } }>(
    "/stripe/import-customer",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      try {
        const { stripeCustomerId, groupId, workspace } = req.body;

        if (!isWorkspace(workspace)) {
          return res
            .status(400)
            .send({ error: "workspace is required (dfwsc_services|client_portal)." });
        }

        if (!stripeCustomerId) {
          return res.status(400).send({ error: "stripeCustomerId is required." });
        }

        if (groupId) {
          const [group] = await db
            .select({ id: clientGroups.id, workspace: clientGroups.workspace })
            .from(clientGroups)
            .where(eq(clientGroups.id, groupId))
            .limit(1);
          if (!group) {
            return res.status(400).send({ error: "Invalid groupId." });
          }
          if (group.workspace !== workspace) {
            return res.status(400).send({ error: "groupId workspace does not match workspace." });
          }
        }

        // Check if client already exists locally
        const [existing] = await db
          .select()
          .from(clients)
          .where(
            and(eq(clients.stripeCustomerId, stripeCustomerId), eq(clients.workspace, workspace))
          )
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
        const email = customer.email;
        if (!email || !validator.isEmail(email)) {
          return res.status(400).send({ error: "Stripe customer must have a valid email." });
        }

        const [existingByEmail] = await db
          .select({ id: clients.id })
          .from(clients)
          .where(and(eq(clients.email, email), eq(clients.workspace, workspace)))
          .limit(1);
        if (existingByEmail) {
          return res.status(409).send({ error: "A client with this email already exists." });
        }

        const { clientId, apiKey, token } = await createClientWithOnboardingToken({
          name,
          email,
          workspace,
          stripeCustomerId,
          groupId,
        });

        const frontendOrigin = process.env.FRONTEND_ORIGIN?.split(",")[0].trim().replace(/\/$/, "");
        const onboardingUrlHint = `${frontendOrigin}/onboard?token=${token}`;

        return res.status(201).send({
          name,
          clientId,
          apiKey,
          onboardingToken: token,
          onboardingUrlHint,
          workspace,
          groupId: groupId ?? null,
        });
      } catch (error) {
        req.log.error(error, "Error importing Stripe customer");
        return res.status(500).send({ error: "Internal server error" });
      }
    }
  );
};

export default stripeCustomerRoutes;
