import { randomUUID } from "node:crypto";
import { vi } from "vitest";

vi.mock("../../lib/stripe", () => ({
  stripe: {
    checkout: { sessions: { create: vi.fn() } },
  },
}));

import { eq, inArray } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clients, paymentLedger } from "../../db/schema";
import { hashApiKey, sha256Lookup } from "../../lib/auth";
import {
  configureStripeConcurrencyForTests,
  openStripeCircuitForTests,
  resetCircuitBreakersForTests,
  resetStripeConcurrencyForTests,
  withStripeCircuit,
} from "../../lib/circuit-breakers";
import {
  PAYMENT_CREATE_BUCKET_CAPACITY,
  PAYMENT_CREATE_REFILL_PER_MINUTE,
} from "../../lib/constants";
import { tokenBuckets } from "../../lib/rate-limit";
import { stripe } from "../../lib/stripe";

const mockCreate = stripe.checkout.sessions.create as ReturnType<typeof vi.fn>;

// Rent day: one building's key creates a checkout per tenant click, all at once. The bucket
// must absorb the whole burst, refuse only what exceeds it, and say when to come back.
describe("POST /payments/create burst handling (token bucket)", () => {
  let app: any;
  const clientIds: string[] = [];

  async function seedBuilding(name: string) {
    const id = randomUUID();
    const apiKey = `burst_key_${randomUUID().replace(/-/g, "")}`;
    await db.insert(clients).values({
      id,
      name,
      email: `burst-${id}@example.com`,
      apiKeyHash: await hashApiKey(apiKey),
      apiKeyLookup: sha256Lookup(apiKey),
      status: "active",
      stripeAccountId: `acct_burst_${id.slice(0, 8)}`,
      chargesEnabled: true,
      processingFeeCents: 100,
    });
    clientIds.push(id);
    return { id, apiKey };
  }

  function createCheckout(apiKey: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: { "x-api-key": apiKey, "idempotency-key": `rent-${randomUUID()}` },
      payload: {
        lineItems: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: "Rent" },
              unit_amount: 150_000,
            },
            quantity: 1,
          },
        ],
      },
    });
  }

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_1234567890";
    process.env.FRONTEND_ORIGIN = "http://localhost:5173";
    process.env.SMTP_HOST = process.env.SMTP_HOST ?? "mailhog";
    process.env.SMTP_PORT = process.env.SMTP_PORT ?? "1025";
    process.env.SMTP_USER = process.env.SMTP_USER ?? "test";
    process.env.SMTP_PASS = process.env.SMTP_PASS ?? "test";
    app = await buildServer();
  });

  afterAll(async () => {
    if (clientIds.length > 0) {
      await db.delete(paymentLedger).where(inArray(paymentLedger.clientId, clientIds));
      await db.delete(clients).where(inArray(clients.id, clientIds));
    }
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetCircuitBreakersForTests();
    // Freeze only the clock so the bucket's refill is exact: a 200-request burst takes real
    // seconds, which would otherwise refill a few tokens mid-test and blur the 201st request.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T09:00:00Z"));
    mockCreate.mockImplementation(async () => {
      const id = `cs_test_${randomUUID().replace(/-/g, "")}`;
      return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetStripeConcurrencyForTests();
  });

  it("is configured for a 200 burst refilling at 2 per second", () => {
    expect(PAYMENT_CREATE_BUCKET_CAPACITY).toBe(200);
    expect(PAYMENT_CREATE_REFILL_PER_MINUTE).toBe(120);
  });

  it("admits a burst of 200 for one building, then refuses the 201st with Retry-After", async () => {
    const building = await seedBuilding("Burst Building");

    const statuses: number[] = [];
    // Concurrent waves, like tenants clicking at the same moment.
    for (let wave = 0; wave < 4; wave++) {
      const responses = await Promise.all(
        Array.from({ length: 50 }, () => createCheckout(building.apiKey))
      );
      statuses.push(...responses.map((r: any) => r.statusCode));
    }
    expect(statuses).toHaveLength(200);
    expect(statuses.every((s) => s === 201)).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(200);

    const refused = await createCheckout(building.apiKey);
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBe("1");
    expect(refused.json()).toEqual({ error: "Too Many Requests", code: "RATE_LIMITED" });
    // A refused request never reaches Stripe.
    expect(mockCreate).toHaveBeenCalledTimes(200);
  }, 60_000);

  it("admits the retry after the advertised wait, at the sustained refill rate", async () => {
    const building = await seedBuilding("Refill Building");

    await Promise.all(Array.from({ length: 200 }, () => createCheckout(building.apiKey)));
    const refused = await createCheckout(building.apiKey);
    expect(refused.statusCode).toBe(429);

    vi.advanceTimersByTime(Number(refused.headers["retry-after"]) * 1000); // 1 s: 2 tokens
    const first = await createCheckout(building.apiKey);
    const second = await createCheckout(building.apiKey);
    const third = await createCheckout(building.apiKey);
    expect([first.statusCode, second.statusCode, third.statusCode]).toEqual([201, 201, 429]);
  }, 60_000);

  it("keeps the limit per building: one drained building does not affect another", async () => {
    const drained = await seedBuilding("Drained Building");
    const other = await seedBuilding("Other Building");

    await Promise.all(Array.from({ length: 200 }, () => createCheckout(drained.apiKey)));
    expect((await createCheckout(drained.apiKey)).statusCode).toBe(429);

    expect((await createCheckout(other.apiKey)).statusCode).toBe(201);
  }, 60_000);

  it("does not charge the bucket for requests rejected by authentication", async () => {
    const building = await seedBuilding("Auth Building");
    for (let i = 0; i < 5; i++) {
      const bad = await createCheckout("not-a-real-key");
      expect(bad.statusCode).toBe(401);
    }
    // The building's full capacity is still available.
    const responses = await Promise.all(
      Array.from({ length: 200 }, () => createCheckout(building.apiKey))
    );
    expect(responses.every((r: any) => r.statusCode === 201)).toBe(true);
  }, 60_000);

  it("leaves no ledger rows behind for refused requests", async () => {
    const building = await seedBuilding("Ledger Building");
    await Promise.all(Array.from({ length: 200 }, () => createCheckout(building.apiKey)));
    expect((await createCheckout(building.apiKey)).statusCode).toBe(429);

    const rows = await db
      .select()
      .from(paymentLedger)
      .where(eq(paymentLedger.clientId, building.id));
    expect(rows).toHaveLength(200);
  }, 60_000);

  // A request refused because Stripe had no free slot (or the circuit was open) never reached
  // Stripe, and the caller is told to retry it. The refusal must not cost a token, or the retried
  // tail of a large burst would be refused by the portal's own limit.
  describe("refusals that never reached Stripe", () => {
    const BURST = PAYMENT_CREATE_BUCKET_CAPACITY;

    async function burst(apiKey: string, count = BURST) {
      const responses = await Promise.all(
        Array.from({ length: count }, () => createCheckout(apiKey))
      );
      return responses.map((r: any) => r);
    }

    it("leaves the tokens available after a drained burst is refused as STRIPE_BUSY", async () => {
      const building = await seedBuilding("Busy Refund Building");
      configureStripeConcurrencyForTests({ maxConcurrent: 1, maxWaiting: 0, maxWaitMs: 10_000 });
      const gate = new Promise<string>(() => {});
      void withStripeCircuit(() => gate);

      // Every request in the burst takes a token, then is refused for want of a Stripe slot.
      const busy = await burst(building.apiKey);
      expect(busy.every((r) => r.statusCode === 503 && r.json().code === "STRIPE_BUSY")).toBe(true);
      expect(mockCreate).not.toHaveBeenCalled();

      // Slots are free again: the full retried burst succeeds and is only then refused.
      resetStripeConcurrencyForTests();
      const retried = await burst(building.apiKey);
      expect(retried.every((r) => r.statusCode === 201)).toBe(true);
      expect(mockCreate).toHaveBeenCalledTimes(BURST);
      expect((await createCheckout(building.apiKey)).statusCode).toBe(429);
    }, 60_000);

    it("leaves the tokens available after refusals from an open Stripe circuit", async () => {
      const building = await seedBuilding("Circuit Refund Building");
      openStripeCircuitForTests();

      const refused = await burst(building.apiKey);
      expect(refused.every((r) => r.statusCode === 503)).toBe(true);
      expect(mockCreate).not.toHaveBeenCalled();

      resetCircuitBreakersForTests();
      const retried = await burst(building.apiKey);
      expect(retried.every((r) => r.statusCode === 201)).toBe(true);
      expect((await createCheckout(building.apiKey)).statusCode).toBe(429);
    }, 60_000);

    it("keeps the token of a request Stripe answered with 429", async () => {
      const building = await seedBuilding("Stripe 429 Building");
      mockCreate.mockRejectedValue(
        Stripe.errors.StripeError.generate({
          type: "rate_limit_error",
          statusCode: 429,
          message: "Too many requests hit the API too quickly.",
        } as never)
      );

      const answered = await burst(building.apiKey);
      expect(answered.every((r) => r.statusCode === 429)).toBe(true);
      expect(mockCreate).toHaveBeenCalledTimes(BURST);

      // The bucket is empty: this refusal is the portal's own, and Stripe is not called again.
      const refused = await createCheckout(building.apiKey);
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toEqual({ error: "Too Many Requests", code: "RATE_LIMITED" });
      expect(mockCreate).toHaveBeenCalledTimes(BURST);
    }, 60_000);

    it("keeps the token of a request that failed validation", async () => {
      const building = await seedBuilding("Validation Building");

      const invalid = await Promise.all(
        Array.from({ length: BURST }, () =>
          app.inject({
            method: "POST",
            url: "/api/v1/payments/create",
            headers: { "x-api-key": building.apiKey, "idempotency-key": `rent-${randomUUID()}` },
            payload: { lineItems: [] },
          })
        )
      );
      expect(invalid.every((r: any) => r.statusCode === 400)).toBe(true);

      expect((await createCheckout(building.apiKey)).statusCode).toBe(429);
      expect(mockCreate).not.toHaveBeenCalled();
    }, 60_000);

    it("keeps the token when the Stripe call itself timed out", async () => {
      const building = await seedBuilding("Timeout Building");
      // The call goes out and never answers; the breaker gives up on it after its own timeout.
      // That surfaces as a circuit error, but Stripe was called, so the token stays spent.
      mockCreate.mockImplementation(() => new Promise(() => {}));
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(new Date("2026-11-01T09:00:00Z"));

      const pending = createCheckout(building.apiKey);
      await vi.waitFor(() => expect(mockCreate).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(26_000);
      expect((await pending).statusCode).toBe(503);

      // The date is frozen, so the bucket holds exactly the capacity minus the one token taken.
      const bucketKey = `ratelimit:bucket:POST:/api/v1/payments/create:stripe:acct_burst_${building.id.slice(0, 8)}`;
      expect(tokenBuckets.get(bucketKey)?.tokens).toBe(BURST - 1);
    }, 60_000);
  });
});
