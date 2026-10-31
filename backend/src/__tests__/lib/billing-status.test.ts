import { describe, expect, it } from "vitest";
import {
  BILLING_COLUMN_KEYS,
  billingColumns,
  renderBillingRow,
  stripeCustomerUrl,
} from "../../lib/billing-mirror-render";
import { type BillingInput, deriveBilling } from "../../lib/billing-status";
import { contentHash } from "../../lib/portal-mirror-render";
import { days, invoice, NOW, paidInvoice, schedule, sub } from "../helpers/billing-fixtures";

const derive = (input: Partial<BillingInput>) =>
  deriveBilling({ subscriptions: [], schedules: [], invoices: [], now: NOW, ...input });

describe("deriveBilling status rules", () => {
  it("None: nothing in Stripe", () => {
    expect(derive({})).toEqual({
      status: "None",
      upToDate: "Yes",
      subscription: "",
      paymentsMade: "",
      amountPaid: 0,
      nextDue: null,
      openBalance: 0,
      overdue: 0,
      lastPayment: null,
      nonUsd: false,
    });
  });

  it("None: only draft and void invoices and incomplete_expired subscriptions", () => {
    const values = derive({
      subscriptions: [sub({ id: "sub_x", status: "incomplete_expired" })],
      invoices: [
        invoice({ id: "in_d", status: "draft", amount_remaining: 5000 }),
        invoice({ id: "in_v", status: "void", amount_remaining: 5000, due_date: days(-30) }),
      ],
    });
    expect(values.status).toBe("None");
    expect(values.openBalance).toBe(0);
  });

  it("Active: open-ended weekly plan, shown without a length", () => {
    const values = derive({
      subscriptions: [sub({ id: "sub_a" })],
      invoices: [paidInvoice("in_1", "sub_a", 150000, 4), paidInvoice("in_2", "sub_a", 150000, 11)],
    });
    expect(values.status).toBe("Active");
    expect(values.upToDate).toBe("Yes");
    expect(values.subscription).toBe("$1,500/week");
    expect(values.paymentsMade).toBe("2");
    expect(values.amountPaid).toBe(3000);
    expect(values.lastPayment).toBe("2026-10-27 12:00");
    expect(values.nextDue).toBe("2026-11-03 12:00");
  });

  it("Active: cancel_at plan counts its payments (20 weeks)", () => {
    const start = days(-49); // 7 payments made, 20 in total
    const values = derive({
      subscriptions: [sub({ id: "sub_c", start_date: start, cancel_at: start + 20 * 7 * 86400 })],
      invoices: Array.from({ length: 7 }, (_, i) => paidInvoice(`in_${i}`, "sub_c", 150000, 7 * i)),
    });
    expect(values.subscription).toBe("$1,500/week for 20 weeks");
    expect(values.paymentsMade).toBe("7 of 20");
    expect(values.status).toBe("Active");
  });

  it("Active: schedule phases give the length through iterations or end_date", () => {
    const start = days(-14);
    const byEndDate = derive({
      subscriptions: [
        sub(
          {
            id: "sub_s",
            start_date: start,
            schedule: schedule("active", [
              { start_date: start, end_date: start + 10 * 14 * 86400 },
            ]),
          },
          { amount: 99900, count: 2 }
        ),
      ],
      invoices: [paidInvoice("in_1", "sub_s", 99900, 14), paidInvoice("in_2", "sub_s", 99900, 0)],
    });
    expect(byEndDate.subscription).toBe("$999/2 weeks for 20 weeks");
    expect(byEndDate.paymentsMade).toBe("2 of 10");

    const byIterations = derive({
      subscriptions: [
        sub(
          {
            id: "sub_i",
            schedule: schedule("active", [{ start_date: start, iterations: 6 }]),
          },
          { amount: 50050, interval: "month", quantity: 2 }
        ),
      ],
    });
    expect(byIterations.subscription).toBe("$1,001/month for 6 months");
    expect(byIterations.paymentsMade).toBe("0 of 6");
  });

  it("Ended: a completed schedule with a canceled subscription and nothing live", () => {
    const start = days(-150);
    const values = derive({
      subscriptions: [
        sub({
          id: "sub_done",
          status: "canceled",
          start_date: start,
          schedule: schedule("completed", [
            { start_date: start, end_date: start + 20 * 7 * 86400 },
          ]),
        }),
      ],
      invoices: Array.from({ length: 20 }, (_, i) =>
        paidInvoice(`in_${i}`, "sub_done", 150000, 7 * (i + 1))
      ),
    });
    expect(values.status).toBe("Ended");
    expect(values.upToDate).toBe("Yes");
    expect(values.subscription).toBe("$1,500/week for 20 weeks");
    expect(values.paymentsMade).toBe("20 of 20");
    expect(values.amountPaid).toBe(30000);
    expect(values.nextDue).toBeNull();
  });

  it("Ended: only a paid one-off invoice", () => {
    const values = derive({ invoices: [paidInvoice("in_1", "x", 25000, 90)] });
    expect(values.status).toBe("Ended");
    expect(values.subscription).toBe("");
  });

  it("Late: a past_due subscription", () => {
    const values = derive({
      subscriptions: [sub({ id: "sub_p", status: "past_due" })],
      invoices: [
        invoice({
          id: "in_f",
          status: "open",
          amount_remaining: 150000,
          collection_method: "charge_automatically",
          attempt_count: 2,
        }),
      ],
    });
    expect(values.status).toBe("Late");
    expect(values.upToDate).toBe("No");
    expect(values.overdue).toBe(1500);
    expect(values.openBalance).toBe(1500);
  });

  it("Late: a past_due subscription whose invoice is not listed keeps Up to date Yes (overdue is 0)", () => {
    const values = derive({ subscriptions: [sub({ id: "sub_p", status: "unpaid" })] });
    expect(values.status).toBe("Late");
    expect(values.upToDate).toBe("Yes");
  });

  it("Late starts the day after due_date: not Late later on the due day, Late from the next UTC day", () => {
    const open = (due: number) =>
      derive({
        invoices: [invoice({ id: "in_l", status: "open", amount_remaining: 80000, due_date: due })],
      });
    const dueToday = Math.floor(NOW.getTime() / 1000) - 3600; // earlier today, UTC
    expect(open(dueToday).status).toBe("Active");
    const yesterday = Math.floor(Date.UTC(2026, 9, 30, 23, 59, 59) / 1000);
    const late = open(yesterday);
    expect(late.status).toBe("Late");
    expect(late.overdue).toBe(800);
    expect(late.upToDate).toBe("No");
  });

  it("Active, not Late: an open invoice not yet due, due date is Next Due", () => {
    const values = derive({
      invoices: [
        invoice({ id: "in_soon", status: "open", amount_remaining: 80000, due_date: days(5) }),
      ],
    });
    expect(values.status).toBe("Active");
    expect(values.upToDate).toBe("Yes");
    expect(values.openBalance).toBe(800);
    expect(values.overdue).toBe(0);
    expect(values.nextDue).toBe("2026-11-05 12:00");
  });

  it("an open invoice with nothing remaining is not an open balance", () => {
    const values = derive({
      invoices: [invoice({ id: "in_0", status: "open", amount_remaining: 0, due_date: days(-3) })],
    });
    expect(values.status).toBe("None");
  });

  it("Late: an uncollectible invoice counts until voided", () => {
    const late = derive({
      invoices: [invoice({ id: "in_u", status: "uncollectible", amount_remaining: 40000 })],
    });
    expect(late.status).toBe("Late");
    expect(late.upToDate).toBe("No");
    expect(late.overdue).toBe(400);
    expect(late.openBalance).toBe(0);

    const voided = derive({
      invoices: [invoice({ id: "in_u", status: "void", amount_remaining: 40000 })],
    });
    expect(voided.status).toBe("None");
  });

  it("two subscriptions are joined with '; ', earliest next due wins, Late beats Active", () => {
    const values = derive({
      subscriptions: [
        sub({ id: "sub_1" }),
        {
          ...sub({ id: "sub_2" }, { amount: 250000, interval: "month" }),
          items: {
            data: [
              {
                quantity: 1,
                current_period_end: days(1),
                price: {
                  unit_amount: 250000,
                  currency: "usd",
                  recurring: { interval: "month", interval_count: 1 },
                },
              },
            ],
          },
        },
      ],
      invoices: [
        paidInvoice("in_1", "sub_1", 150000, 5),
        paidInvoice("in_2", "sub_2", 250000, 20),
        paidInvoice("in_3", "sub_2", 250000, 50),
      ],
    });
    expect(values.subscription).toBe("$1,500/week; $2,500/month");
    expect(values.paymentsMade).toBe("1; 2");
    expect(values.nextDue).toBe("2026-11-01 12:00");
    expect(values.status).toBe("Active");

    const late = derive({
      subscriptions: [sub({ id: "sub_1" }), sub({ id: "sub_2", status: "past_due" })],
    });
    expect(late.status).toBe("Late");
  });

  it("a payment of $0 does not count as a payment made", () => {
    const zero = paidInvoice("in_0", "sub_a", 0, 3);
    const values = derive({ subscriptions: [sub({ id: "sub_a" })], invoices: [zero] });
    expect(values.paymentsMade).toBe("0");
    expect(values.lastPayment).toBeNull();
  });

  it("a schedule that has not started is Active and gives Next Due", () => {
    const values = derive({ schedules: [schedule("not_started", [{ start_date: days(10) }])] });
    expect(values.status).toBe("Active");
    expect(values.nextDue).toBe("2026-11-10 12:00");
    expect(values.subscription).toBe("Scheduled plan starting 2026-11-10");
    expect(values.paymentsMade).toBe("0");
  });

  it("a subscription canceling at period end has no next renewal", () => {
    const values = derive({ subscriptions: [sub({ id: "sub_e", cancel_at_period_end: true })] });
    expect(values.nextDue).toBeNull();
  });
});

