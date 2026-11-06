import type { FastifyBaseLogger } from "fastify";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LedgerSyncBusyError,
  resolveLedgerSyncConfig,
  syncInvoiceLifecycle,
  syncInvoicePaid,
} from "../../lib/ledger-sync";
import { resetNextcloudBreakerForTests } from "../../lib/nextcloud";
import { FakeLedgerNextcloud } from "../helpers/fake-ledger-nextcloud";

vi.mock("../../lib/circuit-breakers", () => ({
  withStripeCircuit: <T>(fn: () => Promise<T>) => fn(),
}));

// The advisory lock needs a real database; tests/integration/ledger-sync-lock.test.ts covers it.
// Here the lock is a pass-through (or reports busy when a test asks for that).
const lockState = vi.hoisted(() => ({ busy: false }));
vi.mock("../../lib/mirror-table", () => ({
  withMirrorLock: async <T>(_name: string, _log: unknown, busyValue: T, work: () => Promise<T>) =>
    lockState.busy ? busyValue : work(),
}));

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as unknown as FastifyBaseLogger;

const PAID_AT_2026 = 1767250000; // inside FY 2026

let nc: FakeLedgerNextcloud;

function fakeStripe(
  overrides: Partial<Record<"invoicePayments" | "paymentIntents" | "charges", unknown>> = {}
): Stripe {
  return {
    invoicePayments: {
      list: vi.fn(async () => ({
        data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: "pi_123" } }],
      })),
    },
    paymentIntents: {
      retrieve: vi.fn(async () => ({
        latest_charge: {
          balance_transaction: { fee: 610 },
          payment_method_details: { type: "card" },
        },
      })),
    },
    charges: { retrieve: vi.fn() },
    ...overrides,
  } as unknown as Stripe;
}

function invoice(overrides: Record<string, unknown> = {}): Stripe.Invoice {
  return {
    id: "in_test123",
    number: "TEST-0001",
    status: "paid",
    currency: "usd",
    customer: "cus_abc",
    customer_name: "Acme Corp",
    customer_email: "billing@acme.test",
    amount_due: 20000,
    amount_paid: 20000,
    amount_remaining: 0,
    subtotal: 20000,
    created: PAID_AT_2026 - 3600,
    due_date: null,
    hosted_invoice_url: "https://invoice.stripe.com/i/test",
    status_transitions: { paid_at: PAID_AT_2026 },
    lines: {
      data: [{ description: "1 × Development (at $200.00 / week)", quantity: 1, amount: 20000 }],
    },
    metadata: {},
    ...overrides,
  } as unknown as Stripe.Invoice;
}

function enableSync() {
  vi.stubEnv("LEDGER_SYNC_ENABLED", "true");
  vi.stubEnv("NEXTCLOUD_BASE_URL", "https://cloud.test");
  vi.stubEnv("NEXTCLOUD_USERNAME", "svc");
  vi.stubEnv("NEXTCLOUD_APP_PASSWORD", "secret");
}

function useNextcloud(options?: ConstructorParameters<typeof FakeLedgerNextcloud>[0]) {
  nc = new FakeLedgerNextcloud(options);
  nc.install();
  return nc;
}

