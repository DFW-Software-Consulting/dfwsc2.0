import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { requireAdminJwt } from "../lib/auth";
import { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from "../lib/constants";
import { adminRateLimit } from "../lib/rate-limit";
import { isValidHttpsUrl, parseBody } from "../lib/validation";
import { getActor, requireAdminIdentity } from "./context";
import { getDeckBoardSummary, getNextcloudStatus } from "./nextcloud";
import { MILESTONE_STATUSES, PROJECT_STATUSES, RESOURCE_KINDS } from "./schema";
import { listAuditEvents } from "./services/audit";
import { createLink, deleteLink, listClientLinks } from "./services/links";
import { createMilestone, updateMilestone } from "./services/milestones";
import { createProject, getProjectDetail, listProjects, updateProject } from "./services/projects";

const cereboRateLimit = adminRateLimit({ max: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS });

const requiredText = (field: string, max = 200) =>
  z
    .string({ error: `${field} is required.` })
    .trim()
    .min(1, `${field} is required.`)
    .max(max, `${field} must be at most ${max} characters.`);
const optionalText = z.string().trim().max(10_000).nullable().optional();
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "dates must be YYYY-MM-DD.")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(date.getTime()) &&
      date.getUTCFullYear() === year &&
      date.getUTCMonth() + 1 === month &&
      date.getUTCDate() === day
    );
  }, "dates must be valid calendar dates.")
  .nullable()
  .optional();

const projectFields = {
  name: requiredText("name"),
  description: optionalText,
  status: z.enum(PROJECT_STATUSES).optional(),
  startsOn: isoDate,
  endsOn: isoDate,
};
const projectBody = z
  .object(projectFields)
  .refine((p) => !p.startsOn || !p.endsOn || p.endsOn >= p.startsOn, {
    message: "endsOn must be on or after startsOn.",
  });
const projectPatch = z.object(projectFields).partial();

const milestoneFields = {
  title: requiredText("title"),
  description: optionalText,
  status: z.enum(MILESTONE_STATUSES).optional(),
  dueOn: isoDate,
  clientVisible: z.boolean().optional(),
  stripeInvoiceId: z
    .string()
    .trim()
    .regex(/^in_[A-Za-z0-9]+$/, "stripeInvoiceId must be a Stripe invoice id (in_...).")
    .nullable()
    .optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
};
const milestoneBody = z.object(milestoneFields);
const milestonePatch = z.object(milestoneFields).partial();

const linkBody = z.object({
  projectId: z.string().trim().min(1).nullable().optional(),
  kind: z.enum(RESOURCE_KINDS, { error: `kind must be one of: ${RESOURCE_KINDS.join(", ")}.` }),
  externalId: requiredText("externalId", 1_000),
  url: z
    .string()
    .trim()
    .refine(isValidHttpsUrl, "url must be a valid HTTPS URL.")
    .nullable()
    .optional(),
  label: z.string().trim().max(200).nullable().optional(),
});

const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

function parseQuery<T extends z.ZodTypeAny>(schema: T, query: unknown, res: FastifyReply) {
  const parsed = schema.safeParse(query ?? {});
  if (!parsed.success) {
    res.status(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid query." });
    return null;
  }
  return parsed.data as z.infer<T>;
}

type ClientParams = { clientId: string };
type IdParams = { id: string };

const cereboRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", requireAdminJwt);
  app.addHook("preHandler", cereboRateLimit);
  app.addHook("preHandler", requireAdminIdentity);

  app.get("/nextcloud/status", async () => getNextcloudStatus());

  app.get<{ Params: ClientParams }>("/clients/:clientId/projects", async (req, res) => {
    const q = parseQuery(
      pageQuery.extend({ status: z.enum(PROJECT_STATUSES).optional() }),
      req.query,
      res
    );
    if (!q) return;
    const result = await listProjects(
      req.params.clientId,
      { status: q.status },
      { limit: q.limit, offset: q.offset }
    );
    return { ...result, limit: q.limit, offset: q.offset };
  });

  app.post<{ Params: ClientParams }>("/clients/:clientId/projects", async (req, res) => {
    const body = parseBody(projectBody, req.body, res);
    if (!body) return;
    const project = await createProject(getActor(req), req.params.clientId, body);
    return res.code(201).send(project);
  });

  app.get<{ Params: ClientParams }>("/clients/:clientId/links", async (req) => ({
    data: await listClientLinks(req.params.clientId),
  }));

  app.post<{ Params: ClientParams }>("/clients/:clientId/links", async (req, res) => {
    const body = parseBody(linkBody, req.body, res);
    if (!body) return;
    const link = await createLink(getActor(req), req.params.clientId, body);
    return res.code(201).send(link);
  });

  // Project detail with milestones, links and live Deck progress. Deck problems
  // show up per board in `deck`; they never fail the request.
  app.get<{ Params: IdParams }>("/projects/:id", async (req) => {
    const project = await getProjectDetail(req.params.id);
    const deck = await Promise.all(
      project.links
        .filter((link) => link.kind === "deck_board")
        .map(async (link) => ({ linkId: link.id, ...(await getDeckBoardSummary(link.externalId)) }))
    );
    return { ...project, deck };
  });

  app.patch<{ Params: IdParams }>("/projects/:id", async (req, res) => {
    const body = parseBody(projectPatch, req.body, res);
    if (!body) return;
    return updateProject(getActor(req), req.params.id, body);
  });

  app.post<{ Params: IdParams }>("/projects/:id/milestones", async (req, res) => {
    const body = parseBody(milestoneBody, req.body, res);
    if (!body) return;
    const milestone = await createMilestone(getActor(req), req.params.id, body);
    return res.code(201).send(milestone);
  });

  app.patch<{ Params: IdParams }>("/milestones/:id", async (req, res) => {
    const body = parseBody(milestonePatch, req.body, res);
    if (!body) return;
    return updateMilestone(getActor(req), req.params.id, body);
  });

  app.delete<{ Params: IdParams }>("/links/:id", async (req, res) => {
    await deleteLink(getActor(req), req.params.id);
    return res.code(204).send();
  });

  app.get("/audit", async (req, res) => {
    const q = parseQuery(
      pageQuery.extend({
        clientId: z.string().trim().min(1).optional(),
        entityType: z.string().trim().min(1).optional(),
        entityId: z.string().trim().min(1).optional(),
      }),
      req.query,
      res
    );
    if (!q) return;
    const result = await listAuditEvents(q, { limit: q.limit, offset: q.offset });
    return { ...result, limit: q.limit, offset: q.offset };
  });
};

export default cereboRoutes;