describe("non-USD invoices", () => {
  const eur = (id: string, overrides = {}) =>
    invoice({ id, status: "open", currency: "eur", amount_remaining: 90000, ...overrides });

  it("keeps Late, blanks Overdue Amount and flags non-USD instead of showing $0", () => {
    const values = derive({ invoices: [eur("in_e", { due_date: days(-5) })] });
    expect(values.status).toBe("Late");
    expect(values.upToDate).toBe("No");
    expect(values.overdue).toBeNull();
    expect(values.openBalance).toBeNull();
    expect(values.nonUsd).toBe(true);
    const row = renderBillingRow({
      company: "A",
      clientCode: "A",
      stripeCustomerId: "cus_1",
      sharedWith: [],
      values,
      failed: false,
      updatedAt: NOW,
      refreshedAt: NOW,
    });
    expect(row.status).toBe("Late (non-USD)");
    expect(row.overdue).toBeNull();
    expect(row.openBalance).toBeNull();
  });

  it("blanks Open Balance only when the open invoice is not yet due", () => {
    const values = derive({ invoices: [eur("in_e", { due_date: days(5) })] });
    expect(values.status).toBe("Active");
    expect(values.overdue).toBe(0);
    expect(values.openBalance).toBeNull();
  });
});

describe("staleness in the row", () => {
  const base = { company: "Acme", clientCode: "CP-1", stripeCustomerId: "cus_1", sharedWith: [] };
  const values = derive({ subscriptions: [sub({ id: "sub_a" })] });

  it("Pending before the first refresh, Check failed when that first refresh failed", () => {
    const pending = renderBillingRow({
      ...base,
      values: null,
      failed: false,
      updatedAt: null,
      refreshedAt: null,
    });
    expect(pending).toMatchObject({
      status: "Pending",
      upToDate: "",
      subscription: "",
      amountPaid: null,
      lastChecked: null,
      updated: null,
    });
    const failed = renderBillingRow({
      ...base,
      values: null,
      failed: true,
      updatedAt: null,
      refreshedAt: null,
    });
    expect(failed.status).toBe("Check failed");
    expect(contentHash(pending)).not.toBe(contentHash(failed));
  });

  it("shows Check failed (was X) with Up to date blank after a later failure, and changes the hash", () => {
    const ok = renderBillingRow({
      ...base,
      values,
      failed: false,
      updatedAt: NOW,
      refreshedAt: NOW,
    });
    const stale = renderBillingRow({
      ...base,
      values,
      failed: true,
      updatedAt: NOW,
      refreshedAt: NOW,
    });
    expect(ok.status).toBe("Active");
    expect(stale.status).toBe("Check failed (was Active)");
    expect(stale.upToDate).toBe("");
    expect(stale.subscription).toBe(ok.subscription);
    expect(contentHash(stale)).not.toBe(contentHash(ok));
  });
});

