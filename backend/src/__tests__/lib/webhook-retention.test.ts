import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../../db/client";
import { webhookEvents } from "../../db/schema";
import { pruneProcessedWebhookEvents } from "../../lib/webhook-retention";

// Scope every row this suite touches to a marker unique to this process run,
// so cleanup can never delete rows belonging to another concurrently-running
// agent/test run against the same shared DATABASE_URL.
const RUN_MARKER = `test-webhook-retention-${randomUUID()}`;

function markedEventId(label: string): string {
  return `${RUN_MARKER}-${label}`;
}

async function cleanupMarkedRows(): Promise<void> {
  await db.delete(webhookEvents).where(like(webhookEvents.stripeEventId, `${RUN_MARKER}%`));
}

async function remainingMarkedIds(): Promise<string[]> {
  const rows = await db
    .select({ stripeEventId: webhookEvents.stripeEventId })
    .from(webhookEvents)
    .where(like(webhookEvents.stripeEventId, `${RUN_MARKER}%`));
  return rows.map((row) => row.stripeEventId);
}

describe("pruneProcessedWebhookEvents", () => {
  afterEach(async () => {
    await cleanupMarkedRows();
  });

  it("deletes processed events older than retention but leaves recent and unprocessed events", async () => {
    const oldProcessedId = markedEventId("old-processed");
    const recentProcessedId = markedEventId("recent-processed");
    const oldUnprocessedId = markedEventId("old-unprocessed");

    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

    await db.insert(webhookEvents).values([
      {
        id: randomUUID(),
        stripeEventId: oldProcessedId,
        type: "test.marker.old_processed",
        processedAt: fortyDaysAgo,
        createdAt: fortyDaysAgo,
      },
      {
        id: randomUUID(),
        stripeEventId: recentProcessedId,
        type: "test.marker.recent_processed",
        processedAt: tenDaysAgo,
        createdAt: tenDaysAgo,
      },
      {
        // Unprocessed events must never be pruned regardless of age — they're
        // either in-flight or awaiting a Stripe retry, owned by the webhook
        // route's claim/reclaim lease logic.
        id: randomUUID(),
        stripeEventId: oldUnprocessedId,
        type: "test.marker.old_unprocessed",
        processedAt: null,
        createdAt: fortyDaysAgo,
      },
    ]);

    await pruneProcessedWebhookEvents();

    const remainingIds = await remainingMarkedIds();
    expect(remainingIds).not.toContain(oldProcessedId);
    expect(remainingIds).toContain(recentProcessedId);
    expect(remainingIds).toContain(oldUnprocessedId);
  });

  it("returns the count of rows it deleted", async () => {
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);

    await db.insert(webhookEvents).values([
      {
        id: randomUUID(),
        stripeEventId: markedEventId("count-a"),
        type: "test.marker.count",
        processedAt: fortyDaysAgo,
        createdAt: fortyDaysAgo,
      },
      {
        id: randomUUID(),
        stripeEventId: markedEventId("count-b"),
        type: "test.marker.count",
        processedAt: fortyDaysAgo,
        createdAt: fortyDaysAgo,
      },
    ]);

    // pruneProcessedWebhookEvents() sweeps the whole table, so other old
    // processed rows may legitimately exist in this shared dev DB — assert
    // only that our two marked rows are included in the count, not an exact
    // total.
    const deleted = await pruneProcessedWebhookEvents();
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(await remainingMarkedIds()).toEqual([]);
  });
});
