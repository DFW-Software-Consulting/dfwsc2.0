import { and, eq, ne } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/client";
import { clientGroups, clients } from "../db/schema";
import { requireAdminJwt } from "../lib/auth";
import { stripe } from "../lib/stripe";
import { CRM_WORKSPACES, isWorkspace } from "../lib/workspace";

interface ClientPatchBody {
  status?: "active" | "inactive";
  groupId?: string | null;
  paymentSuccessUrl?: string | null;
  paymentCancelUrl?: string | null;
  processingFeePercent?: number | null;
  processingFeeCents?: number | null;
  name?: string;
  email?: string;
  phone?: string | null;
  billingContactName?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  notes?: string | null;
  lastContactAt?: string | null;
  nextAction?: string | null;
  followUpAt?: string | null;
  defaultPaymentTermsDays?: number | null;
}

interface ClientParams {
  id: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

const clientRoutes: FastifyPluginAsync = async (app) => {
  // GET /clients - List all clients (admin only)
  app.get("/clients", { preHandler: requireAdminJwt }, async (req, res) => {
    try {
      const { groupId, workspace } = req.query as { groupId?: string; workspace?: string };

      if (!isWorkspace(workspace)) {
        return res.status(400).send({
          error: "workspace query parameter is required (dfwsc_services|client_portal|ledger_crm).",
        });
      }

      const query = db
        .select({
          id: clients.id,
          name: clients.name,
          email: clients.email,
          stripeAccountId: clients.stripeAccountId,
          stripeCustomerId: clients.stripeCustomerId,
          status: clients.status,
          workspace: clients.workspace,
          groupId: clients.groupId,
          processingFeePercent: clients.processingFeePercent,
          processingFeeCents: clients.processingFeeCents,
          paymentStatus: clients.paymentStatus,
          paymentStatusSyncedAt: clients.paymentStatusSyncedAt,
          lastContactAt: clients.lastContactAt,
          nextAction: clients.nextAction,
          followUpAt: clients.followUpAt,
          suspendedAt: clients.suspendedAt,
          suspensionReason: clients.suspensionReason,
          createdAt: clients.createdAt,
        })
        .from(clients);

      if (groupId) {
        const [group] = await db
          .select({ id: clientGroups.id, workspace: clientGroups.workspace })
          .from(clientGroups)
          .where(eq(clientGroups.id, groupId))
          .limit(1);
        if (!group || group.workspace !== workspace) {
          return res
            .status(400)
            .send({ error: "groupId does not belong to the selected workspace." });
        }
      }

      const clientList = groupId
        ? await query.where(and(eq(clients.groupId, groupId), eq(clients.workspace, workspace)))
        : await query.where(eq(clients.workspace, workspace));

      const scopedList = clientList.filter((client) => client.workspace === workspace);

      return res.status(200).send(
        scopedList.map((client) => ({
          ...client,
          createdAt: client.createdAt?.toISOString(),
          paymentStatusSyncedAt: client.paymentStatusSyncedAt?.toISOString() ?? null,
          lastContactAt: client.lastContactAt?.toISOString() ?? null,
          followUpAt: client.followUpAt?.toISOString() ?? null,
          suspendedAt: client.suspendedAt?.toISOString() ?? null,
        }))
      );
    } catch (error) {
      req.log.error(error, "Error fetching client list");
      return res.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /clients/:id - Get a single client (admin only)
  app.get<{ Params: ClientParams; Querystring: { workspace?: string } }>(
    "/clients/:id",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      try {
        const { id } = req.params;
        const { workspace } = req.query;

        if (!isWorkspace(workspace)) {
          return res.status(400).send({
            error:
              "workspace query parameter is required (dfwsc_services|client_portal|ledger_crm).",
          });
        }

        const [client] = await db
          .select()
          .from(clients)
          .where(and(eq(clients.id, id), eq(clients.workspace, workspace)))
          .limit(1);

        if (!client) {
          return res.status(404).send({ error: "Client not found." });
        }

        const { apiKeyHash, apiKeyLookup, ...safeClient } = client;
        return res.status(200).send({
          client: {
            ...safeClient,
            createdAt: client.createdAt?.toISOString(),
            updatedAt: client.updatedAt?.toISOString(),
            lastContactAt: client.lastContactAt?.toISOString() ?? null,
            followUpAt: client.followUpAt?.toISOString() ?? null,
          },
        });
      } catch (error) {
        req.log.error(error, "Error fetching client");
        return res.status(500).send({ error: "Internal server error" });
      }
    }
  );

  // PATCH /clients/:id - Update client (admin only)
  app.patch<{
    Params: ClientParams;
    Body: ClientPatchBody;
  }>("/clients/:id", { preHandler: requireAdminJwt }, async (req, res) => {
    try {
      const { id } = req.params;
      const body = req.body;
      const {
        status,
        groupId,
        paymentSuccessUrl,
        paymentCancelUrl,
        processingFeePercent,
        processingFeeCents,
        name,
        email,
        lastContactAt,
        nextAction,
        followUpAt,
        defaultPaymentTermsDays,
      } = body;

      if (lastContactAt != null && Number.isNaN(new Date(lastContactAt).getTime())) {
        return res.status(400).send({ error: "lastContactAt must be a valid ISO datetime." });
      }

      if (followUpAt != null && Number.isNaN(new Date(followUpAt).getTime())) {
        return res.status(400).send({ error: "followUpAt must be a valid ISO datetime." });
      }

      if (status !== undefined && status !== "active" && status !== "inactive") {
        return res.status(400).send({
          error: 'Invalid status value. Must be "active" or "inactive".',
        });
      }

      if (paymentSuccessUrl != null && !isValidHttpsUrl(paymentSuccessUrl)) {
        return res.status(400).send({ error: "paymentSuccessUrl must be a valid HTTPS URL." });
      }

      if (paymentCancelUrl != null && !isValidHttpsUrl(paymentCancelUrl)) {
        return res.status(400).send({ error: "paymentCancelUrl must be a valid HTTPS URL." });
      }

      if (processingFeePercent != null && processingFeeCents != null) {
        return res.status(400).send({ error: "Set one fee type, not both." });
      }

      if (
        processingFeePercent != null &&
        (processingFeePercent <= 0 || processingFeePercent > 100)
      ) {
        return res
          .status(400)
          .send({ error: "processingFeePercent must be greater than 0 and at most 100." });
      }

      if (
        processingFeeCents != null &&
        (!Number.isInteger(processingFeeCents) || processingFeeCents < 0)
      ) {
        return res
          .status(400)
          .send({ error: "processingFeeCents must be a non-negative integer." });
      }

      if (name !== undefined && (!name || !name.trim())) {
        return res.status(400).send({ error: "name must not be empty." });
      }

      if (email !== undefined && !EMAIL_RE.test(email)) {
        return res.status(400).send({ error: "email must be a valid email address." });
      }

      if (
        defaultPaymentTermsDays !== undefined &&
        defaultPaymentTermsDays !== null &&
        (!Number.isInteger(defaultPaymentTermsDays) || defaultPaymentTermsDays <= 0)
      ) {
        return res
          .status(400)
          .send({ error: "defaultPaymentTermsDays must be a positive integer." });
      }

      if (groupId != null) {
        const [existingClient] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);

        if (!existingClient) {
          return res.status(404).send({ error: "Client not found." });
        }

        const [group] = await db
          .select({ id: clientGroups.id, workspace: clientGroups.workspace })
          .from(clientGroups)
          .where(eq(clientGroups.id, groupId))
          .limit(1);
        if (!group) {
          return res.status(400).send({ error: "Group not found." });
        }
        if (group.workspace !== existingClient.workspace) {
          return res
            .status(400)
            .send({ error: "groupId workspace does not match client workspace." });
        }
      }

      const [existingClient] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);

      if (!existingClient) {
        return res.status(404).send({ error: "Client not found." });
      }

      if (email !== undefined) {
        const [conflict] = await db
          .select({ id: clients.id })
          .from(clients)
          .where(
            and(
              eq(clients.email, email),
              eq(clients.workspace, existingClient.workspace),
              ne(clients.id, id)
            )
          )
          .limit(1);
        if (conflict) {
          return res
            .status(409)
            .send({ error: "A client with this email already exists in this workspace." });
        }
      }

      const setValues: {
        updatedAt: Date;
        status?: "active" | "inactive";
        groupId?: string | null;
        paymentSuccessUrl?: string | null;
        paymentCancelUrl?: string | null;
        processingFeePercent?: string | null;
        processingFeeCents?: number | null;
        name?: string;
        email?: string;
        phone?: string | null;
        billingContactName?: string | null;
        addressLine1?: string | null;
        addressLine2?: string | null;
        city?: string | null;
        state?: string | null;
        postalCode?: string | null;
        country?: string | null;
        notes?: string | null;
        lastContactAt?: Date | null;
        nextAction?: string | null;
        followUpAt?: Date | null;
        defaultPaymentTermsDays?: number | null;
      } = { updatedAt: new Date() };

      if (status !== undefined) setValues.status = status;
      if ("groupId" in body) setValues.groupId = groupId;
      if ("paymentSuccessUrl" in body) setValues.paymentSuccessUrl = paymentSuccessUrl;
      if ("paymentCancelUrl" in body) setValues.paymentCancelUrl = paymentCancelUrl;
      if ("processingFeePercent" in body)
        setValues.processingFeePercent =
          processingFeePercent != null ? String(processingFeePercent) : null;
      if ("processingFeeCents" in body) setValues.processingFeeCents = processingFeeCents;
      if (name !== undefined) setValues.name = name;
      if (email !== undefined) setValues.email = email;
      if ("phone" in body) setValues.phone = body.phone;
      if ("billingContactName" in body) setValues.billingContactName = body.billingContactName;
      if ("addressLine1" in body) setValues.addressLine1 = body.addressLine1;
      if ("addressLine2" in body) setValues.addressLine2 = body.addressLine2;
      if ("city" in body) setValues.city = body.city;
      if ("state" in body) setValues.state = body.state;
      if ("postalCode" in body) setValues.postalCode = body.postalCode;
      if ("country" in body) setValues.country = body.country;
      if ("notes" in body) setValues.notes = body.notes;
      if ("lastContactAt" in body)
        setValues.lastContactAt = lastContactAt != null ? new Date(lastContactAt) : null;
      if ("nextAction" in body) setValues.nextAction = nextAction;
      if ("followUpAt" in body)
        setValues.followUpAt = followUpAt != null ? new Date(followUpAt) : null;
      if ("defaultPaymentTermsDays" in body)
        setValues.defaultPaymentTermsDays = defaultPaymentTermsDays;

      const updatedClients = await db
        .update(clients)
        .set(setValues)
        .where(eq(clients.id, id))
        .returning();

      if (updatedClients.length === 0) {
        return res.status(500).send({ error: "Failed to update client." });
      }

      const updatedClient = updatedClients[0];

      // Auto-sync profile changes to Stripe for dfwsc_services clients
      if (updatedClient.workspace === "dfwsc_services" && updatedClient.stripeCustomerId) {
        const stripeNative: Record<string, unknown> = {};
        const stripeAddress: Record<string, unknown> = {};
        const stripeMeta: Record<string, string> = {};

        if ("name" in body && body.name) stripeNative.name = body.name;
        if ("email" in body && body.email) stripeNative.email = body.email;
        if ("phone" in body) stripeNative.phone = body.phone ?? "";
        if ("addressLine1" in body) stripeAddress.line1 = body.addressLine1 ?? "";
        if ("addressLine2" in body) stripeAddress.line2 = body.addressLine2 ?? "";
        if ("city" in body) stripeAddress.city = body.city ?? "";
        if ("state" in body) stripeAddress.state = body.state ?? "";
        if ("postalCode" in body) stripeAddress.postal_code = body.postalCode ?? "";
        if ("country" in body) stripeAddress.country = body.country ?? "";
        if ("billingContactName" in body)
          stripeMeta.billingContactName = body.billingContactName ?? "";
        if ("notes" in body) stripeMeta.notes = body.notes ?? "";
        if ("defaultPaymentTermsDays" in body)
          stripeMeta.defaultPaymentTermsDays =
            body.defaultPaymentTermsDays != null ? String(body.defaultPaymentTermsDays) : "";

        const stripePayload: Record<string, unknown> = { ...stripeNative };
        if (Object.keys(stripeAddress).length) stripePayload.address = stripeAddress;
        if (Object.keys(stripeMeta).length) stripePayload.metadata = stripeMeta;
        if (Object.keys(stripePayload).length) {
          await stripe.customers.update(updatedClient.stripeCustomerId, stripePayload);
        }
      }

      const { apiKeyHash, apiKeyLookup, ...safeUpdatedClient } = updatedClient;
      return res.status(200).send({
        ...safeUpdatedClient,
        createdAt: updatedClient.createdAt?.toISOString(),
        updatedAt: updatedClient.updatedAt?.toISOString(),
        lastContactAt: updatedClient.lastContactAt?.toISOString() ?? null,
        followUpAt: updatedClient.followUpAt?.toISOString() ?? null,
      });
    } catch (error) {
      req.log.error(error, "Error updating client");
      return res.status(500).send({ error: "Internal server error" });
    }
  });
  // POST /clients/sync-payment-status — manual trigger for the background sync job
  // Must be registered BEFORE /clients/:id to avoid Fastify treating "sync-payment-status" as an :id param
  app.post("/clients/sync-payment-status", { preHandler: requireAdminJwt }, async (req, res) => {
    try {
      const { runPaymentSync } = await import("../lib/payment-sync");
      const synced = await runPaymentSync();
      return res.status(200).send({ synced });
    } catch (err) {
      req.log.error(err, "Manual payment sync failed");
      return res.status(500).send({ error: "Payment sync failed." });
    }
  });

  // POST /clients/:id/suspend
  app.post<{ Params: ClientParams; Body: { reason?: string } }>(
    "/clients/:id/suspend",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      try {
        const { id } = req.params;
        const reason = req.body?.reason?.trim() || null;

        const [client] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
        if (!client) return res.status(404).send({ error: "Client not found." });
        if (!CRM_WORKSPACES.includes(client.workspace as (typeof CRM_WORKSPACES)[number])) {
          return res.status(400).send({
            error: "Suspend is only available for crm workspaces (dfwsc_services|ledger_crm).",
          });
        }

        const [updated] = await db
          .update(clients)
          .set({
            status: "inactive",
            suspendedAt: new Date(),
            suspensionReason: reason,
            updatedAt: new Date(),
          })
          .where(eq(clients.id, id))
          .returning();

        const { apiKeyHash, apiKeyLookup, ...safe } = updated;
        return res.status(200).send({
          ...safe,
          createdAt: updated.createdAt?.toISOString(),
          updatedAt: updated.updatedAt?.toISOString(),
          suspendedAt: updated.suspendedAt?.toISOString() ?? null,
          paymentStatusSyncedAt: updated.paymentStatusSyncedAt?.toISOString() ?? null,
        });
      } catch (error) {
        req.log.error(error, "Error suspending client");
        return res.status(500).send({ error: "Internal server error" });
      }
    }
  );

  // POST /clients/:id/reinstate
  app.post<{ Params: ClientParams }>(
    "/clients/:id/reinstate",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      try {
        const { id } = req.params;

        const [client] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
        if (!client) return res.status(404).send({ error: "Client not found." });
        if (!CRM_WORKSPACES.includes(client.workspace as (typeof CRM_WORKSPACES)[number])) {
          return res.status(400).send({
            error: "Reinstate is only available for crm workspaces (dfwsc_services|ledger_crm).",
          });
        }

        const [updated] = await db
          .update(clients)
          .set({
            status: "active",
            suspendedAt: null,
            suspensionReason: null,
            updatedAt: new Date(),
          })
          .where(eq(clients.id, id))
          .returning();

        const { apiKeyHash, apiKeyLookup, ...safe } = updated;
        return res.status(200).send({
          ...safe,
          createdAt: updated.createdAt?.toISOString(),
          updatedAt: updated.updatedAt?.toISOString(),
          suspendedAt: null,
          paymentStatusSyncedAt: updated.paymentStatusSyncedAt?.toISOString() ?? null,
        });
      } catch (error) {
        req.log.error(error, "Error reinstating client");
        return res.status(500).send({ error: "Internal server error" });
      }
    }
  );
};

export default clientRoutes;
