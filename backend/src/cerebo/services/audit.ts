import { and, count, desc, eq, type SQL } from "drizzle-orm";
import { db } from "../../db/client";
import { auditEvents } from "../schema";
import type { Page } from "./shared";

export async function listAuditEvents(
  filter: { clientId?: string; entityType?: string; entityId?: string },
  page: Page
) {
  const conditions: SQL[] = [];
  if (filter.clientId) conditions.push(eq(auditEvents.clientId, filter.clientId));
  if (filter.entityType) conditions.push(eq(auditEvents.entityType, filter.entityType));
  if (filter.entityId) conditions.push(eq(auditEvents.entityId, filter.entityId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [{ total }] = await db.select({ total: count() }).from(auditEvents).where(where);
  const data = await db
    .select()
    .from(auditEvents)
    .where(where)
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(page.limit)
    .offset(page.offset);
  return { data, total };
}
