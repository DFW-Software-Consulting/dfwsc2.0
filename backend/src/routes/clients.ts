import { and, count, eq, ne } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../db/client";
import { clientGroups, clients } from "../db/schema";
import { requireAdminJwt } from "../lib/auth";
import { MAX_FEE_PERCENT, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from "../lib/constants";
import { errors, isUniqueViolation } from "../lib/errors";
import { adminRateLimit } from "../lib/rate-limit";
import { isValidHttpsUrl, parseBody } from "../lib/validation";
import { isWorkspace } from "../lib/workspace";

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
  defaultPaymentTermsDays?: number | null;
}

interface ClientParams {
  id: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const adminCrudRateLimit = adminRateLimit({
  max: RATE_LIMIT_MAX,
  windowMs: RATE_LIMIT_WINDOW_MS,
});

const nullableString = z.string().nullable();
const clientPatchBodySchema = z
  .object({
    status: z
      .enum(["active", "inactive"], {
        error: 'Invalid status value. Must be "active" or "inactive".',
      })
      .optional(),
    groupId: nullableString.optional(),
    paymentSuccessUrl: nullableString.optional(),
    paymentCancelUrl: nullableString.optional(),
    processingFeePercent: z.number().nullable().optional(),
    processingFeeCents: z.number().nullable().optional(),
    name: z.string().optional(),
    email: z.string().optional(),
    phone: nullableString.optional(),
    billingContactName: nullableString.optional(),
    addressLine1: nullableString.optional(),
    addressLine2: nullableString.optional(),
    city: nullableString.optional(),
    state: nullableString.optional(),
    postalCode: nullableString.optional(),
    country: nullableString.optional(),
    notes: nullableString.optional(),
    defaultPaymentTermsDays: z.number().nullable().optional(),
  })
  .superRefine((body, ctx) => {
    if (body.paymentSuccessUrl != null && !isValidHttpsUrl(body.paymentSuccessUrl)) {
      ctx.addIssue({
        code: "custom",
        message: "paymentSuccessUrl must be a valid HTTPS URL.",
        path: ["paymentSuccessUrl"],
      });
    }
    if (body.paymentCancelUrl != null && !isValidHttpsUrl(body.paymentCancelUrl)) {
      ctx.addIssue({
        code: "custom",
        message: "paymentCancelUrl must be a valid HTTPS URL.",
        path: ["paymentCancelUrl"],
      });
    }
    if (body.processingFeePercent != null && body.processingFeeCents != null) {
      ctx.addIssue({
        code: "custom",
        message: "Set one fee type, not both.",
        path: ["processingFeePercent"],
      });
    }
    if (
      body.processingFeePercent != null &&
      (body.processingFeePercent <= 0 || body.processingFeePercent > 100)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "processingFeePercent must be greater than 0 and at most 100.",
        path: ["processingFeePercent"],
      });
    }
    if (
      body.processingFeeCents != null &&
      (!Number.isInteger(body.processingFeeCents) || body.processingFeeCents < 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "processingFeeCents must be a non-negative integer.",
        path: ["processingFeeCents"],
      });
    }
    if (body.name !== undefined && (!body.name || !body.name.trim())) {
      ctx.addIssue({ code: "custom", message: "name must not be empty.", path: ["name"] });
    }
    if (body.email !== undefined && !EMAIL_RE.test(body.email)) {
      ctx.addIssue({
        code: "custom",
        message: "email must be a valid email address.",
        path: ["email"],
      });
    }
    if (
      body.defaultPaymentTermsDays !== undefined &&
      body.defaultPaymentTermsDays !== null &&
      (!Number.isInteger(body.defaultPaymentTermsDays) || body.defaultPaymentTermsDays <= 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "defaultPaymentTermsDays must be a positive integer.",
        path: ["defaultPaymentTermsDays"],
      });
    }
  });

function parsePagination(query: { limit?: string; offset?: string }) {
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return null;
  if (!Number.isInteger(offset) || offset < 0) return null;
  return { limit, offset };
}

