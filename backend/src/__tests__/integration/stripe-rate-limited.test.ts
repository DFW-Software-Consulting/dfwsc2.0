import { randomUUID } from "node:crypto";
import { vi } from "vitest";

vi.mock("../../lib/stripe", () => ({
  stripe: {
    checkout: { sessions: { create: vi.fn() } },
  },
}));

import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clients, paymentLedger } from "../../db/schema";
import { hashApiKey, sha256Lookup } from "../../lib/auth";
import { getCircuitBreakerStates, resetCircuitBreakersForTests } from "../../lib/circuit-breakers";
import { stripe } from "../../lib/stripe";

const mockCreate = stripe.checkout.sessions.create as ReturnType<typeof vi.fn>;

function stripeRateLimitError() {
  return Stripe.errors.StripeError.generate({
    type: "rate_limit_error",
    statusCode: 429,
    message: "Too many requests hit the API too quickly.",
  } as never);
}

describe("POST /payments/create when Stripe answers 429", () => {
  let app: any;
  let apiKey: string;
  let clientId: string;

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_1234567890";
    process.env.FRONTEND_ORIGIN = "http://localhost:5173";
    process.env.SMTP_HOST = process.env.SMTP_HOST ?? "mailhog";
    process.env.SMTP_PORT = process.env.SMTP_PORT ?? "1025";
    process.env.SMTP_USER = process.env.SMTP_USER ?? "test";
    process.env.SMTP_PASS = process.env.SMTP_PASS ?? "test";
    app = await buildServer();

    clientId = randomUUID();
    apiKey = `rl_key_${randomUUID().replace(/-/g, "")}`;
    await db.insert(clients).values({
      id: clientId,
      name: "Rate Limited Building",
      email: `rl-${clientId}@example.com`,
      apiKeyHash: await hashApiKey(apiKey),
      apiKeyLookup: sha256Lookup(apiKey),
      status: "active",
      stripeAccountId: `acct_rl_${clientId.slice(0, 8)}`,
      chargesEnabled: true,
      processingFeeCents: 100,
    });
  });

  afterAll(async () => {
    await db.delete(paymentLedger).where(eq(paymentLedger.clientId, clientId));
    await db.delete(clients).where(eq(clients.id, clientId));
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetCircuitBreakersForTests();
  });

  function createCheckout() {
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

  it("answers 429 RATE_LIMITED with Retry-After 2, however many times, without opening the breaker", async () => {
    mockCreate.mockRejectedValue(stripeRateLimitError());

    for (let i = 0; i < 10; i++) {
      const response = await createCheckout();
      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toBe("2");
      expect(response.json()).toEqual({
        error: "Payment service is busy. Please retry.",
        code: "RATE_LIMITED",
      });
    }

    const state = getCircuitBreakerStates().stripe;
    expect(state.open).toBe(false);
    expect(state.failures).toBe(0);
    // Every request still reached Stripe: none was short-circuited by an open breaker.
    expect(mockCreate).toHaveBeenCalledTimes(10);

    // As soon as Stripe stops limiting, the next request succeeds. With a tripped breaker it
    // would have been a 503 STRIPE_CIRCUIT_OPEN for the next 30 seconds.
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({
      id: `cs_test_${randomUUID().replace(/-/g, "")}`,
      url: "https://checkout.stripe.com/c/pay/ok",
    });
    expect((await createCheckout()).statusCode).toBe(201);
  });

  it("still answers 503 STRIPE_CIRCUIT_OPEN after five consecutive Stripe 5xx errors", async () => {
    mockCreate.mockRejectedValue(
      Stripe.errors.StripeError.generate({
        type: "api_error",
        statusCode: 500,
        message: "Stripe is down",
      } as never)
    );

    for (let i = 0; i < 5; i++) {
      expect((await createCheckout()).statusCode).toBe(502);
    }
    const open = await createCheckout();
    expect(open.statusCode).toBe(503);
    expect(open.json().code).toBe("STRIPE_CIRCUIT_OPEN");
  });
});
