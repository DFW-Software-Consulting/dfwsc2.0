import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/stripe", () => ({
  stripe: {
    accounts: { retrieve: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    paymentIntents: { create: vi.fn(), list: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
  },
}));

import { eq } from "drizzle-orm";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clients } from "../../db/schema";
import { hashApiKey, sha256Lookup } from "../../lib/auth";
import {
  configureStripeConcurrencyForTests,
  openStripeCircuitForTests,
  resetCircuitBreakersForTests,
  resetStripeConcurrencyForTests,
  withStripeCircuit,
} from "../../lib/circuit-breakers";
import { tokenBuckets } from "../../lib/rate-limit";
import { stripe } from "../../lib/stripe";

describe("POST /api/v1/payments/create requires the card_payments capability", () => {
  let app: any;
  let release: () => void = () => undefined;
  const clientIds: string[] = [];

  async function seedClient(cardPaymentsStatus: string | null) {
    const id = randomUUID();
    const account = `acct_cpc_${id.slice(0, 8)}`;
    const apiKey = randomUUID().replace(/-/g, "");
    await db.insert(clients).values({
      id,
      name: "Card Payments Checkout Client",
      email: `cpc-${id}@example.com`,
      apiKeyHash: await hashApiKey(apiKey),
      apiKeyLookup: sha256Lookup(apiKey),
      status: "active",
      stripeAccountId: account,
      chargesEnabled: true,
      cardPaymentsStatus,
      processingFeeCents: 100,
    });
    clientIds.push(id);
    return { id, apiKey, account };
  }

  const storedStatus = async (id: string) =>
    (await db.select().from(clients).where(eq(clients.id, id)))[0].cardPaymentsStatus;

  const pay = (apiKey: string) =>
    app.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: {
        "x-api-key": apiKey,
        "idempotency-key": randomUUID(),
        "content-type": "application/json",
      },
      payload: {
        lineItems: [
          {
            price_data: { currency: "usd", product_data: { name: "Rent" }, unit_amount: 5000 },
            quantity: 1,
          },
        ],
      },
    });

  beforeAll(async () => {
    process.env.FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:5173";
    process.env.SMTP_HOST = process.env.SMTP_HOST ?? "mailhog";
    process.env.SMTP_PORT = process.env.SMTP_PORT ?? "1025";
    process.env.SMTP_USER = process.env.SMTP_USER ?? "test";
    process.env.SMTP_PASS = process.env.SMTP_PASS ?? "test";
    app = await buildServer();
  });

  afterAll(async () => {
    for (const id of clientIds) await db.delete(clients).where(eq(clients.id, id));
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.mocked(stripe.accounts.retrieve).mockReset();
    vi.mocked(stripe.checkout.sessions.create).mockReset();
    vi.mocked(stripe.checkout.sessions.create).mockResolvedValue({
      id: `cs_test_${randomUUID().replace(/-/g, "")}`,
      url: "https://checkout.stripe.com/c/pay/test",
    } as never);
    resetCircuitBreakersForTests();
  });

  afterEach(() => {
    resetStripeConcurrencyForTests();
    resetCircuitBreakersForTests();
  });

  it.each([
    "inactive",
    "pending",
    "unrequested",
  ])("refuses with 409 CARD_PAYMENTS_NOT_ACTIVE when card_payments is %s", async (status) => {
    const c = await seedClient(status);
    const res = await pay(c.apiKey);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error:
        "Card payments are not active on this connected account yet. Contact your DFWSC administrator.",
      code: "CARD_PAYMENTS_NOT_ACTIVE",
    });
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripe.accounts.retrieve).not.toHaveBeenCalled();
  });

  it("creates the Checkout session when card_payments is active, without a live read", async () => {
    const c = await seedClient("active");
    const res = await pay(c.apiKey);
    expect(res.statusCode).toBe(201);
    expect(res.json().url).toBe("https://checkout.stripe.com/c/pay/test");
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(stripe.accounts.retrieve).not.toHaveBeenCalled();
  });

  it("reads NULL live once, stores it and proceeds when it is active", async () => {
    const c = await seedClient(null);
    vi.mocked(stripe.accounts.retrieve).mockResolvedValueOnce({
      capabilities: { card_payments: "active" },
    } as never);
    const res = await pay(c.apiKey);
    expect(res.statusCode).toBe(201);
    expect(stripe.accounts.retrieve).toHaveBeenCalledTimes(1);
    expect(await storedStatus(c.id)).toBe("active");
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });

  it("reads NULL live, stores unrequested and refuses without calling Checkout", async () => {
    const c = await seedClient(null);
    vi.mocked(stripe.accounts.retrieve).mockResolvedValueOnce({ capabilities: {} } as never);
    const res = await pay(c.apiKey);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("CARD_PAYMENTS_NOT_ACTIVE");
    expect(await storedStatus(c.id)).toBe("unrequested");
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("fails closed with 502 when the live read fails", async () => {
    const c = await seedClient(null);
    vi.mocked(stripe.accounts.retrieve).mockRejectedValueOnce(new Error("stripe down"));
    const res = await pay(c.apiKey);
    expect(res.statusCode).toBe(502);
    expect(await storedStatus(c.id)).toBeNull();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  // The write token taken by the route's rate limiter, read from the in-memory bucket store.
  const tokensOf = (account: string) => {
    const entry = [...tokenBuckets.entries()].find(([key]) => key.endsWith(`:${account}`));
    return entry?.[1].tokens as number;
  };

  /** Takes (and keeps) one token so the bucket exists, then puts the status back to NULL. */
  async function primeBucket() {
    const c = await seedClient(null);
    vi.mocked(stripe.accounts.retrieve).mockResolvedValueOnce({
      capabilities: { card_payments: "active" },
    } as never);
    expect((await pay(c.apiKey)).statusCode).toBe(201);
    await db.update(clients).set({ cardPaymentsStatus: null }).where(eq(clients.id, c.id));
    vi.mocked(stripe.accounts.retrieve).mockClear();
    vi.mocked(stripe.checkout.sessions.create).mockClear();
    return c;
  }

  it("fails closed with 503 STRIPE_CIRCUIT_OPEN and refunds the rate-limit token", async () => {
    const c = await primeBucket();
    const before = tokensOf(c.account);
    openStripeCircuitForTests();
    const res = await pay(c.apiKey);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("STRIPE_CIRCUIT_OPEN");
    expect(stripe.accounts.retrieve).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    // Refunded: the count is back where it was (a spent token would leave it a whole one lower).
    expect(tokensOf(c.account)).toBeGreaterThanOrEqual(before);
  });

  it("fails closed with 503 STRIPE_BUSY and refunds the rate-limit token", async () => {
    const c = await primeBucket();
    const before = tokensOf(c.account);
    configureStripeConcurrencyForTests({ maxConcurrent: 1, maxWaiting: 0, maxWaitMs: 10_000 });
    const gate = new Promise<string>((resolve) => {
      release = () => resolve("done");
    });
    const slot = withStripeCircuit(() => gate);
    const res = await pay(c.apiKey);
    release();
    await slot;
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("STRIPE_BUSY");
    expect(stripe.accounts.retrieve).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(tokensOf(c.account)).toBeGreaterThanOrEqual(before);
  });
});
