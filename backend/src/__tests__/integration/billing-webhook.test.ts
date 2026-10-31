import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/stripe", async () => {
  const { fakeStripe } = await import("../helpers/fake-stripe-billing");
  return { stripe: fakeStripe.stripe };
});

import { buildServer } from "../../app";
import { db } from "../../db/client";
import { billingCustomers, billingSnapshots, webhookEvents } from "../../db/schema";
import { BILLING_WEBHOOK_EVENTS } from "../../routes/webhooks-billing";
import { ensureBaseEnv } from "../helpers/env";
import { fakeStripe } from "../helpers/fake-stripe-billing";

const URL = "/api/v1/webhooks/stripe-billing";
const SECRET = "whsec_billing_test";
let app: Awaited<ReturnType<typeof buildServer>>;
const eventIds: string[] = [];

function makeEvent(
  type: string,
  object: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) {
  const id = `evt_${randomUUID().replace(/-/g, "")}`;
  eventIds.push(id);
  return {
    id,
    object: "event",
    type,
    data: { object },
    created: Math.floor(Date.now() / 1000),
    ...extra,
  };
}
const send = (event: unknown, signature = "sig_good") =>
  app.inject({
    method: "POST",
    url: URL,
    body: JSON.stringify(event),
    headers: { "content-type": "application/json", "stripe-signature": signature },
  });

async function seed() {
  await db.insert(billingCustomers).values([
    {
      clientCode: "CP-001",
      company: "Acme",
      email: "a@example.com",
      stripeCustomerId: "cus_known",
      source: "created",
    },
    {
      clientCode: "CP-002",
      company: "Acme 2",
      email: "a@example.com",
      stripeCustomerId: "cus_known",
      source: "matched",
    },
  ]);
  await db.insert(billingSnapshots).values(
    ["CP-001", "CP-002"].map((clientCode) => ({
      clientCode,
      stripeCustomerId: "cus_known",
      rendered: { status: "None" },
      contentHash: "h",
    }))
  );
}
const dirtyCount = async () =>
  (await db.select().from(billingSnapshots)).filter((s) => s.dirtyAt !== null).length;

beforeAll(async () => {
  ensureBaseEnv();
  app = await buildServer();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  process.env.STRIPE_BILLING_WEBHOOK_SECRET = SECRET;
  fakeStripe.reset();
  await db.delete(billingSnapshots);
  await db.delete(billingCustomers);
  await seed();
});
afterEach(async () => {
  delete process.env.STRIPE_BILLING_WEBHOOK_SECRET;
  for (const id of eventIds.splice(0)) {
    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, id));
  }
  await db.delete(billingSnapshots);
  await db.delete(billingCustomers);
});

