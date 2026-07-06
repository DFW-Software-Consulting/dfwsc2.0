import { and, isNotNull, lt } from "drizzle-orm";
import { db } from "../db/client";
import { webhookEvents } from "../db/schema";
import { WEBHOOK_EVENT_RETENTION_MS } from "./constants";

/**
 * Delete processed webhook_events rows older than the retention window.
 *
 * Only rows with a non-null processedAt are ever touched — unprocessed
 * events are either in-flight or awaiting a Stripe retry, and the webhook
 * route's own claim/reclaim lease logic (see routes/webhooks.ts) owns their
 * lifecycle. Returns the number of rows deleted.
 */
export async function pruneProcessedWebhookEvents(): Promise<number> {
  const cutoff = new Date(Date.now() - WEBHOOK_EVENT_RETENTION_MS);
  const deleted = await db
    .delete(webhookEvents)
    .where(and(isNotNull(webhookEvents.processedAt), lt(webhookEvents.processedAt, cutoff)))
    .returning({ id: webhookEvents.id });
  return deleted.length;
}
