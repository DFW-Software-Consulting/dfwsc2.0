import { randomUUID } from "node:crypto";
import { vi } from "vitest";

vi.mock("../../lib/stripe", () => ({
  stripe: {
    webhooks: { constructEvent: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    accounts: { retrieve: vi.fn() },
  },
}));

import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clients, paymentLedger, webhookEvents } from "../../db/schema";
import { hashApiKey, sha256Lookup } from "../../lib/auth";
import {
  configureStripeConcurrencyForTests,
  getCircuitBreakerStates,
  getStripeConcurrencyForTests,
  resetCircuitBreakersForTests,
  resetStripeConcurrencyForTests,
  withStripeCircuit,
} from "../../lib/circuit-breakers";
import { stripe } from "../../lib/stripe";

const mockCreate = stripe.checkout.sessions.create as ReturnType<typeof vi.fn>;
const mockConstructEvent = stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>;
const mockAccountsRetrieve = stripe.accounts.retrieve as ReturnType<typeof vi.fn>;

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// A Stripe call that never finishes until the test says so: it occupies a concurrency slot.
function occupySlot() {
  const gate = deferred<string>();
  const call = withStripeCircuit(() => gate.promise);
  return { release: () => gate.resolve("done"), call };
}

describe("Stripe concurrency limit at the routes (STRIPE_BUSY)", () => {
  let app: any;
  let apiKey: string;
  let clientId: string;
  const accountId = `acct_busy_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const eventIds: string[] = [];

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_1234567890";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test1234567890";
    process.env.FRONTEND_ORIGIN = "http://localhost:5173";
    process.env.SMTP_HOST = process.env.SMTP_HOST ?? "mailhog";
    process.env.SMTP_PORT = process.env.SMTP_PORT ?? "1025";
    process.env.SMTP_USER = process.env.SMTP_USER ?? "test";
    process.env.SMTP_PASS = process.env.SMTP_PASS ?? "test";
    app = await buildServer();

    clientId = randomUUID();
    apiKey = `busy_key_${randomUUID().replace(/-/g, "")}`;
    await db.insert(clients).values({
      id: clientId,
      name: "Busy Building",
      email: `busy-${clientId}@example.com`,
      apiKeyHash: await hashApiKey(apiKey),
      apiKeyLookup: sha256Lookup(apiKey),
      status: "active",
      stripeAccountId: accountId,
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
    resetStripeConcurrencyForTests();
    mockCreate.mockImplementation(async () => {
      const id = `cs_test_${randomUUID().replace(/-/g, "")}`;
      return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
    });
  });

  afterEach(async () => {
    resetStripeConcurrencyForTests();
    if (eventIds.length > 0) {
      await db.delete(webhookEvents).where(inArray(webhookEvents.stripeEventId, eventIds));
      eventIds.length = 0;
    }
  });

  function createCheckout(idempotencyKey = `rent-${randomUUID()}`) {
    return app.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: { "x-api-key": apiKey, "idempotency-key": idempotencyKey },
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

  describe("POST /payments/create", () => {
    it("answers 503 STRIPE_BUSY with Retry-After 5 when the queue is full, then succeeds on retry", async () => {
      configureStripeConcurrencyForTests({ maxConcurrent: 1, maxWaiting: 0, maxWaitMs: 10_000 });
      const slot = occupySlot();
      const key = `rent-${randomUUID()}`;

      const busy = await createCheckout(key);
      expect(busy.statusCode).toBe(503);
      expect(busy.headers["retry-after"]).toBe("5");
      expect(busy.json()).toEqual({
        error: expect.any(String),
        code: "STRIPE_BUSY",
      });
      // Nothing reached Stripe and nothing was recorded.
      expect(mockCreate).not.toHaveBeenCalled();
      const rows = await db
        .select()
        .from(paymentLedger)
        .where(eq(paymentLedger.clientId, clientId));
      expect(rows).toHaveLength(0);

      slot.release();
      await slot.call;

      // The documented client behaviour: retry with the same Idempotency-Key.
      const retried = await createCheckout(key);
      expect(retried.statusCode).toBe(201);
      expect(retried.json()).toMatchObject({ sessionId: expect.stringMatching(/^cs_test_/) });
    });

    it("answers 503 STRIPE_BUSY when a request waits longer than the wait limit", async () => {
      configureStripeConcurrencyForTests({ maxConcurrent: 1, maxWaiting: 5, maxWaitMs: 50 });
      const slot = occupySlot();

      const started = Date.now();
      const busy = await createCheckout();
      expect(Date.now() - started).toBeGreaterThanOrEqual(45);
      expect(busy.statusCode).toBe(503);
      expect(busy.headers["retry-after"]).toBe("5");
      expect(busy.json().code).toBe("STRIPE_BUSY");
      expect(mockCreate).not.toHaveBeenCalled();
      expect(getStripeConcurrencyForTests().waiting).toBe(0);

      slot.release();
      await slot.call;
    });

    it("queues a burst past the concurrency limit and completes every request", async () => {
      configureStripeConcurrencyForTests({ maxConcurrent: 2, maxWaiting: 100, maxWaitMs: 10_000 });
      let inFlight = 0;
      let peak = 0;
      mockCreate.mockImplementation(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight -= 1;
        const id = `cs_test_${randomUUID().replace(/-/g, "")}`;
        return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
      });

      const responses = await Promise.all(Array.from({ length: 12 }, () => createCheckout()));

      expect(responses.map((r: any) => r.statusCode)).toEqual(Array(12).fill(201));
      expect(mockCreate).toHaveBeenCalledTimes(12);
      expect(peak).toBeLessThanOrEqual(2);
      expect(getStripeConcurrencyForTests()).toEqual({ inFlight: 0, waiting: 0 });
    });

    it("does not open the Stripe circuit however many requests are refused as busy", async () => {
      configureStripeConcurrencyForTests({ maxConcurrent: 1, maxWaiting: 0, maxWaitMs: 10_000 });
      const slot = occupySlot();

      for (let i = 0; i < 8; i++) {
        const busy = await createCheckout();
        expect(busy.statusCode).toBe(503);
        expect(busy.json().code).toBe("STRIPE_BUSY");
      }
      const state = getCircuitBreakerStates().stripe;
      expect(state.open).toBe(false);
      expect(state.failures).toBe(0);

      slot.release();
      await slot.call;
      // A busy refusal is distinguishable from a tripped breaker.
      expect((await createCheckout()).statusCode).toBe(201);
    });
  });

  describe("POST /webhooks/stripe", () => {
    function accountUpdatedEvent() {
      const event = {
        id: `evt_${randomUUID().replace(/-/g, "")}`,
        object: "event",
        type: "account.updated",
        data: { object: { id: accountId } },
        livemode: false,
        pending_webhooks: 0,
        request: null,
        created: Math.floor(Date.now() / 1000),
      };
      eventIds.push(event.id);
      return event;
    }

    function deliver(event: ReturnType<typeof accountUpdatedEvent>) {
      mockConstructEvent.mockReturnValueOnce(event);
      return app.inject({
        method: "POST",
        url: "/api/v1/webhooks/stripe",
        body: JSON.stringify(event),
        headers: { "content-type": "application/json", "stripe-signature": "sig_test" },
      });
    }

    async function eventRow(eventId: string) {
      const [row] = await db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.stripeEventId, eventId));
      return row;
    }

    it("answers non-2xx and does not mark the event processed when it cannot get a Stripe slot", async () => {
      configureStripeConcurrencyForTests({ maxConcurrent: 1, maxWaiting: 0, maxWaitMs: 10_000 });
      mockAccountsRetrieve.mockResolvedValue({
        id: accountId,
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
      });
      const slot = occupySlot();
      const event = accountUpdatedEvent();

      const busy = await deliver(event);
      expect(busy.statusCode).toBe(503);
      expect(busy.json().code).toBe("STRIPE_BUSY");
      expect(busy.headers["retry-after"]).toBe("5");
      expect(mockAccountsRetrieve).not.toHaveBeenCalled();
      // No processed marker and no lingering claim: the next delivery processes the event.
      expect(await eventRow(event.id)).toBeUndefined();

      slot.release();
      await slot.call;

      const redelivered = await deliver(event);
      expect(redelivered.statusCode).toBe(200);
      expect(redelivered.json()).toEqual({ received: true });
      expect(mockAccountsRetrieve).toHaveBeenCalledTimes(1);
      expect((await eventRow(event.id))?.processedAt).toBeTruthy();
    });

    it("also fails when the wait for a slot times out", async () => {
      configureStripeConcurrencyForTests({ maxConcurrent: 1, maxWaiting: 5, maxWaitMs: 50 });
      const slot = occupySlot();
      const event = accountUpdatedEvent();

      const busy = await deliver(event);
      expect(busy.statusCode).toBe(503);
      expect(busy.json().code).toBe("STRIPE_BUSY");
      expect(await eventRow(event.id)).toBeUndefined();

      slot.release();
      await slot.call;
    });
  });
});
