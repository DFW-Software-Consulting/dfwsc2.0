import { eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/stripe", async () => {
  const { fakeStripe } = await import("../helpers/fake-stripe-billing");
  return { stripe: fakeStripe.stripe };
});

import { db, pool } from "../../db/client";
import { billingCustomers, billingSnapshots } from "../../db/schema";
import {
  markCustomerDirty,
  resetBillingSnapshotStateForTests,
  runBillingRefresh,
} from "../../lib/billing-snapshot";
import {
  openStripeCircuitForTests,
  resetCircuitBreakersForTests,
} from "../../lib/circuit-breakers";
import { days, invoice, paidInvoice, sub } from "../helpers/billing-fixtures";
import { fakeStripe } from "../helpers/fake-stripe-billing";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const refresh = (all = false) => runBillingRefresh({ logger, all, gapMs: 0 });

async function addCustomer(clientCode: string, stripeCustomerId: string, company = "Acme") {
  await db.insert(billingCustomers).values({
    clientCode,
    company,
    email: `${clientCode.toLowerCase()}@example.com`,
    stripeCustomerId,
    source: "created",
  });
}
const snapshot = async (clientCode: string) => {
  const [row] = await db
    .select()
    .from(billingSnapshots)
    .where(eq(billingSnapshots.clientCode, clientCode));
  return row;
};

beforeEach(async () => {
  await db.delete(billingSnapshots);
  await db.delete(billingCustomers);
  fakeStripe.reset();
  resetBillingSnapshotStateForTests();
  resetCircuitBreakersForTests();
  vi.clearAllMocks();
});
afterEach(async () => {
  await db.delete(billingSnapshots);
  await db.delete(billingCustomers);
});