describe("POST /api/v1/webhooks/stripe-billing", () => {
  it("answers 404 and verifies nothing when STRIPE_BILLING_WEBHOOK_SECRET is unset", async () => {
    delete process.env.STRIPE_BILLING_WEBHOOK_SECRET;
    const res = await send(makeEvent("invoice.paid", { customer: "cus_known" }));
    expect(res.statusCode).toBe(404);
    expect(fakeStripe.calls).toEqual([]);
    expect(await dirtyCount()).toBe(0);
  });

  it("uses the billing secret, not the Connect one, to verify", async () => {
    await send(makeEvent("invoice.paid", { customer: "cus_known" }));
    expect(fakeStripe.callsTo("webhooks.constructEvent")[0].params.secret).toBe(SECRET);
  });

  it("rejects a missing signature header and a bad signature with 400", async () => {
    const event = makeEvent("invoice.paid", { customer: "cus_known" });
    const missing = await app.inject({
      method: "POST",
      url: URL,
      body: JSON.stringify(event),
      headers: { "content-type": "application/json" },
    });
    expect(missing.statusCode).toBe(400);
    const bad = await send(event, "sig_wrong");
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/Webhook Error/);
    expect(await dirtyCount()).toBe(0);
  });

  it("ignores an event of a connected account: 200, nothing claimed, no Stripe call, nothing dirty", async () => {
    const event = makeEvent(
      "invoice.paid",
      { customer: "cus_known" },
      { account: "acct_connected" }
    );
    const res = await send(event);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(await dirtyCount()).toBe(0);
    expect(fakeStripe.calls.map((c) => c.call)).toEqual(["webhooks.constructEvent"]);
    const claimed = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, event.id));
    expect(claimed).toHaveLength(0);
  });

  it("ignores an unknown Customer but still records the event", async () => {
    const event = makeEvent("invoice.paid", { customer: "cus_stranger" });
    const res = await send(event);
    expect(res.statusCode).toBe(200);
    expect(await dirtyCount()).toBe(0);
    const [row] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, event.id));
    expect(row.processedAt).not.toBeNull();
  });

  it("marks every snapshot of a known Customer dirty and does nothing else", async () => {
    const before = await db.select().from(billingSnapshots);
    const res = await send(
      makeEvent("invoice.payment_failed", { customer: "cus_known", amount_remaining: 123 })
    );
    expect(res.statusCode).toBe(200);
    expect(await dirtyCount()).toBe(2);
    const after = await db.select().from(billingSnapshots);
    for (const row of after) {
      const old = before.find((b) => b.clientCode === row.clientCode);
      expect(row.rendered).toEqual(old?.rendered);
      expect(row.contentHash).toBe(old?.contentHash);
      expect(row.updatedAt).toEqual(old?.updatedAt);
      expect(row.refreshedAt).toEqual(old?.refreshedAt);
    }
    // The payload is never used for data and no Stripe call is made.
    expect(fakeStripe.calls.map((c) => c.call)).toEqual(["webhooks.constructEvent"]);
  });

  it.each(BILLING_WEBHOOK_EVENTS)("handles %s", async (type) => {
    expect((await send(makeEvent(type, { customer: "cus_known" }))).statusCode).toBe(200);
    expect(await dirtyCount()).toBe(2);
  });

  it("reads the Customer of an expanded object", async () => {
    await send(makeEvent("customer.subscription.updated", { customer: { id: "cus_known" } }));
    expect(await dirtyCount()).toBe(2);
  });

  it("acknowledges an event type it does not handle without claiming it", async () => {
    const event = makeEvent("charge.succeeded", { customer: "cus_known" });
    const res = await send(event);
    expect(res.statusCode).toBe(200);
    expect(await dirtyCount()).toBe(0);
    const rows = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, event.id));
    expect(rows).toHaveLength(0);
  });

  it("dedupes: a second delivery of a processed event does not mark dirty again", async () => {
    const event = makeEvent("invoice.paid", { customer: "cus_known" });
    expect((await send(event)).statusCode).toBe(200);
    await db.update(billingSnapshots).set({ dirtyAt: null });
    const again = await send(event);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ received: true });
    expect(await dirtyCount()).toBe(0);
  });

  it("answers 409 while another delivery holds the lease, and reclaims a stale lease", async () => {
    const live = makeEvent("invoice.paid", { customer: "cus_known" });
    await db.insert(webhookEvents).values({
      id: randomUUID(),
      stripeEventId: live.id,
      type: live.type,
      claimedAt: new Date(),
    });
    expect((await send(live)).statusCode).toBe(409);
    expect(await dirtyCount()).toBe(0);

    const stale = makeEvent("invoice.paid", { customer: "cus_known" });
    await db.insert(webhookEvents).values({
      id: randomUUID(),
      stripeEventId: stale.id,
      type: stale.type,
      claimedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    expect((await send(stale)).statusCode).toBe(200);
    expect(await dirtyCount()).toBe(2);
  });

  it("releases the claim and answers 500 when marking dirty fails, so Stripe retries", async () => {
    const event = makeEvent("invoice.paid", { customer: "cus_known" });
    const snapshots = await import("../../lib/billing-snapshot");
    const spy = vi
      .spyOn(snapshots, "markCustomerDirty")
      .mockRejectedValueOnce(new Error("db down"));
    try {
      expect((await send(event)).statusCode).toBe(500);
      const rows = await db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.stripeEventId, event.id));
      expect(rows).toHaveLength(0);
      expect((await send(event)).statusCode).toBe(200);
      expect(await dirtyCount()).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});