beforeEach(() => {
  lockState.busy = false;
  resetNextcloudBreakerForTests();
  useNextcloud();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("resolveLedgerSyncConfig", () => {
  const nextcloud = {
    NEXTCLOUD_BASE_URL: "https://cloud.test///",
    NEXTCLOUD_USERNAME: "svc",
    NEXTCLOUD_APP_PASSWORD: "p",
  };

  it("is off unless LEDGER_SYNC_ENABLED is true", () => {
    expect(resolveLedgerSyncConfig({ ...nextcloud })).toBeNull();
    expect(resolveLedgerSyncConfig({ ...nextcloud, LEDGER_SYNC_ENABLED: "yes" })).toBeNull();
  });

  it("is off when the shared Nextcloud service account is incomplete", () => {
    expect(resolveLedgerSyncConfig({ LEDGER_SYNC_ENABLED: "true" })).toBeNull();
    expect(
      resolveLedgerSyncConfig({
        LEDGER_SYNC_ENABLED: "true",
        NEXTCLOUD_BASE_URL: "https://x",
      })
    ).toBeNull();
  });

  it("reuses the NEXTCLOUD_* credentials and defaults the register ids", () => {
    const cfg = resolveLedgerSyncConfig({ ...nextcloud, LEDGER_SYNC_ENABLED: "true" });
    expect(cfg).toEqual({
      nextcloud: { baseUrl: "https://cloud.test", username: "svc", appPassword: "p" },
      registerId: "1",
      invoiceSchemaId: "9",
    });
  });

  it("honors register/schema overrides", () => {
    const cfg = resolveLedgerSyncConfig({
      ...nextcloud,
      LEDGER_SYNC_ENABLED: "true",
      OPENREGISTER_REGISTER_ID: "3",
      OPENREGISTER_INVOICE_SCHEMA_ID: "12",
    });
    expect(cfg?.registerId).toBe("3");
    expect(cfg?.invoiceSchemaId).toBe("12");
  });
});

describe("syncInvoicePaid", () => {
  it("is a no-op when the integration is not configured", async () => {
    const stripe = fakeStripe();
    await syncInvoicePaid(stripe, invoice(), logger);
    expect(nc.calls).toHaveLength(0);
    expect(stripe.invoicePayments.list).not.toHaveBeenCalled();
  });

  it("skips connected-account invoices", async () => {
    enableSync();
    await syncInvoicePaid(fakeStripe(), invoice(), logger, "acct_123");
    expect(nc.calls).toHaveLength(0);
  });

  it("books income, fee expense, and register object on first delivery", async () => {
    enableSync();
    await syncInvoicePaid(fakeStripe(), invoice(), logger);

    const income = nc.posts("/fiscal-years/1/incomes");
    expect(income).toHaveLength(1);
    expect(income[0].body).toMatchObject({
      name: "TEST-0001 — Acme Corp",
      bookedAt: PAID_AT_2026,
      amountCents: 20000,
      status: "paid",
    });
    expect(income[0].body?.description).toContain("in_test123");
    expect(income[0].body?.description).toContain("paid via card");

    const expense = nc.posts("/fiscal-years/1/expenses");
    expect(expense).toHaveLength(1);
    expect(expense[0].body).toMatchObject({ name: "Stripe fee — TEST-0001", amountCents: 610 });

    expect(nc.register).toHaveLength(1);
    expect(nc.register[0]).toMatchObject({
      stripe_invoice_id: "in_test123",
      status: "paid",
      amount_paid_cents: 20000,
      payment_method: "card",
    });
  });

  it("is idempotent: a second delivery books nothing more and updates the register in place", async () => {
    enableSync();
    await syncInvoicePaid(fakeStripe(), invoice(), logger);
    await syncInvoicePaid(fakeStripe(), invoice(), logger);

    expect(nc.incomes).toHaveLength(1);
    expect(nc.expenses).toHaveLength(1);
    expect(nc.register).toHaveLength(1);
    expect(nc.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("does not mistake an invoice whose id merely starts with this one for a booking", async () => {
    enableSync();
    nc.incomes.push({
      id: 5,
      description: "Stripe invoice in_test1234; something",
      amountCents: 1,
    });
    await syncInvoicePaid(fakeStripe(), invoice(), logger);
    expect(nc.incomes).toHaveLength(2);
  });

  it("heals a partial failure: income written, fee fails, the retry books only the fee", async () => {
    enableSync();
    nc.failNext("POST", "/fiscal-years/1/expenses");

    await expect(syncInvoicePaid(fakeStripe(), invoice(), logger)).rejects.toThrow(
      /ledger\.expenses\.create/
    );
    expect(nc.incomes).toHaveLength(1);
    expect(nc.expenses).toHaveLength(0);

    await syncInvoicePaid(fakeStripe(), invoice(), logger);

    expect(nc.incomes).toHaveLength(1);
    expect(nc.expenses).toHaveLength(1);
    expect(nc.register).toHaveLength(1);
    expect(nc.register[0].status).toBe("paid");
  });

  it("retries the register upsert when only that step failed", async () => {
    enableSync();
    nc.failNext("POST", "/openregister/api/objects");
    await expect(syncInvoicePaid(fakeStripe(), invoice(), logger)).rejects.toThrow(
      /ledger\.register\.create/
    );
    await syncInvoicePaid(fakeStripe(), invoice(), logger);
    expect(nc.incomes).toHaveLength(1);
    expect(nc.expenses).toHaveLength(1);
    expect(nc.register).toHaveLength(1);
  });

  it("throws LedgerSyncBusyError, writing nothing, while another delivery holds the invoice", async () => {
    enableSync();
    lockState.busy = true;
    await expect(syncInvoicePaid(fakeStripe(), invoice(), logger)).rejects.toBeInstanceOf(
      LedgerSyncBusyError
    );
    expect(nc.calls).toHaveLength(0);
  });

  it("finds an earlier booking past the first page of entries", async () => {
    enableSync();
    for (let i = 0; i < 450; i++) {
      nc.incomes.push({ id: 1000 + i, description: `Stripe invoice in_other${i}; x` });
    }
    nc.incomes.push({ id: 5000, description: "Stripe invoice in_test123; x; paid via card" });
    await syncInvoicePaid(fakeStripe(), invoice(), logger);
    expect(nc.posts("/fiscal-years/1/incomes")).toHaveLength(0);
  });

  it("still works against a server that ignores paging and returns everything", async () => {
    useNextcloud({ ignorePaging: true });
    enableSync();
    for (let i = 0; i < 450; i++) {
      nc.incomes.push({ id: 1000 + i, description: `Stripe invoice in_other${i}; x` });
    }
    await syncInvoicePaid(fakeStripe(), invoice(), logger);
    await syncInvoicePaid(fakeStripe(), invoice(), logger);
    expect(nc.incomes.filter((e) => String(e.description).includes("in_test123"))).toHaveLength(1);
    expect(nc.register).toHaveLength(1);
  });

  it("finds the register object past the first page and filters server-side", async () => {
    enableSync();
    for (let i = 0; i < 450; i++) {
      nc.register.push({ id: `old-${i}`, stripe_invoice_id: `in_old${i}`, status: "paid" });
    }
    nc.register.push({ id: "mine", stripe_invoice_id: "in_test123", status: "open" });
    await syncInvoicePaid(fakeStripe(), invoice(), logger);
    expect(nc.register).toHaveLength(451);
    expect(nc.calls.some((c) => c.method === "PUT" && c.url.includes("/mine"))).toBe(true);
    expect(nc.calls.some((c) => c.url.includes("stripe_invoice_id=in_test123"))).toBe(true);
  });

  it("finds an earlier booking when the server caps the page size below ours", async () => {
    useNextcloud({ maxPageSize: 50 });
    enableSync();
    for (let i = 0; i < 120; i++) {
      nc.incomes.push({ id: 1000 + i, description: `Stripe invoice in_other${i}; x` });
    }
    nc.incomes.push({ id: 5000, description: "Stripe invoice in_test123; x; paid via card" });
    for (let i = 0; i < 120; i++) {
      nc.expenses.push({ id: 7000 + i, description: `Processing fee for Stripe invoice in_o${i}` });
    }
    nc.expenses.push({ id: 9000, description: "Processing fee for Stripe invoice in_test123 (x)" });
    await syncInvoicePaid(fakeStripe(), invoice(), logger);
    expect(nc.posts("/incomes")).toHaveLength(0);
    expect(nc.posts("/expenses")).toHaveLength(0);
  });

  it("finds the register object when the server caps the page size", async () => {
    useNextcloud({ maxPageSize: 50 });
    enableSync();
    for (let i = 0; i < 120; i++) {
      nc.register.push({ id: `old-${i}`, stripe_invoice_id: `in_old${i}`, status: "paid" });
    }
    nc.register.push({ id: "mine", stripe_invoice_id: "in_test123", status: "open" });
    await syncInvoicePaid(fakeStripe(), invoice(), logger);
    expect(nc.register).toHaveLength(121);
  });

  it("throws, booking nothing, when a real payment has no balance transaction, then books the fee on retry", async () => {
    enableSync();
    const noBalanceTx = fakeStripe({
      paymentIntents: {
        retrieve: vi.fn(async () => ({
          latest_charge: { balance_transaction: null, payment_method_details: { type: "card" } },
        })),
      },
    });
    await expect(syncInvoicePaid(noBalanceTx, invoice(), logger)).rejects.toThrow(
      /balance transaction not available/
    );
    expect(nc.posts("/incomes")).toHaveLength(0);
    expect(nc.expenses).toHaveLength(0);

    await syncInvoicePaid(fakeStripe(), invoice(), logger);
    expect(nc.incomes).toHaveLength(1);
    expect(nc.expenses).toHaveLength(1);
  });

  it("throws when the payment intent has no charge yet", async () => {
    enableSync();
    const noCharge = fakeStripe({
      paymentIntents: { retrieve: vi.fn(async () => ({ latest_charge: null })) },
    });
    await expect(syncInvoicePaid(noCharge, invoice(), logger)).rejects.toThrow();
    expect(nc.calls).toHaveLength(0);
  });

  it("reads Stripe before taking the lock, so a busy invoice holds no connection while waiting on Stripe", async () => {
    enableSync();
    lockState.busy = true;
    const stripeClient = fakeStripe();
    await expect(syncInvoicePaid(stripeClient, invoice(), logger)).rejects.toBeInstanceOf(
      LedgerSyncBusyError
    );
    expect(stripeClient.invoicePayments.list).toHaveBeenCalled();
    expect(nc.calls).toHaveLength(0);
  });

  it("falls back to the event time, not the clock, when paid_at is missing", async () => {
    enableSync();
    await syncInvoicePaid(
      fakeStripe(),
      invoice({ status_transitions: { paid_at: null } }),
      logger,
      null,
      PAID_AT_2026
    );
    expect(nc.incomes[0].bookedAt).toBe(PAID_AT_2026);
  });

  it("creates the fiscal year when none covers the payment date", async () => {
    useNextcloud({ fiscalYears: [] });
    enableSync();
    const paidAt2027 = 1798790000;
    await syncInvoicePaid(
      fakeStripe(),
      invoice({ status_transitions: { paid_at: paidAt2027 } }),
      logger
    );

    const create = nc.calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/nextledger/api/fiscal-years")
    );
    expect(create?.body?.name).toBe("FY 2027");
    expect(create?.body?.isActive).toBe(false);
    expect(nc.incomes).toHaveLength(1);
  });

  it("books out-of-band payments without a fee expense", async () => {
    enableSync();
    const stripeClient = fakeStripe({
      invoicePayments: { list: vi.fn(async () => ({ data: [] })) },
    });
    await syncInvoicePaid(stripeClient, invoice(), logger);

    expect(String(nc.incomes[0].description)).toContain("out-of-band");
    expect(nc.calls.some((c) => c.url.includes("/expenses"))).toBe(false);
  });

  it("throws when Nextcloud rejects a request so the webhook can retry", async () => {
    enableSync();
    nc.failNext("GET", "/fiscal-years", 5);
    await expect(syncInvoicePaid(fakeStripe(), invoice(), logger)).rejects.toThrow(
      /Nextcloud answered 500/
    );
  });

  it("sends requests with the shared client: service account auth, a timeout, no path in errors", async () => {
    enableSync();
    await syncInvoicePaid(fakeStripe(), invoice(), logger);
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("svc:secret").toString("base64")}`
    );
    expect((init.headers as Record<string, string>)["OCS-APIRequest"]).toBe("true");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("syncInvoiceLifecycle", () => {
  it("is a no-op when the integration is not configured", async () => {
    await syncInvoiceLifecycle(invoice({ status: "open" }), logger);
    expect(nc.calls).toHaveLength(0);
  });

  it("upserts the register object without touching NextLedger", async () => {
    enableSync();
    await syncInvoiceLifecycle(invoice({ status: "open", amount_paid: 0 }), logger);
    expect(nc.register).toHaveLength(1);
    expect(nc.register[0]).toMatchObject({ stripe_invoice_id: "in_test123", status: "open" });
    expect(nc.register[0].payment_method).toBeUndefined();
    expect(nc.calls.some((c) => c.url.includes("/nextledger/"))).toBe(false);
  });

  it("does not reopen an invoice the register already shows as paid", async () => {
    enableSync();
    nc.register.push({ id: "mine", stripe_invoice_id: "in_test123", status: "paid" });
    await syncInvoiceLifecycle(invoice({ status: "open" }), logger);
    expect(nc.calls.some((c) => c.method === "PUT")).toBe(false);
    expect(nc.register[0].status).toBe("paid");
  });

  it("logs and swallows a Nextcloud failure: a status mirror never fails the webhook", async () => {
    enableSync();
    nc.failNext("GET", "/openregister/api/objects", 5);
    await expect(
      syncInvoiceLifecycle(invoice({ status: "open" }), logger)
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("logs a warning and skips when the invoice is busy", async () => {
    enableSync();
    lockState.busy = true;
    await expect(
      syncInvoiceLifecycle(invoice({ status: "open" }), logger)
    ).resolves.toBeUndefined();
    expect(nc.calls).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: "in_test123" }),
      expect.stringContaining("dropped")
    );
  });
});
