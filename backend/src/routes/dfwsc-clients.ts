import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import validator from "validator";
import { db } from "../db/client";
import { clients } from "../db/schema";
import { requireAdminJwt } from "../lib/auth";
import { getSyncStateMap, syncClientProfileToNextcloud } from "../lib/nextcloud-sync";
import { stripe } from "../lib/stripe-billing";
import { isCrmWorkspace, type Workspace } from "../lib/workspace";

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
  workspace?: Workspace;
  name: string;
  email: string;
  phone?: string;
  notes?: string;
  lastContactAt?: string;
  nextAction?: string;
  followUpAt?: string;
}

interface ConvertParams {
  id: string;
}

function parseIsoOrNull(value?: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

async function createDirectBillableClient(workspace: Workspace, body: DfwscClientBody) {
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
  } = body;

  const normalizedEmail = email.toLowerCase().trim();
  const [existingClient] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.email, normalizedEmail), eq(clients.workspace, workspace)))
    .limit(1);

  if (existingClient) {
    return {
      error: { code: 409, message: "A client with this email already exists in this workspace." },
    };
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
        workspace,
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

    return { createdClient };
  } catch (dbError) {
    if (stripeCustomerId) {
      await stripe.customers.del(stripeCustomerId).catch(() => {});
    }
    throw dbError;
  }
}

async function createLead(workspace: "dfwsc_services" | "ledger_crm", body: LeadBody) {
  const normalizedEmail = body.email.toLowerCase().trim();
  const [existing] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.email, normalizedEmail), eq(clients.workspace, workspace)))
    .limit(1);

  if (existing) {
    return { error: { code: 409, message: "A client or lead with this email already exists." } };
  }

  const [lead] = await db
    .insert(clients)
    .values({
      id: randomUUID(),
      workspace,
      name: body.name.trim(),
      email: normalizedEmail,
      phone: body.phone?.trim() ?? null,
      notes: body.notes?.trim() ?? null,
      lastContactAt: parseIsoOrNull(body.lastContactAt),
      nextAction: body.nextAction?.trim() ?? null,
      followUpAt: parseIsoOrNull(body.followUpAt),
      status: "lead",
    })
    .returning();

  return { lead };
}

async function convertLead(workspace: "dfwsc_services" | "ledger_crm", id: string) {
  const [lead] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, id), eq(clients.workspace, workspace)))
    .limit(1);

  if (!lead) {
    return { error: { code: 404, message: "Lead not found." } };
  }
  if (lead.status !== "lead") {
    return { error: { code: 400, message: "This record is already a client." } };
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
        workspace,
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

    return { updated };
  } catch (stripeOrDbError) {
    if (stripeCustomerId) {
      await stripe.customers.del(stripeCustomerId).catch(() => {});
    }
    throw stripeOrDbError;
  }
}

const dfwscClientRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: DfwscClientBody }>(
    "/dfwsc/clients",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      try {
        const { name, email } = req.body;

        if (!name || !email) {
          return res.status(400).send({ error: "name and email are required." });
        }

        if (!validator.isEmail(email)) {
          return res.status(400).send({ error: "Invalid email format." });
        }

        const result = await createDirectBillableClient("dfwsc_services", req.body);
        if (result.error) {
          return res.status(result.error.code).send({ error: result.error.message });
        }

        if (!result.createdClient) {
          return res.status(500).send({ error: "Failed to create client." });
        }
        const createdClient = result.createdClient;

        await syncClientProfileToNextcloud(createdClient.id).catch((syncErr) => {
          req.log.warn(syncErr, "Client profile sync failed after DFWSC client create.");
        });
        const syncStateMap = await getSyncStateMap([createdClient.id]);
        const syncState = syncStateMap.get(createdClient.id);

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
          syncStatus: syncState?.syncStatus ?? "synced",
          syncError: syncState?.syncError ?? null,
          syncAttempts: syncState?.syncAttempts ?? 0,
          lastSyncAttemptAt: syncState?.lastSyncAttemptAt ?? null,
          lastSyncedAt: syncState?.lastSyncedAt ?? null,
        });
      } catch (error) {
        req.log.error(error, "Error creating DFWSC client");
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes("unique constraint") || errorMessage.includes("duplicate key")) {
          return res.status(400).send({ error: "A client with this email already exists." });
        }
        return res.status(500).send({ error: "Internal server error" });
      }
    }
  );

  app.post<{ Body: LeadBody }>("/crm/leads", { preHandler: requireAdminJwt }, async (req, res) => {
    try {
      const { workspace, name, email } = req.body;

      if (!workspace || !isCrmWorkspace(workspace)) {
        return res
          .status(400)
          .send({ error: "workspace is required (dfwsc_services|ledger_crm)." });
      }
      if (!name || !email) {
        return res.status(400).send({ error: "name and email are required." });
      }
      if (!validator.isEmail(email)) {
        return res.status(400).send({ error: "Invalid email format." });
      }

      const leadResult = await createLead(workspace, req.body);
      if (leadResult.error) {
        return res.status(leadResult.error.code).send({ error: leadResult.error.message });
      }

      if (!leadResult.lead) {
        return res.status(500).send({ error: "Failed to create lead." });
      }
      const lead = leadResult.lead;
      await syncClientProfileToNextcloud(lead.id).catch((syncErr) => {
        req.log.warn(syncErr, "Client profile sync failed after lead create.");
      });
      const syncStateMap = await getSyncStateMap([lead.id]);
      const syncState = syncStateMap.get(lead.id);
      return res.status(201).send({
        id: lead.id,
        workspace: lead.workspace,
        name: lead.name,
        email: lead.email,
        phone: lead.phone,
        notes: lead.notes,
        lastContactAt: lead.lastContactAt?.toISOString() ?? null,
        nextAction: lead.nextAction,
        followUpAt: lead.followUpAt?.toISOString() ?? null,
        status: lead.status,
        createdAt: lead.createdAt?.toISOString(),
        syncStatus: syncState?.syncStatus ?? "synced",
        syncError: syncState?.syncError ?? null,
        syncAttempts: syncState?.syncAttempts ?? 0,
        lastSyncAttemptAt: syncState?.lastSyncAttemptAt ?? null,
        lastSyncedAt: syncState?.lastSyncedAt ?? null,
      });
    } catch (error) {
      req.log.error(error, "Error creating lead");
      return res.status(500).send({ error: "Internal server error" });
    }
  });

  app.post<{ Body: Omit<LeadBody, "workspace"> }>(
    "/dfwsc/leads",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      try {
        const body: LeadBody = { ...req.body, workspace: "dfwsc_services" };
        const { name, email } = body;

        if (!name || !email) {
          return res.status(400).send({ error: "name and email are required." });
        }
        if (!validator.isEmail(email)) {
          return res.status(400).send({ error: "Invalid email format." });
        }

        const leadResult = await createLead("dfwsc_services", body);
        if (leadResult.error) {
          return res.status(leadResult.error.code).send({ error: leadResult.error.message });
        }

        if (!leadResult.lead) {
          return res.status(500).send({ error: "Failed to create lead." });
        }
        const lead = leadResult.lead;
        await syncClientProfileToNextcloud(lead.id).catch((syncErr) => {
          req.log.warn(syncErr, "Client profile sync failed after DFWSC lead create.");
        });
        const syncStateMap = await getSyncStateMap([lead.id]);
        const syncState = syncStateMap.get(lead.id);
        return res.status(201).send({
          id: lead.id,
          workspace: lead.workspace,
          name: lead.name,
          email: lead.email,
          phone: lead.phone,
          notes: lead.notes,
          lastContactAt: lead.lastContactAt?.toISOString() ?? null,
          nextAction: lead.nextAction,
          followUpAt: lead.followUpAt?.toISOString() ?? null,
          status: lead.status,
          createdAt: lead.createdAt?.toISOString(),
          syncStatus: syncState?.syncStatus ?? "synced",
          syncError: syncState?.syncError ?? null,
          syncAttempts: syncState?.syncAttempts ?? 0,
          lastSyncAttemptAt: syncState?.lastSyncAttemptAt ?? null,
          lastSyncedAt: syncState?.lastSyncedAt ?? null,
        });
      } catch (error) {
        req.log.error(error, "Error creating DFWSC lead");
        return res.status(500).send({ error: "Internal server error" });
      }
    }
  );

  app.post<{ Params: ConvertParams; Body: { workspace?: Workspace } }>(
    "/crm/leads/:id/convert",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      try {
        const { id } = req.params;
        const { workspace } = req.body ?? {};

        if (!workspace || !isCrmWorkspace(workspace)) {
          return res
            .status(400)
            .send({ error: "workspace is required (dfwsc_services|ledger_crm)." });
        }

        const convertResult = await convertLead(workspace, id);
        if (convertResult.error) {
          return res.status(convertResult.error.code).send({ error: convertResult.error.message });
        }

        if (!convertResult.updated) {
          return res.status(500).send({ error: "Failed to convert lead." });
        }
        const updated = convertResult.updated;
        await syncClientProfileToNextcloud(updated.id).catch((syncErr) => {
          req.log.warn(syncErr, "Client profile sync failed after lead conversion.");
        });
        const syncStateMap = await getSyncStateMap([updated.id]);
        const syncState = syncStateMap.get(updated.id);
        const { apiKeyHash, apiKeyLookup, ...safe } = updated;
        return res.status(200).send({
          ...safe,
          createdAt: updated.createdAt?.toISOString(),
          updatedAt: updated.updatedAt?.toISOString(),
          lastContactAt: updated.lastContactAt?.toISOString() ?? null,
          followUpAt: updated.followUpAt?.toISOString() ?? null,
          suspendedAt: null,
          paymentStatusSyncedAt: null,
          syncStatus: syncState?.syncStatus ?? "synced",
          syncError: syncState?.syncError ?? null,
          syncAttempts: syncState?.syncAttempts ?? 0,
          lastSyncAttemptAt: syncState?.lastSyncAttemptAt ?? null,
          lastSyncedAt: syncState?.lastSyncedAt ?? null,
        });
      } catch (error) {
        req.log.error(error, "Error converting lead to client");
        return res.status(500).send({ error: "Internal server error" });
      }
    }
  );

  app.post<{ Params: ConvertParams }>(
    "/dfwsc/leads/:id/convert",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      try {
        const convertResult = await convertLead("dfwsc_services", req.params.id);
        if (convertResult.error) {
          return res.status(convertResult.error.code).send({ error: convertResult.error.message });
        }

        if (!convertResult.updated) {
          return res.status(500).send({ error: "Failed to convert lead." });
        }
        const updated = convertResult.updated;
        await syncClientProfileToNextcloud(updated.id).catch((syncErr) => {
          req.log.warn(syncErr, "Client profile sync failed after DFWSC lead conversion.");
        });
        const syncStateMap = await getSyncStateMap([updated.id]);
        const syncState = syncStateMap.get(updated.id);
        const { apiKeyHash, apiKeyLookup, ...safe } = updated;
        return res.status(200).send({
          ...safe,
          createdAt: updated.createdAt?.toISOString(),
          updatedAt: updated.updatedAt?.toISOString(),
          lastContactAt: updated.lastContactAt?.toISOString() ?? null,
          followUpAt: updated.followUpAt?.toISOString() ?? null,
          suspendedAt: null,
          paymentStatusSyncedAt: null,
          syncStatus: syncState?.syncStatus ?? "synced",
          syncError: syncState?.syncError ?? null,
          syncAttempts: syncState?.syncAttempts ?? 0,
          lastSyncAttemptAt: syncState?.lastSyncAttemptAt ?? null,
          lastSyncedAt: syncState?.lastSyncedAt ?? null,
        });
      } catch (error) {
        req.log.error(error, "Error converting DFWSC lead to client");
        return res.status(500).send({ error: "Internal server error" });
      }
    }
  );
};

export default dfwscClientRoutes;
