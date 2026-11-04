import { asc, count, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../db/client";
import { clientGroups } from "../db/schema";
import {
  addFeeIssues,
  addUrlIssues,
  adminCrudPreHandler,
  feeSetValues,
  parsePagination,
} from "../lib/admin-crud";
import { MAX_FEE_PERCENT } from "../lib/constants";
import { errors } from "../lib/errors";
import { isValidHttpsUrl, parseBody } from "../lib/validation";
import { isWorkspace, type Workspace } from "../lib/workspace";

interface GroupBody {
  name: string;
  workspace: Workspace;
}

interface GroupPatchBody {
  name?: string;
  status?: "active" | "inactive";
  processingFeePercent?: number | null;
  processingFeeCents?: number | null;
  paymentSuccessUrl?: string | null;
  paymentCancelUrl?: string | null;
}

interface GroupParams {
  id: string;
}

function formatGroupResponse(g: typeof clientGroups.$inferSelect) {
  return {
    id: g.id,
    workspace: g.workspace,
    name: g.name,
    status: g.status,
    processingFeePercent: g.processingFeePercent,
    processingFeeCents: g.processingFeeCents,
    paymentSuccessUrl: g.paymentSuccessUrl,
    paymentCancelUrl: g.paymentCancelUrl,
    createdAt: g.createdAt?.toISOString(),
    updatedAt: g.updatedAt?.toISOString(),
  };
}

const groupBodySchema = z.object({
  name: z.string({ error: "name is required." }).trim().min(1, "name is required."),
  workspace: z.literal("client_portal", { error: "workspace is required (client_portal)." }),
});

const groupPatchBodySchema = z
  .object({
    name: z.string().optional(),
    status: z
      .enum(["active", "inactive"], {
        error: 'Invalid status value. Must be "active" or "inactive".',
      })
      .optional(),
    processingFeePercent: z.number().nullable().optional(),
    processingFeeCents: z.number().nullable().optional(),
    paymentSuccessUrl: z.string().nullable().optional(),
    paymentCancelUrl: z.string().nullable().optional(),
  })
  .superRefine((body, ctx) => {
    if (body.name !== undefined && body.name.trim().length === 0) {
      ctx.addIssue({ code: "custom", message: "name must be a non-empty string.", path: ["name"] });
    }
    addFeeIssues(body, ctx);
    addUrlIssues(body, ctx);
  });

const groupRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: GroupBody }>(
    "/groups",
    { preHandler: adminCrudPreHandler },
    async (req, res) => {
      const body = parseBody(groupBodySchema, req.body, res);
      if (!body) return;
      const { name, workspace: validatedWorkspace } = body;

      const id = nanoid();
      const now = new Date();
      const [group] = await db
        .insert(clientGroups)
        .values({
          id,
          workspace: validatedWorkspace,
          name: name.trim(),
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return res.status(201).send(formatGroupResponse(group));
    }
  );

  app.get("/groups", { preHandler: adminCrudPreHandler }, async (req, res) => {
    const { workspace, limit, offset } = req.query as {
      workspace?: string;
      limit?: string;
      offset?: string;
    };
    if (!isWorkspace(workspace)) {
      throw errors.badRequest("workspace query parameter is required (client_portal).");
    }
    const pagination = parsePagination({ limit, offset });
    if (!pagination) {
      return res.status(400).send({
        error:
          "limit must be an integer between 1 and 100 and offset must be a non-negative integer.",
      });
    }

    const [{ total }] = await db
      .select({ total: count() })
      .from(clientGroups)
      .where(eq(clientGroups.workspace, workspace));
    const groups = await db
      .select()
      .from(clientGroups)
      .where(eq(clientGroups.workspace, workspace))
      .orderBy(desc(clientGroups.createdAt), asc(clientGroups.id))
      .limit(pagination.limit)
      .offset(pagination.offset);
    return res.status(200).send({ data: groups.map(formatGroupResponse), total, ...pagination });
  });

  app.patch<{ Params: GroupParams; Body: GroupPatchBody }>(
    "/groups/:id",
    { preHandler: adminCrudPreHandler },
    async (req, res) => {
      const { id } = req.params;
      const body = parseBody(groupPatchBodySchema, req.body, res);
      if (!body) return;
      const {
        name,
        status,
        processingFeePercent,
        processingFeeCents,
        paymentSuccessUrl,
        paymentCancelUrl,
      } = body;

      if (status !== undefined && status !== "active" && status !== "inactive") {
        throw errors.badRequest('Invalid status value. Must be "active" or "inactive".');
      }
      if (name !== undefined && (typeof name !== "string" || name.trim().length === 0)) {
        throw errors.badRequest("name must be a non-empty string.");
      }

      if (processingFeePercent != null && processingFeeCents != null) {
        throw errors.badRequest("Set one fee type, not both.");
      }
      if (
        processingFeePercent != null &&
        (processingFeePercent <= 0 || processingFeePercent > MAX_FEE_PERCENT)
      ) {
        throw errors.badRequest(
          `processingFeePercent must be greater than 0 and at most ${MAX_FEE_PERCENT}.`
        );
      }
      if (
        processingFeeCents != null &&
        (!Number.isInteger(processingFeeCents) || processingFeeCents < 0)
      ) {
        throw errors.badRequest("processingFeeCents must be a non-negative integer.");
      }
      if (paymentSuccessUrl != null && !isValidHttpsUrl(paymentSuccessUrl)) {
        throw errors.badRequest("paymentSuccessUrl must be a valid HTTPS URL.");
      }
      if (paymentCancelUrl != null && !isValidHttpsUrl(paymentCancelUrl)) {
        throw errors.badRequest("paymentCancelUrl must be a valid HTTPS URL.");
      }

      const [existing] = await db
        .select()
        .from(clientGroups)
        .where(eq(clientGroups.id, id))
        .limit(1);
      if (!existing) {
        return res.status(404).send({ error: "Group not found." });
      }

      const setValues: {
        updatedAt: Date;
        name?: string;
        status?: "active" | "inactive";
        processingFeePercent?: string | null;
        processingFeeCents?: number | null;
        paymentSuccessUrl?: string | null;
        paymentCancelUrl?: string | null;
      } = { updatedAt: new Date() };

      if (name !== undefined) setValues.name = name.trim();
      if (status !== undefined) setValues.status = status;
      Object.assign(setValues, feeSetValues(body));
      if ("paymentSuccessUrl" in body) setValues.paymentSuccessUrl = paymentSuccessUrl;
      if ("paymentCancelUrl" in body) setValues.paymentCancelUrl = paymentCancelUrl;

      const [updated] = await db
        .update(clientGroups)
        .set(setValues)
        .where(eq(clientGroups.id, id))
        .returning();
      if (!updated) {
        throw errors.notFound("Group");
      }
      return res.status(200).send(formatGroupResponse(updated));
    }
  );

  app.delete<{ Params: GroupParams }>(
    "/groups/:id",
    { preHandler: adminCrudPreHandler },
    async (req, res) => {
      const { id } = req.params;
      const deleted = await db
        .delete(clientGroups)
        .where(eq(clientGroups.id, id))
        .returning({ id: clientGroups.id });
      if (deleted.length === 0) {
        return res.status(404).send({ error: "Group not found." });
      }
      return res.status(204).send();
    }
  );
};

export default groupRoutes;
