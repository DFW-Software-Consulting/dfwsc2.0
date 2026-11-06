import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { DbOrTx } from "../db/client";
import { auditEvents } from "./schema";

// Who is acting. Every Cerebo write takes one, so audit attribution cannot be
// skipped by a caller. REST builds it from the admin JWT; provisioning jobs use
// actorType "system".
export interface ActorContext {
  actorType: "admin" | "system";
  actorId: string | null;
  requestId?: string;
}

// requireAdminJwt sets request.admin to the verified token payload. The login signs
// `sub` as the Nextcloud user id, so that is the actor identity.
type CereboRequest = FastifyRequest & { admin?: { sub?: unknown } };

// Runs after requireAdminJwt. A token without `sub` carries no identity, and every
// Cerebo write must be attributable.
export async function requireAdminIdentity(request: FastifyRequest, reply: FastifyReply) {
  const id = (request as CereboRequest).admin?.sub;
  if (typeof id !== "string" || id.length === 0) {
    return reply.code(403).send({ error: "Cerebo requires an admin session with an identity." });
  }
}

export function getActor(request: FastifyRequest): ActorContext {
  const id = (request as CereboRequest).admin?.sub;
  // Only reachable if a route forgot the requireAdminIdentity preHandler.
  if (typeof id !== "string")
    throw new Error("Cerebo actor missing: requireAdminIdentity did not run");
  return { actorType: "admin", actorId: id, requestId: request.id };
}

export async function writeAudit(
  tx: DbOrTx,
  actor: ActorContext,
  entry: {
    clientId: string;
    action: "create" | "update" | "delete";
    entityType: string;
    entityId: string;
    changes: Record<string, unknown>;
  }
): Promise<void> {
  await tx.insert(auditEvents).values({
    id: randomUUID(),
    clientId: entry.clientId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    changes: entry.changes,
    requestId: actor.requestId ?? null,
  });
}

// Fields of `after` that differ from `before`, as { field: { from, to } }.
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const [key, to] of Object.entries(after)) {
    if (to === undefined) continue;
    const from = before[key];
    const same =
      from instanceof Date && to instanceof Date ? from.getTime() === to.getTime() : from === to;
    if (!same) changes[key] = { from: from ?? null, to: to ?? null };
  }
  return changes;
}
