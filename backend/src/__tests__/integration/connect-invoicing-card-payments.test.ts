import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const stripeMock = vi.hoisted(() => ({
  accounts: { retrieve: vi.fn() },
  invoices: {
    create: vi.fn(),
    retrieve: vi.fn(),
    list: vi.fn(),
    finalizeInvoice: vi.fn(),
    sendInvoice: vi.fn(),
  },
  invoiceItems: { create: vi.fn(), list: vi.fn() },
  customers: { create: vi.fn(), retrieve: vi.fn(), update: vi.fn() },
}));
vi.mock("../../lib/stripe", () => ({ stripe: stripeMock }));

import { eq, inArray } from "drizzle-orm";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clients, connectCustomers, connectInvoices } from "../../db/schema";
import { hashApiKey, sha256Lookup } from "../../lib/auth";
import {
  openStripeCircuitForTests,
  resetCircuitBreakersForTests,
} from "../../lib/circuit-breakers";
import { tokenBuckets } from "../../lib/rate-limit";

const NOT_ACTIVE_MESSAGE = /card payments are not active on this connected account yet/i;
const NOT_ACTIVE_CODE = "CARD_PAYMENTS_NOT_ACTIVE";

describe("invoicing requires the card_payments capability", () => {
  let app: any;
  const clientIds: string[] = [];

  async function seedClient(cardPaymentsStatus: string | null) {
    const id = randomUUID();
    const account = `acct_cp_${id.slice(0, 8)}`;
    const apiKey = `cp_key_${randomUUID().replace(/-/g, "")}`;
    await db.insert(clients).values({
      id,
      name: "Card Payments Client",
      email: `cp-${id}@example.com`,
      apiKeyHash: await hashApiKey(apiKey),
      apiKeyLookup: sha256Lookup(apiKey),
      status: "active",
      stripeAccountId: account,
      chargesEnabled: true,
      cardPaymentsStatus,
      invoicingEnabled: true,
    });
    clientIds.push(id);
    return { id, apiKey, account };
  }

  async function seedInvoice(clientId: string, account: string) {
    const id = randomUUID();
    const stripeInvoiceId = `in_cp_${id.slice(0, 12)}`;
    await db.insert(connectCustomers).values({
      id: randomUUID(),
      clientId,
      connectedAccountId: account,
      stripeCustomerId: "cus_cp",
      externalRef: null,
      idempotencyKey: randomUUID(),
    });
    await db.insert(connectInvoices).values({
      id,
      clientId,
      connectedAccountId: account,
      stripeCustomerId: "cus_cp",
      idempotencyKey: id,
      requestHash: `req-${id}`,
      creationState: "complete",
      stripeInvoiceId,
      status: "draft",
      currency: "usd",
      subtotalCents: 1000,
      feeAmountCents: 0,
      totalCents: 1000,
      amountRemainingCents: 1000,
      lastSyncedAt: new Date(),
    });
    return { id, stripeInvoiceId };
  }

  const storedStatus = async (id: string) =>
    (await db.select().from(clients).where(eq(clients.id, id)))[0].cardPaymentsStatus;

  const create = (apiKey: string) =>
    app.inject({
      method: "POST",
      url: "/api/v1/invoices",
      headers: { "x-api-key": apiKey, "idempotency-key": randomUUID() },
      payload: {
        customerId: "cus_x",
        lines: [{ description: "Rent", unitAmountCents: 1000, quantity: 1 }],
      },
    });
  const finalize = (apiKey: string) =>
    app.inject({
      method: "POST",
      url: `/api/v1/invoices/${randomUUID()}/finalize`,
      headers: { "x-api-key": apiKey },
    });
  const send = (apiKey: string) =>
    app.inject({
      method: "POST",
      url: `/api/v1/invoices/${randomUUID()}/send`,
      headers: { "x-api-key": apiKey, "idempotency-key": randomUUID() },
    });
  const voidInvoice = (apiKey: string) =>
    app.inject({
      method: "POST",
      url: `/api/v1/invoices/${randomUUID()}/void`,
      headers: { "x-api-key": apiKey },
    });

  const noStripeInvoiceCalls = () => {
    for (const fn of Object.values(stripeMock.invoices)) expect(fn).not.toHaveBeenCalled();
    for (const fn of Object.values(stripeMock.invoiceItems)) expect(fn).not.toHaveBeenCalled();
  };

  beforeAll(async () => {
    process.env.CONNECT_INVOICING = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_1234567890";
    process.env.FRONTEND_ORIGIN = "http://localhost:5173";
    process.env.SMTP_HOST = process.env.SMTP_HOST ?? "mailhog";
    process.env.SMTP_PORT = process.env.SMTP_PORT ?? "1025";
    process.env.SMTP_USER = process.env.SMTP_USER ?? "test";
    process.env.SMTP_PASS = process.env.SMTP_PASS ?? "test";
    app = await buildServer();
  });

  afterAll(async () => {
    if (clientIds.length > 0) await db.delete(clients).where(inArray(clients.id, clientIds));
    delete process.env.CONNECT_INVOICING;
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetCircuitBreakersForTests();
    tokenBuckets.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    "inactive",
    "pending",
  ])("refuses create, finalize and send when card_payments is %s", async (status) => {
    const c = await seedClient(status);
    for (const res of [await create(c.apiKey), await finalize(c.apiKey), await send(c.apiKey)]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe(NOT_ACTIVE_CODE);
      expect(res.json().error).toMatch(NOT_ACTIVE_MESSAGE);
    }
    expect(stripeMock.accounts.retrieve).not.toHaveBeenCalled();
    noStripeInvoiceCalls();
  });

  it("lets an active account through the guard without a live read and reaches Stripe", async () => {
    const c = await seedClient("active");
    const row = await seedInvoice(c.id, c.account);
    const open = {
      id: row.stripeInvoiceId,
      status: "open",
      total: 1000,
      amount_paid: 0,
      amount_due: 1000,
      amount_remaining: 1000,
    };
    stripeMock.invoices.retrieve.mockResolvedValueOnce(open);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/invoices/${row.stripeInvoiceId}/finalize`,
      headers: { "x-api-key": c.apiKey },
    });
    expect(res.statusCode).toBe(200);
    expect(stripeMock.invoices.retrieve).toHaveBeenCalledTimes(1);
    expect(stripeMock.accounts.retrieve).not.toHaveBeenCalled();
  });

  it("does not require the capability to void", async () => {
    const c = await seedClient("inactive");
    expect((await voidInvoice(c.apiKey)).statusCode).toBe(404);
  });

  it("reads NULL once, persists an active result and lets the request through", async () => {
    const c = await seedClient(null);
    stripeMock.accounts.retrieve.mockResolvedValueOnce({
      capabilities: { card_payments: "active" },
    });
    expect((await finalize(c.apiKey)).statusCode).toBe(404);
    expect(stripeMock.accounts.retrieve).toHaveBeenCalledTimes(1);
    expect(await storedStatus(c.id)).toBe("active");
    await finalize(c.apiKey);
    expect(stripeMock.accounts.retrieve).toHaveBeenCalledTimes(1);
  });

  it("reads NULL, persists an inactive result and refuses", async () => {
    const c = await seedClient(null);
    stripeMock.accounts.retrieve.mockResolvedValueOnce({
      capabilities: { card_payments: "inactive" },
    });
    const res = await send(c.apiKey);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(NOT_ACTIVE_MESSAGE);
    expect(await storedStatus(c.id)).toBe("inactive");
    noStripeInvoiceCalls();
  });

  it("stores unrequested and refuses when Stripe reports no card_payments capability", async () => {
    const c = await seedClient(null);
    stripeMock.accounts.retrieve.mockResolvedValueOnce({ capabilities: {} });
    const res = await create(c.apiKey);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe(NOT_ACTIVE_CODE);
    expect(await storedStatus(c.id)).toBe("unrequested");
    noStripeInvoiceCalls();
  });

  it("refuses when the webhook stores inactive between the live read and the write", async () => {
    const c = await seedClient(null);
    stripeMock.accounts.retrieve.mockImplementationOnce(async () => {
      await db.update(clients).set({ cardPaymentsStatus: "inactive" }).where(eq(clients.id, c.id));
      return { capabilities: { card_payments: "active" } };
    });
    const res = await create(c.apiKey);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe(NOT_ACTIVE_CODE);
    expect(await storedStatus(c.id)).toBe("inactive");
    noStripeInvoiceCalls();
  });

  it("fails closed when the live read fails", async () => {
    const c = await seedClient(null);
    stripeMock.accounts.retrieve.mockRejectedValueOnce(new Error("stripe down"));
    const res = await create(c.apiKey);
    expect(res.statusCode).toBe(502);
    expect(await storedStatus(c.id)).toBeNull();
    noStripeInvoiceCalls();
  });

  it("fails closed with the transient error while the Stripe circuit is open", async () => {
    const c = await seedClient(null);
    openStripeCircuitForTests();
    const res = await create(c.apiKey);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("STRIPE_CIRCUIT_OPEN");
    expect(stripeMock.accounts.retrieve).not.toHaveBeenCalled();
    noStripeInvoiceCalls();
  });
});
