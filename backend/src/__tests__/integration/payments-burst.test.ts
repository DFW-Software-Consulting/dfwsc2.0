import { randomUUID } from "node:crypto";
import { vi } from "vitest";

vi.mock("../../lib/stripe", () => ({
  stripe: {
    checkout: { sessions: { create: vi.fn() } },
  },
}));

import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clients, paymentLedger } from "../../db/schema";
import { hashApiKey, sha256Lookup } from "../../lib/auth";
import { resetCircuitBreakersForTests } from "../../lib/circuit-breakers";
import {
  PAYMENT_CREATE_BUCKET_CAPACITY,
  PAYMENT_CREATE_REFILL_PER_MINUTE,
} from "../../lib/constants";
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
});
