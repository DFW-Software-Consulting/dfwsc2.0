import { and, eq, isNull, lt, or } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../db/client";
import { webhookEvents } from "../db/schema";

// The webhook_events lease shared by the Stripe webhook routes (Connect: routes/webhooks.ts,
// billing: routes/webhooks-billing.ts). Event ids are unique per Stripe account, and the two
// endpoints see different accounts, so one table dedupes both.

// How long a claim row can remain unprocessed before we consider the
// claiming process to have crashed and allow another delivery to reclaim it.
const STALE_CLAIM_MS = 15 * 60 * 1000;

export type ClaimResult = "claimed" | "processed" | "in_progress";

/**
 * Atomically claims this event via a reclaimable lease. A claim consists of a row for this
 * stripeEventId whose `claimedAt` is a fresh lease. Only the delivery that wins the claim may
 * process the event; concurrent duplicate deliveries either observe it already processed
 * (idempotent 200) or find a live lease and are told to retry later. A lease older than
 * STALE_CLAIM_MS is assumed abandoned by a crashed processor and may be reclaimed.
 */
export async function claimStripeEvent(event: { id: string; type: string }): Promise<ClaimResult> {
  const leaseCutoff = new Date(Date.now() - STALE_CLAIM_MS);

  // First try: insert a fresh row + lease. Wins the claim when no row exists.
  const [inserted] = await db
    .insert(webhookEvents)
    .values({
      id: uuidv4(),
      stripeEventId: event.id,
      type: event.type,
      claimedAt: new Date(),
    })
    .onConflictDoNothing({ target: webhookEvents.stripeEventId })
    .returning({ id: webhookEvents.id });
  if (inserted) return "claimed";

  // A row already exists. Decide: already done, reclaimable, or in-flight.
  const [existing] = await db
    .select({ processedAt: webhookEvents.processedAt })
    .from(webhookEvents)
    .where(eq(webhookEvents.stripeEventId, event.id))
    .limit(1);
  // Already fully processed: a true idempotent no-op.
  if (existing?.processedAt) return "processed";

  // Attempt to (re)claim the lease atomically. Succeeds only if the event is still unprocessed
  // AND the lease is absent or stale. If a live lease is held by another in-flight delivery, no
  // row is returned.
  const [reclaimed] = await db
    .update(webhookEvents)
    .set({ claimedAt: new Date() })
    .where(
      and(
        eq(webhookEvents.stripeEventId, event.id),
        isNull(webhookEvents.processedAt),
        or(isNull(webhookEvents.claimedAt), lt(webhookEvents.claimedAt, leaseCutoff))
      )
    )
    .returning({ id: webhookEvents.id });
  // Unprocessed event with a live lease held by another delivery: the caller answers non-2xx so
  // Stripe retries later rather than dropping the event.
  return reclaimed ? "claimed" : "in_progress";
}

/**
 * Releases the claim after a retryable failure so Stripe's retry can re-process. The row was
 * inserted before processing to dedup concurrent deliveries; if the route returned 500 without
 * deleting it, every retry would conflict on the unique index, short-circuit as "already
 * handled", and the event would stay claimed-but-unprocessed forever. Deleting restores
 * at-least-once delivery (handlers must remain idempotent).
 */
export async function releaseStripeEvent(eventId: string): Promise<void> {
  await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, eventId));
}

export async function markStripeEventProcessed(eventId: string): Promise<void> {
  await db
    .update(webhookEvents)
    .set({ processedAt: new Date() })
    .where(eq(webhookEvents.stripeEventId, eventId));
}