describe("billing snapshot refresh", () => {
  it("creates a snapshot per client code from Stripe lists, one set of reads per Customer", async () => {
    await addCustomer("CP-001", "cus_1");
    await addCustomer("CP-002", "cus_1"); // shares the Customer
    fakeStripe.set("cus_1", {
      subscriptions: [sub({ id: "sub_a" })],
      invoices: [paidInvoice("in_1", "sub_a", 150000, 3)],
    });

    const out = await refresh();
    expect(out).toMatchObject({ status: "ok", refreshed: 1, changed: 2, failed: 0 });

    const a = await snapshot("CP-001");
    const b = await snapshot("CP-002");
    expect(a.rendered).toEqual(b.rendered);
    expect(a.rendered).toMatchObject({
      status: "Active",
      subscription: "$1,500/week",
      amountPaid: 1500,
    });
    expect(a.stripeCustomerId).toBe("cus_1");
    expect(a.dirtyAt).toBeNull();

    expect(fakeStripe.callsTo("subscriptions.list")).toHaveLength(1);
    expect(fakeStripe.callsTo("subscriptions.list")[0].params).toMatchObject({
      customer: "cus_1",
      status: "all",
      expand: ["data.schedule"],
    });
    expect(fakeStripe.callsTo("invoices.list")[0].params).toMatchObject({
      customer: "cus_1",
      limit: 100,
    });
    expect(fakeStripe.callsTo("invoices.list")[0].params.expand).toBeUndefined();
    expect(fakeStripe.callsTo("invoicePayments.list")).toHaveLength(0); // nothing qualifies
    expect(fakeStripe.callsTo("paymentIntents.retrieve")).toHaveLength(0);
    expect(fakeStripe.unexpected()).toEqual([]);
  });

  const attempted = (id: string) =>
    invoice({
      id,
      status: "open",
      amount_remaining: 1000,
      collection_method: "charge_automatically",
      attempt_count: 1,
    });
  const withPayments = (id: string, pi: string) => ({
    [id]: [
      {
        id: `ipay_${id}_old`,
        created: 1,
        payment: { type: "payment_intent", payment_intent: `${pi}_old` },
      },
      { id: `ipay_${id}`, created: 2, payment: { type: "payment_intent", payment_intent: pi } },
    ],
  });
  const invalidRequest = () =>
    new Stripe.errors.StripeInvalidRequestError({
      type: "invalid_request_error",
      message: "No such invoice payment",
      code: "resource_missing",
    });

  it("looks up the latest InvoicePayment and its PaymentIntent only for open attempted charge_automatically invoices", async () => {
    await addCustomer("CP-001", "cus_1");
    fakeStripe.set("cus_1", {
      invoices: [attempted("in_1"), invoice({ id: "in_2", status: "open", amount_remaining: 500 })],
      invoicePayments: withPayments("in_1", "pi_1"),
      paymentIntents: [{ id: "pi_1", status: "processing" }],
    });
    await refresh();
    expect(fakeStripe.callsTo("invoicePayments.list").map((c) => c.params)).toEqual([
      { invoice: "in_1", limit: 10 },
    ]);
    expect(fakeStripe.callsTo("paymentIntents.retrieve").map((c) => c.params.id)).toEqual(["pi_1"]);
    expect((await snapshot("CP-001")).rendered).toMatchObject({
      status: "Payment processing",
      overdue: 0,
      openBalance: 15,
    });
    expect(fakeStripe.unexpected()).toEqual([]);
  });

  it("caps payment lookups per refresh at 10 and warns once with the Customer; the rest read as failed", async () => {
    await addCustomer("CP-001", "cus_1");
    const ids = Array.from({ length: 12 }, (_, i) => `in_${i}`);
    fakeStripe.set("cus_1", {
      invoices: ids.map(attempted),
      invoicePayments: Object.assign({}, ...ids.map((id) => withPayments(id, `pi_${id}`))),
      paymentIntents: ids.map((id) => ({ id: `pi_${id}`, status: "processing" })),
    });
    await refresh();
    expect(fakeStripe.callsTo("invoicePayments.list")).toHaveLength(10);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatchObject({ customerId: "cus_1", skipped: 2 });
    expect((await snapshot("CP-001")).rendered).toMatchObject({ status: "Late", overdue: 20 });
  });

  it("a non-transient lookup error reads that invoice as failed and warns with ids and code", async () => {
    await addCustomer("CP-001", "cus_1");
    fakeStripe.set("cus_1", {
      invoices: [attempted("in_1")],
      invoicePayments: withPayments("in_1", "pi_1"),
    });
    fakeStripe.failures.set("invoicePayments.list:in_1", invalidRequest());
    const out = await refresh();
    expect(out).toMatchObject({ status: "ok", refreshed: 1, failed: 0 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toEqual({
      customerId: "cus_1",
      invoiceId: "in_1",
      errorCode: "resource_missing",
    });
    expect((await snapshot("CP-001")).rendered).toMatchObject({ status: "Late", overdue: 10 });
  });

  it("a failing PaymentIntent retrieve is handled the same way", async () => {
    await addCustomer("CP-001", "cus_1");
    fakeStripe.set("cus_1", {
      invoices: [attempted("in_1")],
      invoicePayments: withPayments("in_1", "pi_1"),
    });
    fakeStripe.failures.set("paymentIntents.retrieve", invalidRequest());
    await refresh();
    expect((await snapshot("CP-001")).rendered).toMatchObject({ status: "Late", overdue: 10 });
  });

  it.each([
    [
      "connection",
      () => new Stripe.errors.StripeConnectionError({ type: "api_error", message: "reset" }),
    ],
    [
      "5xx API",
      () =>
        new Stripe.errors.StripeAPIError({ type: "api_error", message: "oops", statusCode: 503 }),
    ],
  ])("a %s error on a payment lookup fails the refresh and keeps the previous snapshot, not Late", async (_name, make) => {
    await addCustomer("CP-001", "cus_1");
    const data = {
      invoices: [attempted("in_1")],
      invoicePayments: withPayments("in_1", "pi_1"),
      paymentIntents: [{ id: "pi_1", status: "processing" }],
    };
    fakeStripe.set("cus_1", data);
    await refresh();
    const before = (await snapshot("CP-001")).rendered;
    expect(before).toMatchObject({ status: "Payment processing" });
    await db.update(billingSnapshots).set({ dirtyAt: sql`now()` });
    resetBillingSnapshotStateForTests();
    fakeStripe.failures.set("paymentIntents.retrieve", make());
    const out = await refresh();
    expect(out).toMatchObject({ failed: 1, changed: 0 });
    expect((await snapshot("CP-001")).rendered).toEqual(before);
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: "in_1" }),
      expect.anything()
    );
  });

  it("a rate limit during a payment lookup stops the run, as before", async () => {
    await addCustomer("CP-001", "cus_1");
    fakeStripe.set("cus_1", {
      invoices: [attempted("in_1")],
      invoicePayments: withPayments("in_1", "pi_1"),
    });
    fakeStripe.failures.set(
      "invoicePayments.list",
      Object.assign(new Error("slow down"), { statusCode: 429 })
    );
    const out = await refresh();
    expect(out.status).toBe("stopped");
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: "in_1" }),
      expect.anything()
    );
  });

  it("pages every list to the end", async () => {
    await addCustomer("CP-001", "cus_1");
    fakeStripe.pageSize = 2;
    const subs = Array.from({ length: 5 }, (_, i) => sub({ id: `sub_${i}` }));
    fakeStripe.set("cus_1", {
      subscriptions: subs,
      invoices: subs.flatMap((s, i) => [
        paidInvoice(`in_${i}a`, s.id, 100000, 7 + i),
        paidInvoice(`in_${i}b`, s.id, 100000, 14 + i),
      ]),
    });
    await refresh();
    expect(fakeStripe.callsTo("subscriptions.list")).toHaveLength(3);
    expect(fakeStripe.callsTo("invoices.list")).toHaveLength(5);
    expect(fakeStripe.callsTo("invoices.list")[1].params.starting_after).toBe("in_0b");
    const row = await snapshot("CP-001");
    expect((row.rendered as { paymentsMade: string }).paymentsMade).toBe("2; 2; 2; 2; 2");
    expect((row.rendered as { amountPaid: number }).amountPaid).toBe(10000);
  });

  it("moves updated_at only when the content hash changes", async () => {
    await addCustomer("CP-001", "cus_1");
    fakeStripe.set("cus_1", { subscriptions: [sub({ id: "sub_a" })] });
    await refresh();
    const first = await snapshot("CP-001");

    await new Promise((r) => setTimeout(r, 20));
    await refresh(true);
    const second = await snapshot("CP-001");
    expect(second.updatedAt).toEqual(first.updatedAt);
    expect(second.refreshedAt?.getTime()).toBeGreaterThan(first.refreshedAt?.getTime() ?? 0);
    expect(second.contentHash).toBe(first.contentHash);

    fakeStripe.set("cus_1", {
      subscriptions: [sub({ id: "sub_a" })],
      invoices: [paidInvoice("in_1", "sub_a", 150000, 1)],
    });
    await refresh(true);
    const third = await snapshot("CP-001");
    expect(third.contentHash).not.toBe(first.contentHash);
    expect(third.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
  });

  it("refreshes only dirty Customers and those without a snapshot, the sweep refreshes all", async () => {
    await addCustomer("CP-001", "cus_1");
    await addCustomer("CP-002", "cus_2");
    fakeStripe.set("cus_1", {});
    fakeStripe.set("cus_2", {});
    await refresh();
    expect(fakeStripe.callsTo("subscriptions.list")).toHaveLength(2);

    fakeStripe.calls = [];
    await refresh(); // nothing dirty
    expect(fakeStripe.calls).toEqual([]);

    expect(await markCustomerDirty("cus_2")).toBe(true);
    expect((await snapshot("CP-002")).dirtyAt).not.toBeNull();
    await refresh();
    expect(fakeStripe.callsTo("subscriptions.list").map((c) => c.params.customer)).toEqual([
      "cus_2",
    ]);
    expect((await snapshot("CP-002")).dirtyAt).toBeNull();

    fakeStripe.calls = [];
    await refresh(true);
    expect(fakeStripe.callsTo("subscriptions.list")).toHaveLength(2);

    await addCustomer("CP-003", "cus_3"); // no snapshot yet
    fakeStripe.set("cus_3", {});
    fakeStripe.calls = [];
    await refresh();
    expect(fakeStripe.callsTo("subscriptions.list").map((c) => c.params.customer)).toEqual([
      "cus_3",
    ]);
  });

  it("keeps a webhook's dirty mark that arrives while the refresh is reading Stripe", async () => {
    await addCustomer("CP-001", "cus_1");
    fakeStripe.set("cus_1", {});
    await refresh();
    await markCustomerDirty("cus_1");

    fakeStripe.beforeList = async (customerId, call) => {
      if (call === "invoices.list") {
        fakeStripe.beforeList = null;
        await markCustomerDirty(customerId); // a newer event during the refresh
      }
    };
    await refresh();
    expect((await snapshot("CP-001")).dirtyAt).not.toBeNull();
    await refresh();
    expect((await snapshot("CP-001")).dirtyAt).toBeNull();
  });

  it("marks nothing for an unknown Customer", async () => {
    expect(await markCustomerDirty("cus_nobody")).toBe(false);
  });

  it("ends the run on a rate limit and on an open circuit without recording a failure", async () => {
    await addCustomer("CP-001", "cus_1");
    await addCustomer("CP-002", "cus_2");
    fakeStripe.set("cus_1", {});
    fakeStripe.set("cus_2", {});
    fakeStripe.beforeList = () => {
      throw Object.assign(new Error("slow down"), { statusCode: 429 });
    };
    const out = await refresh();
    expect(out.status).toBe("stopped");
    expect(fakeStripe.callsTo("subscriptions.list")).toHaveLength(1); // cus_2 never tried
    fakeStripe.beforeList = null;
    expect((await refresh()).refreshed).toBe(2);
  });

  it("ends the run when the Stripe circuit is open, with no Stripe call", async () => {
    await addCustomer("CP-001", "cus_1");
    fakeStripe.set("cus_1", {});
    openStripeCircuitForTests();
    try {
      expect((await refresh()).status).toBe("stopped");
      expect(fakeStripe.calls).toEqual([]);
    } finally {
      resetCircuitBreakersForTests();
    }
  });

  it("records a failing Customer, backs it off and goes on with the next one", async () => {
    await addCustomer("CP-001", "cus_1");
    await addCustomer("CP-002", "cus_2");
    fakeStripe.set("cus_1", {});
    fakeStripe.set("cus_2", {});
    await refresh();
    await markCustomerDirty("cus_1");
    await markCustomerDirty("cus_2");

    fakeStripe.beforeList = (customerId) => {
      if (customerId === "cus_1")
        throw Object.assign(new Error("no such customer"), { statusCode: 404 });
    };
    const out = await refresh();
    expect(out).toMatchObject({ status: "ok", refreshed: 1, failed: 1 });
    const failed = await snapshot("CP-001");
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toBe("Error");
    expect(failed.dirtyAt).not.toBeNull();
    expect((await snapshot("CP-002")).dirtyAt).toBeNull();

    fakeStripe.calls = [];
    await refresh(); // cus_1 is backing off
    expect(fakeStripe.calls).toEqual([]);
  });

  it("refreshes the stalest Customers first, never-refreshed before all", async () => {
    for (const [code, cus] of [
      ["CP-1", "cus_a"],
      ["CP-2", "cus_b"],
      ["CP-3", "cus_c"],
    ]) {
      await addCustomer(code, cus);
      fakeStripe.set(cus, {});
    }
    await refresh(); // all three get a snapshot
    await db.execute(
      sql`UPDATE billing_snapshots SET refreshed_at = now() - interval '3 hours' WHERE client_code = 'CP-3'`
    );
    await db.execute(
      sql`UPDATE billing_snapshots SET refreshed_at = now() - interval '1 hour' WHERE client_code = 'CP-1'`
    );
    await db.execute(
      sql`UPDATE billing_snapshots SET refreshed_at = now() - interval '2 hours' WHERE client_code = 'CP-2'`
    );
    await addCustomer("CP-4", "cus_d");
    fakeStripe.set("cus_d", {});
    fakeStripe.calls = [];
    await refresh(true);
    expect(fakeStripe.callsTo("subscriptions.list").map((c) => c.params.customer)).toEqual([
      "cus_d",
      "cus_c",
      "cus_b",
      "cus_a",
    ]);
  });

  it("stores a failed first refresh on a row with no snapshot yet", async () => {
    await addCustomer("CP-001", "cus_1");
    fakeStripe.set("cus_1", {});
    fakeStripe.beforeList = () => {
      throw Object.assign(new Error("x"), { statusCode: 404 });
    };
    await refresh();
    const row = await snapshot("CP-001");
    expect(row.rendered).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe("Error");

    fakeStripe.beforeList = null;
    resetBillingSnapshotStateForTests();
    await refresh(); // a row without a snapshot is refreshed again
    const healed = await snapshot("CP-001");
    expect(healed.rendered).toMatchObject({ status: "None" });
    expect(healed.attempts).toBe(0);
    expect(healed.lastError).toBeNull();
  });

  it("answers busy while another process holds the refresh lock", async () => {
    await addCustomer("CP-001", "cus_1");
    fakeStripe.set("cus_1", {});
    const holder = await pool.connect();
    await holder.query("SELECT pg_advisory_lock(hashtext($1))", ["billing_snapshot_refresh"]);
    try {
      expect((await refresh()).status).toBe("busy");
      expect(fakeStripe.calls).toEqual([]);
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtext($1))", ["billing_snapshot_refresh"]);
      holder.release();
    }
  });

  it("derives Late from the lists, not from anything else", async () => {
    await addCustomer("CP-001", "cus_1");
    fakeStripe.set("cus_1", {
      invoices: [
        invoice({ id: "in_o", status: "open", amount_remaining: 50000, due_date: days(-2) }),
      ],
    });
    await refresh();
    expect((await snapshot("CP-001")).rendered).toMatchObject({
      status: "Late",
      upToDate: "No",
      overdue: 500,
    });
  });

  it("deletes a snapshot with its billing customer", async () => {
    await addCustomer("CP-001", "cus_1");
    fakeStripe.set("cus_1", {});
    await refresh();
    await db.execute(sql`DELETE FROM billing_customers WHERE client_code = 'CP-001'`);
    expect(await snapshot("CP-001")).toBeUndefined();
  });
});
