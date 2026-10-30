import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, type SQL } from "drizzle-orm";
import { db } from "../../db/client";
import { errors } from "../../lib/errors";
import { type ActorContext, diffFields, writeAudit } from "../context";
import { milestones, type PROJECT_STATUSES, projects, resourceLinks } from "../schema";
import { assertClientExists, type Page } from "./shared";

type Project = typeof projects.$inferSelect;

export type ProjectInput = {
  name: string;
  description?: string | null;
  status?: (typeof PROJECT_STATUSES)[number];
  startsOn?: string | null;
  endsOn?: string | null;
};

export async function createProject(actor: ActorContext, clientId: string, input: ProjectInput) {
  return db.transaction(async (tx) => {
    await assertClientExists(tx, clientId);
    const [project] = await tx
      .insert(projects)
      .values({ id: randomUUID(), clientId, ...input })
      .returning();
    await writeAudit(tx, actor, {
      clientId,
      action: "create",
      entityType: "project",
      entityId: project.id,
      changes: { ...input },
    });
    return project;
  });
}

// A project cannot move to another client: its milestones and Nextcloud links
// are scoped to the client it was created for.
export async function updateProject(actor: ActorContext, id: string, patch: Partial<ProjectInput>) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .for("update")
      .limit(1);
    if (!current) throw errors.notFound("Project");
    const startsOn = patch.startsOn !== undefined ? patch.startsOn : current.startsOn;
    const endsOn = patch.endsOn !== undefined ? patch.endsOn : current.endsOn;
    if (startsOn && endsOn && endsOn < startsOn) {
      throw errors.badRequest("endsOn must be on or after startsOn.");
    }
    const changes = diffFields(current, patch);
    if (Object.keys(changes).length === 0) return current;
    const [project] = await tx.update(projects).set(patch).where(eq(projects.id, id)).returning();
    await writeAudit(tx, actor, {
      clientId: current.clientId,
      action: "update",
      entityType: "project",
      entityId: id,
      changes,
    });
    return project;
  });
}

export async function getProject(id: string): Promise<Project> {
  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) throw errors.notFound("Project");
  return project;
}

// The project with its milestones and Nextcloud links, all read under the
// project's own client_id.
export async function getProjectDetail(id: string) {
  const project = await getProject(id);
  const [projectMilestones, links] = await Promise.all([
    db
      .select()
      .from(milestones)
      .where(and(eq(milestones.clientId, project.clientId), eq(milestones.projectId, id)))
      .orderBy(asc(milestones.sortOrder), asc(milestones.dueOn), asc(milestones.createdAt)),
    db
      .select()
      .from(resourceLinks)
      .where(and(eq(resourceLinks.clientId, project.clientId), eq(resourceLinks.projectId, id)))
      .orderBy(asc(resourceLinks.kind), asc(resourceLinks.createdAt)),
  ]);
  return { ...project, milestones: projectMilestones, links };
}

export async function listProjects(
  clientId: string,
  filter: { status?: Project["status"] },
  page: Page
) {
  await assertClientExists(db, clientId);
  const conditions: SQL[] = [eq(projects.clientId, clientId)];
  if (filter.status) conditions.push(eq(projects.status, filter.status));
  const where = and(...conditions);
  const [{ total }] = await db.select({ total: count() }).from(projects).where(where);
  const data = await db
    .select()
    .from(projects)
    .where(where)
    .orderBy(desc(projects.createdAt), asc(projects.id))
    .limit(page.limit)
    .offset(page.offset);
  return { data, total };
}
