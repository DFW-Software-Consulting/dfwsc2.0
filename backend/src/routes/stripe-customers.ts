import { and, eq, inArray, ne, or } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import validator from "validator";
import { db } from "../db/client";
import { clientGroups, clients } from "../db/schema";
import { requireAdminJwt } from "../lib/auth";
import { createClientWithOnboardingToken } from "../lib/client-factory";
import { stripe } from "../lib/stripe";
import { isWorkspace, type Workspace } from "../lib/workspace";

type StripeCustomer = {
  id: string;
  object: "customer";
  name: string | null;
  email: string | null;
  phone: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    postal_code: string | null;
    country: string | null;
  } | null;
  metadata: Record<string, string>;
  created: number;
  deleted?: boolean;
};

function isValidStripeCustomer(
  c: StripeCustomer
): c is StripeCustomer & { name: string | null; email: string | null } {
  return c.id !== undefined;
}

const NATIVE_FIELDS = [
  "name",
  "email",
  "phone",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "country",
] as const;

const APP_FIELDS = ["billingContactName", "notes", "defaultPaymentTermsDays"] as const;

type FieldName = (typeof NATIVE_FIELDS)[number] | (typeof APP_FIELDS)[number];

function normalizeValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.trim();
  return String(value);
}

function getStripeFieldValue(
  customer: StripeCustomer,
  fieldName: (typeof NATIVE_FIELDS)[number]
): string {
  switch (fieldName) {
    case "name":
      return normalizeValue(customer.name);
    case "email":
      return normalizeValue(customer.email);
    case "phone":
      return normalizeValue(customer.phone);
    case "addressLine1":
      return normalizeValue(customer.address?.line1);
    case "addressLine2":
      return normalizeValue(customer.address?.line2);
    case "city":
      return normalizeValue(customer.address?.city);
    case "state":
      return normalizeValue(customer.address?.state);
    case "postalCode":
      return normalizeValue(customer.address?.postal_code);
    case "country":
      return normalizeValue(customer.address?.country);
    default:
      return "";
  }
}

function getStripeMetadataValue(
  customer: StripeCustomer,
  fieldName: (typeof APP_FIELDS)[number]
): string {
  return normalizeValue(customer.metadata?.[fieldName]);
}

interface LocalClient {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  billingContactName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  notes: string | null;
  defaultPaymentTermsDays: number | null;
  stripeCustomerId: string | null;
}

interface ReconciliationResult {
  toImport: Array<{
    stripeCustomer: StripeCustomer;
    reason: "no-match" | "email-conflict";
  }>;
  discrepancies: Array<{
    stripeCustomer: StripeCustomer;
    localClient: LocalClient;
    differences: Array<{
      fieldName: string;
      localValue: string;
      stripeValue: string;
    }>;
  }>;
  allGood: Array<{
    stripeCustomer: StripeCustomer;
    localClient: LocalClient;
  }>;
}

