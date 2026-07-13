import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { FastifyBaseLogger } from "fastify";
import {
  resolveLedgerSyncConfig,
  syncInvoiceLifecycle,
  syncInvoicePaid,
} from "../../lib/ledger-sync";

vi.mock("../../lib/circuit-breakers", () => ({
  withStripeCircuit: <T>(fn: () => Promise<T>) => fn(),
}));

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as unknown as FastifyBaseLogger;

// FY 2026 in the ledger: 2026-01-01T00:00:00-06:00 .. 2026-12-31T23:59:59-06:00
const FY_2026 = { id: 1, name: "FY 2026", dateStart: 1767247200, dateEnd: 1798783199, isActive: true };
const PAID_AT_2026 = 1767250000; // inside FY 2026

interface RecordedCall {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

let calls: RecordedCall[];
let responders: Array<{
  match: (method: string, url: string) => boolean;
  respond: (body?: Record<string, unknown>) => unknown;
}>;

function respondWith(method: string, urlPart: string, payload: unknown | ((body?: Record<string, unknown>) => unknown)) {
  responders.push({
    match: (m, u) => m === method && u.includes(urlPart),
    respond: typeof payload === "function" ? (payload as (body?: Record<string, unknown>) => unknown) : () => payload,
  });
}

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
      calls.push({ method, url, body });
      const responder = responders.find((r) => r.match(method, url));
      if (!responder) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => responder.respond(body) };
    })
  );
}

function fakeStripe(overrides: Partial<Record<"invoicePayments" | "paymentIntents" | "charges", unknown>> = {}): Stripe {
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
    lines: { data: [{ description: "1 × Development (at $200.00 / week)", quantity: 1, amount: 20000 }] },
    metadata: {},
    ...overrides,
  } as unknown as Stripe.Invoice;
}

function enableSync() {
  vi.stubEnv("NEXTCLOUD_URL", "https://cloud.test");
  vi.stubEnv("NEXTCLOUD_LEDGER_USER", "ledger-bot");
  vi.stubEnv("NEXTCLOUD_APP_PASSWORD", "secret");
}

