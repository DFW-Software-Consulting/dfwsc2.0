import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { errors, isUniqueViolation } from "../../lib/errors";
import { type ActorContext, writeAudit } from "../context";
import { type RESOURCE_KINDS, resourceLinks } from "../schema";
import { assertClientExists, assertProjectForClient } from "./shared";

export type LinkInput = {
  projectId?: string | null;
  kind: (typeof RESOURCE_KINDS)[number];
  externalId: string;
  url?: string | null;
  label?: string | null;
};

export async function createLink(actor: ActorContext, clientId: string, input: LinkInput) {
  try {
    return await db.transaction(async (tx) => {
      await assertClientExists(tx, clientId);
      if (input.projectId) await assertProjectForClient(tx, clientId, input.projectId);
      const [link] = await tx
        .insert(resourceLinks)
        .values({ id: randomUUID(), clientId, ...input })
        .returning();
      await writeAudit(tx, actor, {
        clientId,
        action: "create",
        entityType: "resource_link",
        entityId: link.id,
        changes: { ...input },
      });
      return link;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw errors.conflict("This client already has a link to that resource.");
    }
    throw err;
  }
}

export async function deleteLink(actor: ActorContext, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [link] = await tx.delete(resourceLinks).where(eq(resourceLinks.id, id)).returning();
    if (!link) throw errors.notFound("Resource link");
    await writeAudit(tx, actor, {
      clientId: link.clientId,
      action: "delete",
      entityType: "resource_link",
      entityId: id,
      changes: { kind: link.kind, externalId: link.externalId, projectId: link.projectId },
    });
  });
}

// Links that belong to the client itself rather than to one of its projects.
export async function listClientLinks(clientId: string) {
  await assertClientExists(db, clientId);
  return db
    .select()
    .from(resourceLinks)
    .where(and(eq(resourceLinks.clientId, clientId), isNull(resourceLinks.projectId)))
    .orderBy(asc(resourceLinks.kind), asc(resourceLinks.createdAt));
}
