import { vi } from "vitest";

vi.mock("../../lib/stripe", () => ({
  stripe: {
    webhooks: { constructEvent: vi.fn() },
    checkout: { sessions: { retrieve: vi.fn() } },
    accounts: { retrieve: vi.fn() },
  },
}));

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clients, paymentLedger, webhookEvents } from "../../db/schema";
import {
  openStripeCircuitForTests,
  resetCircuitBreakersForTests,
} from "../../lib/circuit-breakers";
import { stripe } from "../../lib/stripe";

const mockConstructEvent = stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>;
const mockRetrieve = stripe.checkout.sessions.retrieve as ReturnType<typeof vi.fn>;

const STALE_MS = 60_000;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

describe("checkout ledger status accuracy", () => {
  let app: any;
  const clientId = randomUUID();
  const ledgerIds: string[] = [];
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
    await db.insert(clients).values({
      id: clientId,
      name: "Status Accuracy Client",
      email: `status-accuracy-${clientId}@example.com`,
      status: "active",
      stripeAccountId: `acct_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    });
  });

  afterAll(async () => {
    // Ledger rows cascade-delete with the client.
    await db.delete(clients).where(eq(clients.id, clientId));
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetCircuitBreakersForTests();
  });

  afterEach(async () => {
    for (const id of ledgerIds.splice(0)) {
      await db.delete(paymentLedger).where(eq(paymentLedger.id, id));
    }
    for (const id of eventIds.splice(0)) {
      await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, id));
    }
  });

  async function seedRow(overrides: Partial<typeof paymentLedger.$inferInsert> = {}) {
    const id = randomUUID();
    const suffix = randomUUID().replace(/-/g, "");
    const sessionId = `cs_test_${suffix}`;
    await db.insert(paymentLedger).values({
      id,
      idempotencyKey: `idem_${suffix}`,
      connectedAccountId: "acct_status_test",
      stripeSessionId: sessionId,
      stripePaymentIntentId: null,
      clientId,
      source: "checkout",
      status: "created",
      baseAmountCents: 5000,
      totalAmountCents: 5150,
      feeAmountCents: 150,
      currency: "usd",
      ...overrides,
    });
    ledgerIds.push(id);
    return { id, sessionId, paymentIntentId: `pi_${suffix}` };
  }

  async function getRow(id: string) {
    const [row] = await db.select().from(paymentLedger).where(eq(paymentLedger.id, id));
    return row;
  }

  async function deliver(type: string, dataObject: Record<string, unknown>, created?: number) {
    const event = {
      id: `evt_${randomUUID().replace(/-/g, "")}`,
      object: "event",
      type,
      data: { object: dataObject },
      livemode: false,
      pending_webhooks: 0,
      request: null,
      created: created ?? nowSeconds(),
    };
    eventIds.push(event.id);
    mockConstructEvent.mockReturnValueOnce(event);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/stripe",
      body: JSON.stringify(event),
      headers: { "content-type": "application/json", "stripe-signature": "sig_test" },
    });
    expect(response.statusCode).toBe(200);
  }

  async function getStatus(sessionId: string) {
    return app.inject({ method: "GET", url: `/api/v1/payments/session/${sessionId}` });
  }

  describe("checkout.session.completed with an unsettled payment (payments#2)", () => {
    it("leaves the row created but records the PaymentIntent id", async () => {
      const row = await seedRow();

      await deliver("checkout.session.completed", {
        id: row.sessionId,
        payment_status: "unpaid",
        payment_intent: row.paymentIntentId,
      });

      const updated = await getRow(row.id);
      expect(updated.status).toBe("created");
      expect(updated.stripePaymentIntentId).toBe(row.paymentIntentId);
    });

    it("marks the row paid when async_payment_succeeded follows", async () => {
      const row = await seedRow();
      const created = nowSeconds();

      await deliver(
        "checkout.session.completed",
        { id: row.sessionId, payment_status: "unpaid", payment_intent: row.paymentIntentId },
        created
      );
      await deliver(
        "checkout.session.async_payment_succeeded",
        { id: row.sessionId, payment_status: "paid", payment_intent: row.paymentIntentId },
        created + 5
      );

      expect((await getRow(row.id)).status).toBe("paid");
    });

    it("marks the row failed when async_payment_failed follows", async () => {
      const row = await seedRow();
      const created = nowSeconds();

      await deliver(
        "checkout.session.completed",
        { id: row.sessionId, payment_status: "unpaid", payment_intent: row.paymentIntentId },
        created
      );
      await deliver(
        "checkout.session.async_payment_failed",
        { id: row.sessionId, payment_status: "unpaid", payment_intent: row.paymentIntentId },
        created + 5
      );

      const failed = await getRow(row.id);
      expect(failed.status).toBe("failed");
      expect(failed.stripePaymentIntentId).toBe(row.paymentIntentId);
    });

    it("marks the row paid when payment_status is no_payment_required", async () => {
      const row = await seedRow();

      await deliver("checkout.session.completed", {
        id: row.sessionId,
        payment_status: "no_payment_required",
      });

      expect((await getRow(row.id)).status).toBe("paid");
    });

    it("does not downgrade a paid row when a late unpaid completed arrives", async () => {
      const row = await seedRow({ status: "paid", lastStripeEventCreatedAt: nowSeconds() - 100 });

      await deliver("checkout.session.completed", {
        id: row.sessionId,
        payment_status: "unpaid",
        payment_intent: row.paymentIntentId,
      });

      const updated = await getRow(row.id);
      expect(updated.status).toBe("paid");
      expect(updated.stripePaymentIntentId).toBe(row.paymentIntentId);
    });
  });

  describe("GET /payments/session/:sessionId Stripe fallback (payments#5)", () => {
    it("reconciles a stale created row from Stripe using the connected account", async () => {
      const row = await seedRow({ createdAt: new Date(Date.now() - STALE_MS) });
      mockRetrieve.mockResolvedValueOnce({
        id: row.sessionId,
        status: "complete",
        payment_status: "paid",
        payment_intent: row.paymentIntentId,
        created: nowSeconds() - 120,
      });

      const response = await getStatus(row.sessionId);

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("paid");
      expect(mockRetrieve).toHaveBeenCalledTimes(1);
      expect(mockRetrieve).toHaveBeenCalledWith(
        row.sessionId,
        {},
        { stripeAccount: "acct_status_test", timeout: 3000, maxNetworkRetries: 0 }
      );
      const updated = await getRow(row.id);
      expect(updated.status).toBe("paid");
      expect(updated.stripePaymentIntentId).toBe(row.paymentIntentId);
    });

    it("applies expiry from Stripe", async () => {
      const row = await seedRow({ createdAt: new Date(Date.now() - STALE_MS) });
      mockRetrieve.mockResolvedValueOnce({
        id: row.sessionId,
        status: "expired",
        payment_status: "unpaid",
        payment_intent: null,
        created: nowSeconds() - 120,
      });

      const response = await getStatus(row.sessionId);

      expect(response.json().status).toBe("expired");
    });

    it("keeps the row created when Stripe says the session is complete but unpaid", async () => {
      const row = await seedRow({ createdAt: new Date(Date.now() - STALE_MS) });
      mockRetrieve.mockResolvedValueOnce({
        id: row.sessionId,
        status: "complete",
        payment_status: "unpaid",
        payment_intent: row.paymentIntentId,
        created: nowSeconds() - 120,
      });

      const response = await getStatus(row.sessionId);

      expect(response.json().status).toBe("created");
      expect((await getRow(row.id)).stripePaymentIntentId).toBe(row.paymentIntentId);
    });

    it("leaves an open session created", async () => {
      const row = await seedRow({ createdAt: new Date(Date.now() - STALE_MS) });
      mockRetrieve.mockResolvedValueOnce({
        id: row.sessionId,
        status: "open",
        payment_status: "unpaid",
        payment_intent: null,
        created: nowSeconds() - 120,
      });

      const response = await getStatus(row.sessionId);

      expect(response.json().status).toBe("created");
      expect(mockRetrieve).toHaveBeenCalledTimes(1);
    });

    it("does not call Stripe for a row younger than 30 seconds", async () => {
      const row = await seedRow({ createdAt: new Date(Date.now() - 5_000) });

      const response = await getStatus(row.sessionId);

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("created");
      expect(mockRetrieve).not.toHaveBeenCalled();
    });

    it("does not call Stripe for rows that already left created", async () => {
      const row = await seedRow({ status: "paid", createdAt: new Date(Date.now() - STALE_MS) });

      const response = await getStatus(row.sessionId);

      expect(response.json().status).toBe("paid");
      expect(mockRetrieve).not.toHaveBeenCalled();
    });

    it("calls Stripe at most once per row across repeated polls, even when Stripe fails", async () => {
      const row = await seedRow({ createdAt: new Date(Date.now() - STALE_MS) });
      mockRetrieve.mockRejectedValue(new Error("stripe unavailable"));

      const first = await getStatus(row.sessionId);
      const second = await getStatus(row.sessionId);
      const third = await getStatus(row.sessionId);

      expect([first.statusCode, second.statusCode, third.statusCode]).toEqual([200, 200, 200]);
      expect(mockRetrieve).toHaveBeenCalledTimes(1);
    });

    it("degrades to the stored row when Stripe errors", async () => {
      const row = await seedRow({ createdAt: new Date(Date.now() - STALE_MS) });
      mockRetrieve.mockRejectedValueOnce(new Error("stripe unavailable"));

      const response = await getStatus(row.sessionId);

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("created");
      expect((await getRow(row.id)).status).toBe("created");
    });

    it("degrades to the stored row when the Stripe lookup times out", async () => {
      const row = await seedRow({ createdAt: new Date(Date.now() - STALE_MS) });
      const timeoutError = Object.assign(new Error("Request timed out"), {
        type: "StripeConnectionError",
      });
      mockRetrieve.mockRejectedValueOnce(timeoutError);

      const response = await getStatus(row.sessionId);

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("created");
      expect(mockRetrieve).toHaveBeenCalledTimes(1);
      // A short per-request budget with no network retries bounds the worst case.
      expect(mockRetrieve.mock.calls[0][2]).toMatchObject({ timeout: 3000, maxNetworkRetries: 0 });
      expect((await getRow(row.id)).status).toBe("created");
    });

    it("degrades to the stored row when the Stripe circuit is open", async () => {
      const row = await seedRow({ createdAt: new Date(Date.now() - STALE_MS) });
      openStripeCircuitForTests();

      const response = await getStatus(row.sessionId);

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("created");
      expect(mockRetrieve).not.toHaveBeenCalled();
    });

    it("does not stop a later webhook from applying after reconciliation", async () => {
      const row = await seedRow({ createdAt: new Date(Date.now() - STALE_MS) });
      mockRetrieve.mockResolvedValueOnce({
        id: row.sessionId,
        status: "complete",
        payment_status: "paid",
        payment_intent: row.paymentIntentId,
        created: nowSeconds() - 120,
      });
      await getStatus(row.sessionId);

      await deliver(
        "charge.refunded",
        { id: "ch_status_refund", payment_intent: row.paymentIntentId, amount_refunded: 5150 },
        nowSeconds() - 10
      );

      expect((await getRow(row.id)).status).toBe("refunded");
    });

    it("still returns 404 for an unknown session without calling Stripe", async () => {
      const response = await getStatus(`cs_test_${randomUUID().replace(/-/g, "")}`);

      expect(response.statusCode).toBe(404);
      expect(mockRetrieve).not.toHaveBeenCalled();
    });
  });
});