beforeEach(() => {
  calls = [];
  responders = [];
  installFetchMock();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("resolveLedgerSyncConfig", () => {
  it("returns null when credentials are incomplete", () => {
    expect(resolveLedgerSyncConfig({})).toBeNull();
    expect(resolveLedgerSyncConfig({ NEXTCLOUD_URL: "https://x" })).toBeNull();
    expect(
      resolveLedgerSyncConfig({ NEXTCLOUD_URL: "https://x", NEXTCLOUD_LEDGER_USER: "u" })
    ).toBeNull();
  });

  it("returns config with defaults and strips trailing slashes", () => {
    const cfg = resolveLedgerSyncConfig({
      NEXTCLOUD_URL: "https://cloud.test///",
      NEXTCLOUD_LEDGER_USER: "u",
      NEXTCLOUD_APP_PASSWORD: "p",
    });
    expect(cfg).toEqual({
      baseUrl: "https://cloud.test",
      user: "u",
      appPassword: "p",
      registerId: "1",
      invoiceSchemaId: "9",
    });
  });

  it("honors register/schema overrides", () => {
    const cfg = resolveLedgerSyncConfig({
      NEXTCLOUD_URL: "https://cloud.test",
      NEXTCLOUD_LEDGER_USER: "u",
      NEXTCLOUD_APP_PASSWORD: "p",
      OPENREGISTER_REGISTER_ID: "3",
      OPENREGISTER_INVOICE_SCHEMA_ID: "12",
    });
    expect(cfg?.registerId).toBe("3");
    expect(cfg?.invoiceSchemaId).toBe("12");
  });
});

describe("syncInvoicePaid", () => {
  it("is a no-op when the integration is not configured", async () => {
    await syncInvoicePaid(fakeStripe(), invoice(), logger);
    expect(calls).toHaveLength(0);
  });

  it("skips connected-account invoices", async () => {
    enableSync();
    await syncInvoicePaid(fakeStripe(), invoice(), logger, "acct_123");
    expect(calls).toHaveLength(0);
  });

  it("books income, fee expense, and register object on first delivery", async () => {
    enableSync();
    respondWith("GET", "/nextledger/api/fiscal-years/1/incomes", []);
    respondWith("GET", "/nextledger/api/fiscal-years/1/expenses", []);
    respondWith("GET", "/nextledger/api/fiscal-years", [FY_2026]);
    respondWith("POST", "/nextledger/api/fiscal-years/1/incomes", { id: 100 });
    respondWith("POST", "/nextledger/api/fiscal-years/1/expenses", { id: 200 });
    respondWith("GET", "/openregister/api/objects/1/9", { results: [] });
    respondWith("POST", "/openregister/api/objects/1/9", { id: "uuid-1" });

    await syncInvoicePaid(fakeStripe(), invoice(), logger);

    const incomePost = calls.find(
      (c) => c.method === "POST" && c.url.includes("/fiscal-years/1/incomes")
    );
    expect(incomePost?.body).toMatchObject({
      name: "TEST-0001 — Acme Corp",
      bookedAt: PAID_AT_2026,
      amountCents: 20000,
      status: "paid",
    });
    expect(incomePost?.body?.description).toContain("in_test123");
    expect(incomePost?.body?.description).toContain("paid via card");

    const expensePost = calls.find(
      (c) => c.method === "POST" && c.url.includes("/fiscal-years/1/expenses")
    );
    expect(expensePost?.body).toMatchObject({ name: "Stripe fee — TEST-0001", amountCents: 610 });

    const registerPost = calls.find(
      (c) => c.method === "POST" && c.url.includes("/openregister/api/objects/1/9")
    );
    expect(registerPost?.body).toMatchObject({
      stripe_invoice_id: "in_test123",
      status: "paid",
      amount_paid_cents: 20000,
      payment_method: "card",
    });
  });

  it("skips already-booked entries and updates the existing register object", async () => {
    enableSync();
    respondWith("GET", "/nextledger/api/fiscal-years/1/incomes", [
      { id: 5, name: "x", description: "Stripe invoice in_test123; ...", bookedAt: 1, amountCents: 1 },
    ]);
    respondWith("GET", "/nextledger/api/fiscal-years/1/expenses", [
      { id: 6, name: "x", description: "Processing fee for Stripe invoice in_test123", bookedAt: 1, amountCents: 1 },
    ]);
    respondWith("GET", "/nextledger/api/fiscal-years", [FY_2026]);
    respondWith("GET", "/openregister/api/objects/1/9", {
      results: [{ id: "uuid-existing", stripe_invoice_id: "in_test123" }],
    });
    respondWith("PUT", "/openregister/api/objects/1/9/uuid-existing", { id: "uuid-existing" });

    await syncInvoicePaid(fakeStripe(), invoice(), logger);

    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("uuid-existing");
    expect(put?.body).toMatchObject({ stripe_invoice_id: "in_test123", status: "paid" });
  });

  it("creates the fiscal year when none covers the payment date", async () => {
    enableSync();
    const fy2027 = { id: 2, name: "FY 2027", dateStart: 1798783200, dateEnd: 1830319199, isActive: false };
    respondWith("GET", "/nextledger/api/fiscal-years/2/incomes", []);
    respondWith("GET", "/nextledger/api/fiscal-years/2/expenses", []);
    respondWith("GET", "/nextledger/api/fiscal-years", []);
    respondWith("POST", "/nextledger/api/fiscal-years", fy2027);
    respondWith("POST", "/nextledger/api/fiscal-years/2/incomes", { id: 1 });
    respondWith("POST", "/nextledger/api/fiscal-years/2/expenses", { id: 2 });
    respondWith("GET", "/openregister/api/objects/1/9", { results: [] });
    respondWith("POST", "/openregister/api/objects/1/9", { id: "uuid-2" });

    const paidAt2027 = 1798790000;
    await syncInvoicePaid(
      fakeStripe(),
      invoice({ status_transitions: { paid_at: paidAt2027 } }),
      logger
    );

    const fyCreate = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/nextledger/api/fiscal-years")
    );
    expect(fyCreate?.body?.name).toBe("FY 2027");
    expect(fyCreate?.body?.isActive).toBe(false);
    expect(
      calls.some((c) => c.method === "POST" && c.url.includes("/fiscal-years/2/incomes"))
    ).toBe(true);
  });

  it("books out-of-band payments without a fee expense", async () => {
    enableSync();
    respondWith("GET", "/nextledger/api/fiscal-years/1/incomes", []);
    respondWith("GET", "/nextledger/api/fiscal-years", [FY_2026]);
    respondWith("POST", "/nextledger/api/fiscal-years/1/incomes", { id: 1 });
    respondWith("GET", "/openregister/api/objects/1/9", { results: [] });
    respondWith("POST", "/openregister/api/objects/1/9", { id: "uuid-3" });

    const stripeClient = fakeStripe({
      invoicePayments: { list: vi.fn(async () => ({ data: [] })) },
    });
    await syncInvoicePaid(stripeClient, invoice(), logger);

    const incomePost = calls.find(
      (c) => c.method === "POST" && c.url.includes("/fiscal-years/1/incomes")
    );
    expect(incomePost?.body?.description).toContain("out-of-band");
    expect(calls.some((c) => c.url.includes("/expenses"))).toBe(false);
  });

  it("throws when Nextcloud rejects a request so the webhook can retry", async () => {
    enableSync();
    // No responders registered → fetch mock returns 404 for everything.
    await expect(syncInvoicePaid(fakeStripe(), invoice(), logger)).rejects.toThrow(
      /Nextcloud request failed/
    );
  });
});

describe("syncInvoiceLifecycle", () => {
  it("is a no-op when the integration is not configured", async () => {
    await syncInvoiceLifecycle(invoice({ status: "open" }), logger);
    expect(calls).toHaveLength(0);
  });

  it("upserts the register object without touching NextLedger", async () => {
    enableSync();
    respondWith("GET", "/openregister/api/objects/1/9", { results: [] });
    respondWith("POST", "/openregister/api/objects/1/9", { id: "uuid-4" });

    await syncInvoiceLifecycle(
      invoice({ status: "open", amount_paid: 0, status_transitions: { paid_at: null } }),
      logger
    );

    expect(calls.some((c) => c.url.includes("/nextledger/"))).toBe(false);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({ stripe_invoice_id: "in_test123", status: "open" });
    expect(post?.body?.paid_at).toBeUndefined();
  });
});