describe("renderBillingRow", () => {
  const values = derive({ subscriptions: [sub({ id: "sub_a" })] });

  it("renders every column and notes a shared Customer", () => {
    const row = renderBillingRow({
      company: "Acme",
      clientCode: "CP-001",
      stripeCustomerId: "cus_123",
      sharedWith: ["CP-003", "CP-002"],
      values,
      updatedAt: new Date("2026-10-30T08:05:00Z"),
      failed: false,
      refreshedAt: new Date("2026-10-31T11:30:00Z"),
    });
    expect(Object.keys(row).sort()).toEqual([...BILLING_COLUMN_KEYS].sort());
    expect(row.client).toBe("Acme (shares a Stripe Customer with CP-002, CP-003)");
    expect(row.stripeCustomer).toBe("https://dashboard.stripe.com/customers/cus_123");
    expect(row.updated).toBe("2026-10-30 08:05");
    expect(row.lastChecked).toBe("2026-10-31 11:30");
    expect(billingColumns().map((c) => c.key)).toEqual([...BILLING_COLUMN_KEYS]);
  });

  it("two codes of one Customer render the same data and differ only in code and note", () => {
    const a = renderBillingRow({
      company: "Acme",
      clientCode: "A",
      stripeCustomerId: "cus_1",
      sharedWith: ["B"],
      values,
      updatedAt: NOW,
    });
    const b = renderBillingRow({
      company: "Acme",
      clientCode: "B",
      stripeCustomerId: "cus_1",
      sharedWith: ["A"],
      values,
      updatedAt: NOW,
    });
    const { client: ca, clientCode: ka, ...restA } = a;
    const { client: cb, clientCode: kb, ...restB } = b;
    expect(restA).toEqual(restB);
    expect([ka, kb]).toEqual(["A", "B"]);
    expect(ca).not.toBe(cb);
    expect(contentHash(a)).not.toBe(contentHash(b));
  });

  it("uses money columns with 2 decimals and a plain-text customer url", () => {
    const money = billingColumns().filter((c) => c.type === "number");
    expect(money.map((c) => c.title)).toEqual(["Amount Paid", "Open Balance", "Overdue Amount"]);
    expect(money.every((c) => c.decimals === 2 && c.prefix === "$")).toBe(true);
    expect(stripeCustomerUrl("cus_9")).toBe("https://dashboard.stripe.com/customers/cus_9");
  });

  it("cuts a very long joined subscription list", () => {
    const row = renderBillingRow({
      company: "Acme",
      clientCode: "A",
      stripeCustomerId: "cus_1",
      sharedWith: [],
      values: { ...values, subscription: "x".repeat(600) },
      updatedAt: NOW,
      failed: false,
      refreshedAt: NOW,
    });
    expect(String(row.subscription).length).toBe(250);
  });
});
