import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { clients } from "../../db/schema";
import { errors } from "../../lib/errors";
import { projects } from "../schema";

export interface Page {
  limit: number;
  offset: number;
}

export async function assertClientExists(tx: DbOrTx, clientId: string): Promise<void> {
  const [row] = await tx
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!row) throw errors.notFound("Client");
}

// Reference checks run inside the write transaction and are scoped to the
// client, so a project belonging to another client reads as "not found". The
// composite foreign keys are the backstop if a check is ever skipped.
export async function assertProjectForClient(
  tx: DbOrTx,
  clientId: string,
  projectId: string
): Promise<void> {
  const [row] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.clientId, clientId), eq(projects.id, projectId)))
    .limit(1);
  if (!row) throw errors.notFound("Project");
}
