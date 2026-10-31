import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/stripe", async () => {
  const { fakeStripe } = await import("../helpers/fake-stripe-billing");
  return { stripe: fakeStripe.stripe };
});

import { buildServer } from "../../app";
import { db } from "../../db/client";
import {
  billingCustomers,
  billingSnapshots,
  portalMirrorRows,
  portalMirrorState,
} from "../../db/schema";
import { runBillingMirrorCycle, startBillingMirror } from "../../lib/billing-mirror-sync";
import { markCustomerDirty, runBillingRefresh } from "../../lib/billing-snapshot";
import { days, invoice, paidInvoice, sub } from "../helpers/billing-fixtures";
import { ensureBaseEnv } from "../helpers/env";
import { FakeTablesNextcloud, mirrorEnv } from "../helpers/fake-nextcloud-tables";
import { fakeStripe } from "../helpers/fake-stripe-billing";

// Every Stripe method is a recorded spy (helpers/fake-stripe-billing.ts). Whatever 5a does, the
// only calls may be the three list methods and webhook signature verification.
const WRITE_METHODS = [
  "create",
  "update",
  "del",
  "finalizeInvoice",
  "sendInvoice",
  "pay",
  "cancel",
  "voidInvoice",
  "markUncollectible",
  "release",
  "retrieve",
  "search",
  "capture",
  "confirm",
];
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("billing mirror is read-only toward Stripe", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    ensureBaseEnv();
    process.env.STRIPE_BILLING_WEBHOOK_SECRET = "whsec_billing_test";
    app = await buildServer();
  });
  afterAll(async () => {
    delete process.env.STRIPE_BILLING_WEBHOOK_SECRET;
    await app.close();
  });

  it("makes zero Stripe writes across refresh, sweep, webhook route, mirror cycle and the runner", async () => {
    await db.delete(portalMirrorRows);
    await db.delete(portalMirrorState);
    await db.delete(billingSnapshots);
    await db.delete(billingCustomers);
    fakeStripe.reset();
    const fake = new FakeTablesNextcloud();
    vi.stubGlobal("fetch", vi.fn(fake.fetch));
    try {
      await db.insert(billingCustomers).values([
        {
          clientCode: "CP-001",
          company: "A",
          email: "a@example.com",
          stripeCustomerId: "cus_1",
          source: "created",
        },
        {
          clientCode: "CP-002",
          company: "B",
          email: "b@example.com",
          stripeCustomerId: "cus_2",
          source: "created",
        },
      ]);
      fakeStripe.set("cus_1", {
        subscriptions: [sub({ id: "sub_a", status: "past_due" })],
        invoices: [
          paidInvoice("in_1", "sub_a", 1000, 3),
          invoice({ id: "in_u", status: "uncollectible", amount_remaining: 500 }),
        ],
        schedules: [{ status: "not_started", phases: [{ start_date: days(4) }] }],
      });
      fakeStripe.set("cus_2", {});

      await runBillingRefresh({ logger, all: false, gapMs: 0 });
      await runBillingRefresh({ logger, all: true, gapMs: 0 });
      for (const [type, customer, account] of [
        ["invoice.paid", "cus_1", undefined],
        ["customer.subscription.deleted", "cus_2", undefined],
        ["invoice.paid", "cus_1", "acct_connected"],
        ["invoice.paid", "cus_unknown", undefined],
      ] as const) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/webhooks/stripe-billing",
          body: JSON.stringify({
            id: `evt_nw_${Math.random()}`,
            type,
            account,
            data: { object: { customer } },
          }),
          headers: { "content-type": "application/json", "stripe-signature": "sig_good" },
        });
        expect(res.statusCode).toBe(200);
      }
      await markCustomerDirty("cus_1");
      await runBillingRefresh({ logger, all: false, gapMs: 0 });
      const env = mirrorEnv({ BILLING_MIRROR: "true" });
      await runBillingMirrorCycle({ logger, env, minGapMs: 0 });
      const runner = startBillingMirror(logger, env);
      await vi.waitFor(() => expect(fakeStripe.callsTo("invoices.list").length).toBeGreaterThan(4));
      await runner?.stop();

      expect(fakeStripe.callsTo("invoices.list").length).toBeGreaterThan(0);
      const names = fakeStripe.calls.map((c) => c.call);
      for (const call of names) {
        expect([
          "subscriptions.list",
          "subscriptionSchedules.list",
          "invoices.list",
          "webhooks.constructEvent",
        ]).toContain(call);
        expect(WRITE_METHODS).not.toContain(call.split(".")[1]);
      }
      expect(fakeStripe.unexpected()).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      await db.delete(portalMirrorRows);
      await db.delete(portalMirrorState);
      await db.delete(billingSnapshots);
      await db.delete(billingCustomers);
    }
  });
});
