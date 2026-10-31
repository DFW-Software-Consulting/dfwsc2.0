import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { errors } from "../../lib/errors";
import { type ActorContext, diffFields, writeAudit } from "../context";
import { type MILESTONE_STATUSES, milestones, projects } from "../schema";

type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export type MilestoneInput = {
  title: string;
  description?: string | null;
  status?: MilestoneStatus;
  dueOn?: string | null;
  clientVisible?: boolean;
  stripeInvoiceId?: string | null;
  sortOrder?: number;
};

// completed_at follows status: set when a milestone becomes done, cleared when
// it leaves done, untouched otherwise.
function completedAtFor(next: MilestoneStatus | undefined, previous: MilestoneStatus | null) {
  if (next === undefined || next === previous) return undefined;
  return next === "done" ? new Date() : null;
}

export async function createMilestone(
  actor: ActorContext,
  projectId: string,
  input: MilestoneInput
) {
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select({ clientId: projects.clientId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) throw errors.notFound("Project");
    const completedAt = completedAtFor(input.status, null);
    const [milestone] = await tx
      .insert(milestones)
      .values({
        id: randomUUID(),
        clientId: project.clientId,
        projectId,
        ...input,
        ...(completedAt !== undefined ? { completedAt } : {}),
      })
      .returning();
    await writeAudit(tx, actor, {
      clientId: project.clientId,
      action: "create",
      entityType: "milestone",
      entityId: milestone.id,
      changes: { projectId, ...input },
    });
    return milestone;
  });
}

export async function updateMilestone(
  actor: ActorContext,
  id: string,
  patch: Partial<MilestoneInput>
) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(milestones)
      .where(eq(milestones.id, id))
      .for("update")
      .limit(1);
    if (!current) throw errors.notFound("Milestone");
    const completedAt = completedAtFor(patch.status, current.status);
    const update = { ...patch, ...(completedAt !== undefined ? { completedAt } : {}) };
    const changes = diffFields(current, update);
    if (Object.keys(changes).length === 0) return current;
    const [milestone] = await tx
      .update(milestones)
      .set(update)
      .where(eq(milestones.id, id))
      .returning();
    await writeAudit(tx, actor, {
      clientId: current.clientId,
      action: "update",
      entityType: "milestone",
      entityId: id,
      changes,
    });
    return milestone;
  });
}
