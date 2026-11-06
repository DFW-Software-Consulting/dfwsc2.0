import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/stripe", async () => {
  const { fakeStripe } = await import("../helpers/fake-stripe-billing");
  return { stripe: fakeStripe.stripe };
});

import { buildServer } from "../../app";
import { db } from "../../db/client";
import { webhookEvents } from "../../db/schema";
import { LedgerSyncBusyError, syncInvoicePaid } from "../../lib/ledger-sync";
import { resetNextcloudBreakerForTests } from "../../lib/nextcloud";
import { ensureBaseEnv } from "../helpers/env";
import { FakeLedgerNextcloud } from "../helpers/fake-ledger-nextcloud";
import { fakeStripe } from "../helpers/fake-stripe-billing";

// The ledger sync books a paid platform invoice into Nextcloud from the billing webhook. These
// tests run against a real Postgres: the per-invoice advisory lock and the webhook_events lease
// are what keep concurrent and repeated deliveries from booking an invoice twice.

const URL = "/api/v1/webhooks/stripe-billing";
const SECRET = "whsec_billing_test";
const PAID_AT = 1767250000; // inside FY 2026 of the fake ledger
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as unknown as FastifyBaseLogger;

let app: Awaited<ReturnType<typeof buildServer>>;
let nc: FakeLedgerNextcloud;
const eventIds: string[] = [];

function invoiceObject(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    object: "invoice",
    number: "WEB-0001",
    status: "paid",
    currency: "usd",
    customer: "cus_unknown_to_billing",
    customer_name: "Acme Corp",
    customer_email: "billing@acme.test",
    amount_due: 20000,
    amount_paid: 20000,
    amount_remaining: 0,
    subtotal: 20000,
    created: PAID_AT - 3600,
    status_transitions: { paid_at: PAID_AT },
    lines: { data: [{ description: "Development", quantity: 1, amount: 20000 }] },
    metadata: {},
    ...overrides,
  };
}

function makeEvent(type: string, object: Record<string, unknown>, extra = {}) {
  const id = `evt_${randomUUID().replace(/-/g, "")}`;
  eventIds.push(id);
  return { id, object: "event", type, data: { object }, created: PAID_AT, ...extra };
}

const send = (event: unknown) =>
  app.inject({
    method: "POST",
    url: URL,
    body: JSON.stringify(event),
    headers: { "content-type": "application/json", "stripe-signature": "sig_good" },
  });

const claimRows = async (eventId: string) =>
  db.select().from(webhookEvents).where(eq(webhookEvents.stripeEventId, eventId));

function enableLedgerSync() {
  process.env.LEDGER_SYNC_ENABLED = "true";
  process.env.NEXTCLOUD_BASE_URL = "https://cloud.test";
  process.env.NEXTCLOUD_USERNAME = "svc";
  process.env.NEXTCLOUD_APP_PASSWORD = "secret";
}

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "LEDGER_SYNC_ENABLED",
  "NEXTCLOUD_BASE_URL",
  "NEXTCLOUD_USERNAME",
  "NEXTCLOUD_APP_PASSWORD",
  "STRIPE_BILLING_WEBHOOK_SECRET",
];

beforeAll(async () => {
  ensureBaseEnv();
  app = await buildServer();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.STRIPE_BILLING_WEBHOOK_SECRET = SECRET;
  enableLedgerSync();
  fakeStripe.reset();
  resetNextcloudBreakerForTests();
  nc = new FakeLedgerNextcloud();
  nc.install();
});
afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
  for (const id of eventIds.splice(0)) {
    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, id));
  }
});