async function reconcileDfwscCustomers(): Promise<ReconciliationResult> {
  const allStripeCustomers = await stripe.customers.list({ limit: 100 });
  const allStripe = allStripeCustomers.data as StripeCustomer[];

  const allLocalClients = await db
    .select()
    .from(clients)
    .where(eq(clients.workspace, "dfwsc_services"))
    .limit(100);

  const localByStripeId = new Map<string, LocalClient>();
  const localByEmail = new Map<string, LocalClient>();

  for (const client of allLocalClients as LocalClient[]) {
    if (client.stripeCustomerId) {
      localByStripeId.set(client.stripeCustomerId, client);
    }
    if (client.email) {
      localByEmail.set(client.email.toLowerCase(), client);
    }
  }

  const result: ReconciliationResult = {
    toImport: [],
    discrepancies: [],
    allGood: [],
  };

  for (const stripeCustomer of allStripe) {
    if (stripeCustomer.deleted) continue;

    const stripeEmail = normalizeValue(stripeCustomer.email).toLowerCase();
    const localById = localByStripeId.get(stripeCustomer.id);

    if (localById) {
      const differences: Array<{
        fieldName: string;
        localValue: string;
        stripeValue: string;
      }> = [];

      for (const field of NATIVE_FIELDS) {
        let localValue = "";
        let stripeValue = "";

        if (field === "name") {
          localValue = normalizeValue(localById.name);
          stripeValue = getStripeFieldValue(stripeCustomer, field);
        } else if (field === "email") {
          localValue = normalizeValue(localById.email);
          stripeValue = getStripeFieldValue(stripeCustomer, field);
        } else if (field === "phone") {
          localValue = normalizeValue(localById.phone);
          stripeValue = getStripeFieldValue(stripeCustomer, field);
        } else if (field === "addressLine1") {
          localValue = normalizeValue(localById.addressLine1);
          stripeValue = getStripeFieldValue(stripeCustomer, field);
        } else if (field === "addressLine2") {
          localValue = normalizeValue(localById.addressLine2);
          stripeValue = getStripeFieldValue(stripeCustomer, field);
        } else if (field === "city") {
          localValue = normalizeValue(localById.city);
          stripeValue = getStripeFieldValue(stripeCustomer, field);
        } else if (field === "state") {
          localValue = normalizeValue(localById.state);
          stripeValue = getStripeFieldValue(stripeCustomer, field);
        } else if (field === "postalCode") {
          localValue = normalizeValue(localById.postalCode);
          stripeValue = getStripeFieldValue(stripeCustomer, field);
        } else if (field === "country") {
          localValue = normalizeValue(localById.country);
          stripeValue = getStripeFieldValue(stripeCustomer, field);
        }

        if (localValue !== stripeValue) {
          differences.push({ fieldName: field, localValue, stripeValue });
        }
      }

      for (const field of APP_FIELDS) {
        let localValue = "";
        let stripeValue = "";

        if (field === "billingContactName") {
          localValue = normalizeValue(localById.billingContactName);
          stripeValue = getStripeMetadataValue(stripeCustomer, field);
        } else if (field === "notes") {
          localValue = normalizeValue(localById.notes);
          stripeValue = getStripeMetadataValue(stripeCustomer, field);
        } else if (field === "defaultPaymentTermsDays") {
          localValue = normalizeValue(localById.defaultPaymentTermsDays);
          stripeValue = getStripeMetadataValue(stripeCustomer, field);
        }

        if (localValue !== stripeValue) {
          differences.push({ fieldName: field, localValue, stripeValue });
        }
      }

      if (differences.length > 0) {
        result.discrepancies.push({
          stripeCustomer,
          localClient: localById,
          differences,
        });
      } else {
        result.allGood.push({
          stripeCustomer,
          localClient: localById,
        });
      }
    } else if (stripeEmail && localByEmail.has(stripeEmail)) {
      result.discrepancies.push({
        stripeCustomer,
        localClient: localByEmail.get(stripeEmail)!,
        differences: [
          {
            fieldName: "stripeCustomerId",
            localValue: "(none)",
            stripeValue: stripeCustomer.id,
          },
        ],
      });
    } else {
      if (stripeEmail) {
        result.toImport.push({
          stripeCustomer,
          reason: "no-match",
        });
      }
    }
  }

  return result;
}

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

        if (workspace === "dfwsc_services") {
          const reconciliation = await reconcileDfwscCustomers();
          return res.status(200).send({
            toImport: reconciliation.toImport.map((item) => ({
              stripeCustomerId: item.stripeCustomer.id,
              name: item.stripeCustomer.name || "Unnamed",
              email: item.stripeCustomer.email || "No email",
              reason: item.reason,
            })),
            discrepancies: reconciliation.discrepancies.map((item) => ({
              stripeCustomerId: item.stripeCustomer.id,
              localClientId: item.localClient.id,
              name: item.stripeCustomer.name || "Unnamed",
              email: item.stripeCustomer.email || "No email",
              differences: item.differences,
            })),
            allGood: reconciliation.allGood.map((item) => ({
              stripeCustomerId: item.stripeCustomer.id,
              localClientId: item.localClient.id,
              name: item.stripeCustomer.name || "Unnamed",
              email: item.stripeCustomer.email || "No email",
            })),
          });
        }

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

        // DFWSC direct import - create local client with stripeCustomerId, no onboarding needed
        if (workspace === "dfwsc_services") {
          const [existingByStripeId] = await db
            .select()
            .from(clients)
            .where(
              and(eq(clients.stripeCustomerId, stripeCustomerId), eq(clients.workspace, workspace))
            )
            .limit(1);
          if (existingByStripeId) {
            return res.status(409).send({ error: "Client already exists in the portal." });
          }

          const [existingByEmail] = await db
            .select({ id: clients.id })
            .from(clients)
            .where(and(eq(clients.email, email), eq(clients.workspace, workspace)))
            .limit(1);
          if (existingByEmail) {
            return res.status(409).send({ error: "A client with this email already exists." });
          }

          const clientId = stripeCustomerId;

          await db.insert(clients).values({
            id: clientId,
            workspace,
            name,
            email,
            stripeCustomerId,
            status: "active",
            phone: customer.phone || null,
            addressLine1: customer.address?.line1 || null,
            addressLine2: customer.address?.line2 || null,
            city: customer.address?.city || null,
            state: customer.address?.state || null,
            postalCode: customer.address?.postal_code || null,
            country: customer.address?.country || null,
            billingContactName: customer.metadata?.billingContactName || null,
            notes: customer.metadata?.notes || null,
            defaultPaymentTermsDays: customer.metadata?.defaultPaymentTermsDays
              ? parseInt(customer.metadata.defaultPaymentTermsDays, 10)
              : null,
          });

          return res.status(201).send({
            name,
            clientId,
            workspace,
            importedFromStripe: true,
          });
        }

        // Client portal import - use existing flow with onboarding token
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

  // POST /stripe/sync-customer - Sync a DFWSC customer's fields between Stripe and local
  interface SyncBody {
    stripeCustomerId: string;
    localClientId: string;
    workspace: Workspace;
    resolutions: Array<{
      fieldName: string;
      source: "local" | "stripe";
    }>;
  }

  app.post<{ Body: SyncBody }>(
    "/stripe/sync-customer",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      try {
        const { stripeCustomerId, localClientId, workspace, resolutions } = req.body;

        if (workspace !== "dfwsc_services") {
          return res
            .status(400)
            .send({ error: "This endpoint is only available for dfwsc_services workspace." });
        }

        if (!stripeCustomerId || !localClientId || !resolutions || resolutions.length === 0) {
          return res
            .status(400)
            .send({ error: "stripeCustomerId, localClientId, and resolutions are required." });
        }

        const [localClient] = await db
          .select()
          .from(clients)
          .where(and(eq(clients.id, localClientId), eq(clients.workspace, workspace)))
          .limit(1);
        if (!localClient) {
          return res.status(404).send({ error: "Local client not found." });
        }

        const stripeCustomerRaw = await stripe.customers.retrieve(stripeCustomerId);
        if (stripeCustomerRaw.deleted) {
          return res.status(400).send({ error: "Stripe customer has been deleted." });
        }

        const stripeCustomer: StripeCustomer = {
          id: stripeCustomerRaw.id,
          object: "customer",
          name: stripeCustomerRaw.name ?? null,
          email: stripeCustomerRaw.email ?? null,
          phone: stripeCustomerRaw.phone ?? null,
          address: stripeCustomerRaw.address ?? null,
          metadata: stripeCustomerRaw.metadata ?? {},
          created: stripeCustomerRaw.created,
          deleted: stripeCustomerRaw.deleted ?? false,
        };

        const updateStripe: Record<string, string> = {};
        const updateLocal: Record<string, unknown> = {};
        const updateMetadata: Record<string, string> = {};

        for (const resolution of resolutions) {
          const { fieldName, source } = resolution;

          if (NATIVE_FIELDS.includes(fieldName as (typeof NATIVE_FIELDS)[number])) {
            let value = "";
            if (source === "local") {
              switch (fieldName) {
                case "name":
                  value = normalizeValue(localClient.name);
                  break;
                case "email":
                  value = normalizeValue(localClient.email);
                  break;
                case "phone":
                  value = normalizeValue(localClient.phone);
                  break;
                case "addressLine1":
                  value = normalizeValue(localClient.addressLine1);
                  break;
                case "addressLine2":
                  value = normalizeValue(localClient.addressLine2);
                  break;
                case "city":
                  value = normalizeValue(localClient.city);
                  break;
                case "state":
                  value = normalizeValue(localClient.state);
                  break;
                case "postalCode":
                  value = normalizeValue(localClient.postalCode);
                  break;
                case "country":
                  value = normalizeValue(localClient.country);
                  break;
              }
              updateStripe[fieldName] = value;
            } else {
              if (fieldName === "name") {
                updateLocal.name = getStripeFieldValue(stripeCustomer, "name");
              } else if (fieldName === "email") {
                updateLocal.email = getStripeFieldValue(stripeCustomer, "email");
              } else if (fieldName === "phone") {
                updateLocal.phone = getStripeFieldValue(stripeCustomer, "phone");
              } else if (fieldName === "addressLine1") {
                updateLocal.addressLine1 = getStripeFieldValue(stripeCustomer, "addressLine1");
              } else if (fieldName === "addressLine2") {
                updateLocal.addressLine2 = getStripeFieldValue(stripeCustomer, "addressLine2");
              } else if (fieldName === "city") {
                updateLocal.city = getStripeFieldValue(stripeCustomer, "city");
              } else if (fieldName === "state") {
                updateLocal.state = getStripeFieldValue(stripeCustomer, "state");
              } else if (fieldName === "postalCode") {
                updateLocal.postalCode = getStripeFieldValue(stripeCustomer, "postalCode");
              } else if (fieldName === "country") {
                updateLocal.country = getStripeFieldValue(stripeCustomer, "country");
              }
            }
          } else if (APP_FIELDS.includes(fieldName as (typeof APP_FIELDS)[number])) {
            if (source === "local") {
              switch (fieldName) {
                case "billingContactName":
                  updateMetadata.billingContactName = normalizeValue(
                    localClient.billingContactName
                  );
                  break;
                case "notes":
                  updateMetadata.notes = normalizeValue(localClient.notes);
                  break;
                case "defaultPaymentTermsDays":
                  updateMetadata.defaultPaymentTermsDays = String(
                    localClient.defaultPaymentTermsDays ?? ""
                  );
                  break;
              }
            } else {
              if (fieldName === "billingContactName") {
                updateLocal.billingContactName = getStripeMetadataValue(
                  stripeCustomer,
                  "billingContactName"
                );
              } else if (fieldName === "notes") {
                updateLocal.notes = getStripeMetadataValue(stripeCustomer, "notes");
              } else if (fieldName === "defaultPaymentTermsDays") {
                const val = getStripeMetadataValue(stripeCustomer, "defaultPaymentTermsDays");
                updateLocal.defaultPaymentTermsDays = val ? parseInt(val, 10) : null;
              }
            }
          }
        }

        if (Object.keys(updateStripe).length > 0) {
          await stripe.customers.update(stripeCustomerId, updateStripe);
        }

        if (Object.keys(updateMetadata).length > 0) {
          await stripe.customers.update(stripeCustomerId, { metadata: updateMetadata });
        }

        if (Object.keys(updateLocal).length > 0) {
          updateLocal.updatedAt = new Date();
          await db
            .update(clients)
            .set(updateLocal as typeof updateLocal)
            .where(and(eq(clients.id, localClientId), eq(clients.workspace, workspace)));
        }

        return res.status(200).send({ success: true });
      } catch (error) {
        req.log.error(error, "Error syncing Stripe customer");
        return res.status(500).send({ error: "Internal server error" });
      }
    }
  );
};

export default stripeCustomerRoutes;