const clientRoutes: FastifyPluginAsync = async (app) => {
  // GET /clients - List all clients (admin only)
  app.get("/clients", { preHandler: [requireAdminJwt, adminCrudRateLimit] }, async (req, res) => {
    try {
      const { groupId, workspace, limit, offset } = req.query as {
        groupId?: string;
        workspace?: string;
        limit?: string;
        offset?: string;
      };

      if (!isWorkspace(workspace)) {
        return res.status(400).send({
          error: "workspace query parameter is required (client_portal).",
        });
      }

      const pagination = parsePagination({ limit, offset });
      if (!pagination) {
        return res.status(400).send({
          error:
            "limit must be an integer between 1 and 100 and offset must be a non-negative integer.",
        });
      }

      const query = db
        .select({
          id: clients.id,
          name: clients.name,
          email: clients.email,
          stripeAccountId: clients.stripeAccountId,
          status: clients.status,
          workspace: clients.workspace,
          groupId: clients.groupId,
          processingFeePercent: clients.processingFeePercent,
          processingFeeCents: clients.processingFeeCents,
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

      const where = groupId
        ? and(
            eq(clients.groupId, groupId),
            eq(clients.workspace, workspace),
            ne(clients.status, "archived")
          )
        : and(eq(clients.workspace, workspace), ne(clients.status, "archived"));
      const [{ total }] = await db.select({ total: count() }).from(clients).where(where);
      const clientList = await query.where(where).limit(pagination.limit).offset(pagination.offset);

      return res.status(200).send({
        data: clientList.map((client) => ({
          ...client,
          createdAt: client.createdAt?.toISOString(),
        })),
        total,
        ...pagination,
      });
    } catch (error) {
      req.log.error(error, "Error fetching client list");
      return res.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /clients/:id - Get a single client (admin only)
  app.get<{ Params: ClientParams; Querystring: { workspace?: string } }>(
    "/clients/:id",
    { preHandler: [requireAdminJwt, adminCrudRateLimit] },
    async (req, res) => {
      const { id } = req.params;
      const { workspace } = req.query;

      if (!isWorkspace(workspace)) {
        throw errors.badRequest("workspace query parameter is required (client_portal).");
      }

      const [client] = await db
        .select()
        .from(clients)
        .where(and(eq(clients.id, id), eq(clients.workspace, workspace)))
        .limit(1);

      if (!client) {
        throw errors.notFound("Client");
      }

      const { apiKeyHash, apiKeyLookup, ...safeClient } = client;
      return res.status(200).send({
        client: {
          ...safeClient,
          createdAt: client.createdAt?.toISOString(),
          updatedAt: client.updatedAt?.toISOString(),
        },
      });
    }
  );

  // PATCH /clients/:id - Update client (admin only)
  app.patch<{
    Params: ClientParams;
    Body: ClientPatchBody;
  }>("/clients/:id", { preHandler: [requireAdminJwt, adminCrudRateLimit] }, async (req, res) => {
    try {
      const { id } = req.params;
      const body = parseBody(clientPatchBodySchema, req.body, res) as ClientPatchBody | null;
      if (!body) return;
      const {
        status,
        groupId,
        paymentSuccessUrl,
        paymentCancelUrl,
        processingFeePercent,
        processingFeeCents,
        name,
        email,
        defaultPaymentTermsDays,
      } = body;


      const [existingClient] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);

      if (!existingClient) {
        return res.status(404).send({ error: "Client not found." });
      }

      if (groupId != null) {
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
        defaultPaymentTermsDays?: number | null;
      } = { updatedAt: new Date() };

      if (status !== undefined) setValues.status = status;
      if ("groupId" in body) setValues.groupId = groupId;
      if ("paymentSuccessUrl" in body) setValues.paymentSuccessUrl = paymentSuccessUrl;
      if ("paymentCancelUrl" in body) setValues.paymentCancelUrl = paymentCancelUrl;
      if ("processingFeePercent" in body) {
        setValues.processingFeePercent =
          processingFeePercent != null ? String(processingFeePercent) : null;
        // Setting a non-null percent fee clears the flat cents fee to keep them mutually exclusive.
        if (processingFeePercent != null) setValues.processingFeeCents = null;
      }
      if ("processingFeeCents" in body) {
        setValues.processingFeeCents = processingFeeCents;
        // Setting a non-null cents fee clears the percent fee to keep them mutually exclusive.
        if (processingFeeCents != null) setValues.processingFeePercent = null;
      }
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
      if ("defaultPaymentTermsDays" in body)
        setValues.defaultPaymentTermsDays = defaultPaymentTermsDays;

      let updatedClients: (typeof clients.$inferSelect)[];
      try {
        updatedClients = await db
          .update(clients)
          .set(setValues)
          .where(eq(clients.id, id))
          .returning();
      } catch (updateError) {
        if (isUniqueViolation(updateError)) {
          return res
            .status(409)
            .send({ error: "A client with this email already exists in this workspace." });
        }
        throw updateError;
      }

      if (updatedClients.length === 0) {
        return res.status(500).send({ error: "Failed to update client." });
      }

      const updatedClient = updatedClients[0];

      const { apiKeyHash, apiKeyLookup, ...safeUpdatedClient } = updatedClient;
      return res.status(200).send({
        ...safeUpdatedClient,
        createdAt: updatedClient.createdAt?.toISOString(),
        updatedAt: updatedClient.updatedAt?.toISOString(),
      });
    } catch (error) {
      req.log.error(error, "Error updating client");
      return res.status(500).send({ error: "Internal server error" });
    }
  });

  app.delete<{ Params: ClientParams }>(
    "/clients/:id",
    { preHandler: [requireAdminJwt, adminCrudRateLimit] },
    async (req, res) => {
      try {
        const { id } = req.params;
        const [updated] = await db
          .update(clients)
          .set({ status: "archived", updatedAt: new Date() })
          .where(eq(clients.id, id))
          .returning({ id: clients.id });
        if (!updated) {
          return res.status(404).send({ error: "Client not found." });
        }
        return res.status(204).send();
      } catch (error) {
        req.log.error(error, "Error deleting client");
        return res.status(500).send({ error: "Internal server error" });
      }
    }
  );
};

export default clientRoutes;