describe("ledger sync through POST /webhooks/stripe-billing", () => {
  it("books income and the register object on invoice.paid", async () => {
    const res = await send(makeEvent("invoice.paid", invoiceObject("in_route_1")));
    expect(res.statusCode).toBe(200);
    expect(nc.incomes).toHaveLength(1);
    expect(nc.register).toHaveLength(1);
    expect(nc.register[0].status).toBe("paid");
  });

  it("does nothing when LEDGER_SYNC_ENABLED is unset, and makes no Stripe call", async () => {
    delete process.env.LEDGER_SYNC_ENABLED;
    const res = await send(makeEvent("invoice.paid", invoiceObject("in_route_2")));
    expect(res.statusCode).toBe(200);
    expect(nc.calls).toHaveLength(0);
    expect(fakeStripe.callsTo("invoicePayments.list")).toHaveLength(0);
  });

  it("ignores a connected-account event before the ledger is touched", async () => {
    const res = await send(
      makeEvent("invoice.paid", invoiceObject("in_route_3"), { account: "acct_123" })
    );
    expect(res.statusCode).toBe(200);
    expect(nc.calls).toHaveLength(0);
  });

  it("answers 500 and releases the claim when the booking fails, then heals on redelivery", async () => {
    nc.failNext("POST", "/fiscal-years/1/incomes");
    const event = makeEvent("invoice.paid", invoiceObject("in_route_4"));

    const first = await send(event);
    expect(first.statusCode).toBe(500);
    expect(await claimRows(event.id)).toHaveLength(0);

    const second = await send(event);
    expect(second.statusCode).toBe(200);
    expect(nc.incomes).toHaveLength(1);
    expect(nc.register).toHaveLength(1);
  });

  it("two events for one invoice (redelivery under a new event id) book once", async () => {
    const invoice = invoiceObject("in_route_5");
    expect((await send(makeEvent("invoice.paid", invoice))).statusCode).toBe(200);
    expect((await send(makeEvent("invoice.paid", invoice))).statusCode).toBe(200);
    expect(nc.incomes).toHaveLength(1);
    expect(nc.register).toHaveLength(1);
  });

  it("acknowledges a lifecycle event even when the register is down", async () => {
    nc.failNext("GET", "/openregister/api/objects", 5);
    const event = makeEvent("invoice.finalized", invoiceObject("in_route_6", { status: "open" }));
    const res = await send(event);
    expect(res.statusCode).toBe(200);
    expect((await claimRows(event.id))[0]?.processedAt).not.toBeNull();
  });

  it("mirrors a lifecycle event into the register", async () => {
    const res = await send(
      makeEvent("invoice.voided", invoiceObject("in_route_7", { status: "void" }))
    );
    expect(res.statusCode).toBe(200);
    expect(nc.register[0]).toMatchObject({ stripe_invoice_id: "in_route_7", status: "void" });
    expect(nc.incomes).toHaveLength(0);
  });

  it("answers 500 for the delivery that loses a race and books once after both settle", async () => {
    nc = new FakeLedgerNextcloud({ delayMs: 25 });
    nc.install();
    const invoice = invoiceObject("in_route_8");
    const [a, b] = await Promise.all([
      send(makeEvent("invoice.paid", invoice)),
      send(makeEvent("invoice.paid", invoice)),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 500]);
    // Stripe retries the loser; it finds everything booked.
    expect((await send(makeEvent("invoice.paid", invoice))).statusCode).toBe(200);
    expect(nc.incomes).toHaveLength(1);
    expect(nc.register).toHaveLength(1);
  });
});

describe("syncInvoicePaid under concurrent delivery (real advisory lock)", () => {
  const invoice = invoiceObject("in_lock_1") as unknown as Stripe.Invoice;
  const stripeClient = fakeStripe.stripe as Stripe;

  it("lets one delivery book while the other is told to retry, then books nothing twice", async () => {
    nc = new FakeLedgerNextcloud({ delayMs: 25 });
    nc.install();

    const results = await Promise.allSettled([
      syncInvoicePaid(stripeClient, invoice, logger),
      syncInvoicePaid(stripeClient, invoice, logger),
      syncInvoicePaid(stripeClient, invoice, logger),
    ]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(LedgerSyncBusyError);
    }

    await syncInvoicePaid(stripeClient, invoice, logger);
    expect(nc.incomes).toHaveLength(1);
    expect(nc.register).toHaveLength(1);
  });

  it("does not serialize different invoices against each other", async () => {
    nc = new FakeLedgerNextcloud({ delayMs: 10 });
    nc.install();
    const other = invoiceObject("in_lock_2", { number: "WEB-0002" }) as unknown as Stripe.Invoice;
    const results = await Promise.allSettled([
      syncInvoicePaid(stripeClient, invoice, logger),
      syncInvoicePaid(stripeClient, other, logger),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(nc.incomes).toHaveLength(2);
  });

  it("creates a new fiscal year once when two different invoices race to it", async () => {
    nc = new FakeLedgerNextcloud({ fiscalYears: [], delayMs: 20 });
    nc.install();
    const a = invoiceObject("in_fy_a", { number: "FY-A" }) as unknown as Stripe.Invoice;
    const b = invoiceObject("in_fy_b", { number: "FY-B" }) as unknown as Stripe.Invoice;
    const results = await Promise.allSettled([
      syncInvoicePaid(stripeClient, a, logger),
      syncInvoicePaid(stripeClient, b, logger),
    ]);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(LedgerSyncBusyError);
    }
    // Stripe retries whichever delivery was turned away.
    await syncInvoicePaid(stripeClient, a, logger);
    await syncInvoicePaid(stripeClient, b, logger);
    expect(nc.fiscalYears).toHaveLength(1);
    expect(nc.incomes).toHaveLength(2);
  });

  it("releases the lock after a failure so the retry can proceed", async () => {
    nc.failNext("POST", "/fiscal-years/1/incomes");
    await expect(syncInvoicePaid(stripeClient, invoice, logger)).rejects.toThrow();
    await syncInvoicePaid(stripeClient, invoice, logger);
    expect(nc.incomes).toHaveLength(1);
  });
});
