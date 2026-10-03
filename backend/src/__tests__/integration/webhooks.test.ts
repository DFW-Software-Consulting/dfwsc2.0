import { vi } from "vitest";

// Mock Stripe before importing anything else
vi.mock("../../lib/stripe", () => ({
  stripe: {
    webhooks: {
      constructEvent: vi.fn(),
    },
    accounts: { create: vi.fn(), retrieve: vi.fn() },
    accountLinks: { create: vi.fn() },
    charges: { retrieve: vi.fn() },
    subscriptions: {
      retrieve: vi.fn().mockResolvedValue({
        id: "sub_test",
        metadata: { paymentsMade: "0" },
      }),
      update: vi.fn().mockResolvedValue({ id: "sub_test" }),
    },
    invoices: {
      // Idempotent invoice.paid derives the paid count from this listing.
      list: vi.fn().mockResolvedValue({
        data: [{ id: "in_test1", status: "paid" }],
        has_more: false,
      }),
    },
    subscriptionSchedules: {
      retrieve: vi.fn().mockResolvedValue({
        id: "sched_test",
        metadata: { paymentsMade: "0" },
      }),
      update: vi.fn().mockResolvedValue({ id: "sched_test" }),
    },
  },
}));

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clients, paymentLedger, webhookEvents } from "../../db/schema";
import { stripe } from "../../lib/stripe";

const mockConstructEvent = stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>;

// Helper: build a minimal Stripe event object
function makeStripeEvent(type: string, dataObject: Record<string, unknown> = {}) {
  return {
    id: `evt_${randomUUID().replace(/-/g, "")}`,
    object: "event",
    type,
    data: { object: dataObject },
    livemode: false,
    pending_webhooks: 0,
    request: null,
    created: Math.floor(Date.now() / 1000),
  };
}

async function sendWebhook(app: any, event: ReturnType<typeof makeStripeEvent>) {
  return app.inject({
    method: "POST",
    url: "/api/v1/webhooks/stripe",
    body: JSON.stringify(event),
    headers: {
      "content-type": "application/json",
      "stripe-signature": "sig_test",
    },
  });
}

describe("POST /api/v1/webhooks/stripe", () => {
  let app: any;

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_1234567890";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test1234567890";
    process.env.FRONTEND_ORIGIN = "http://localhost:5173";
    process.env.SMTP_HOST = process.env.SMTP_HOST ?? "mailhog";
    process.env.SMTP_PORT = process.env.SMTP_PORT ?? "1025";
    process.env.SMTP_USER = process.env.SMTP_USER ?? "test";
    process.env.SMTP_PASS = process.env.SMTP_PASS ?? "test";
    app = await buildServer();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when stripe-signature header is missing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/stripe",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Missing Stripe-Signature header/i);
  });

  it("returns 400 when constructEvent throws (bad signature)", async () => {
    mockConstructEvent.mockImplementationOnce(() => {
      throw new Error("No signatures found matching the expected signature for payload");
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/stripe",
      body: JSON.stringify({}),
      headers: {
        "content-type": "application/json",
        "stripe-signature": "invalid_sig",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Webhook Error/);
  });

  it("returns 200 for payment_intent.succeeded event", async () => {
    const event = makeStripeEvent("payment_intent.succeeded", {
      id: "pi_test123",
      status: "succeeded",
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    // Clean up webhook event record
    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it("returns 200 for payment_intent.payment_failed event", async () => {
    const event = makeStripeEvent("payment_intent.payment_failed", {
      id: "pi_failed123",
      status: "requires_payment_method",
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it("returns 200 for charge.refunded event", async () => {
    const event = makeStripeEvent("charge.refunded", {
      id: "ch_refund123",
      amount_refunded: 1000,
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it("returns 200 for application_fee.refunded event", async () => {
    const event = makeStripeEvent("application_fee.refunded", {
      id: "fee_refund123",
      amount_refunded: 500,
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it("returns 200 for payout.paid event", async () => {
    const event = makeStripeEvent("payout.paid", {
      id: "po_paid123",
      status: "paid",
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it("returns 200 for payout.failed event", async () => {
    const event = makeStripeEvent("payout.failed", {
      id: "po_failed123",
      status: "failed",
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it("returns 200 for an unknown/unhandled event type (default branch)", async () => {
    const event = makeStripeEvent("customer.subscription.created", {
      id: "sub_unknown123",
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it("returns 200 for account.updated with details_submitted=true, updates readiness flags, and does not clobber name/email", async () => {
    // Create a client linked to a Stripe account
    const clientId = randomUUID();
    const stripeAccountId = `acct_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    await db.insert(clients).values({
      id: clientId,
      name: "Webhook Test Client",
      email: "webhooktest@example.com",
      status: "active",
      stripeAccountId,
    });

    const event = makeStripeEvent("account.updated", {
      id: stripeAccountId,
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
      email: "updated@example.com",
      settings: {
        dashboard: { display_name: "Updated Name" },
      },
    });
    mockConstructEvent.mockReturnValueOnce(event);

    // account.updated now retrieves current state live from Stripe rather
    // than trusting the webhook payload, to handle out-of-order delivery.
    const accountsRetrieveMock = stripe.accounts.retrieve as ReturnType<typeof vi.fn>;
    accountsRetrieveMock.mockResolvedValueOnce({
      id: stripeAccountId,
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
    });

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    // Verify DB was updated
    const [updatedClient] = await db.select().from(clients).where(eq(clients.id, clientId));

    // Merchant-controlled Stripe account fields must NOT overwrite
    // admin-entered CRM data (name/email).
    expect(updatedClient.name).toBe("Webhook Test Client");
    expect(updatedClient.email).toBe("webhooktest@example.com");
    expect(updatedClient.chargesEnabled).toBe(true);
    expect(updatedClient.payoutsEnabled).toBe(true);
    expect(updatedClient.detailsSubmitted).toBe(true);

    // Clean up
    await db.delete(clients).where(eq(clients.id, clientId));
    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it("returns 200 for account.updated with details_submitted=false and persists false readiness booleans", async () => {
    const clientId = randomUUID();
    const stripeAccountId = `acct_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    await db.insert(clients).values({
      id: clientId,
      name: "Readiness Test Client",
      email: "readiness@example.com",
      status: "active",
      stripeAccountId,
    });

    const event = makeStripeEvent("account.updated", {
      id: stripeAccountId,
      details_submitted: false,
      charges_enabled: false,
      payouts_enabled: false,
    });
    mockConstructEvent.mockReturnValueOnce(event);

    // account.updated now retrieves current state live from Stripe rather
    // than trusting the webhook payload, to handle out-of-order delivery.
    const accountsRetrieveMock = stripe.accounts.retrieve as ReturnType<typeof vi.fn>;
    accountsRetrieveMock.mockResolvedValueOnce({
      id: stripeAccountId,
      details_submitted: false,
      charges_enabled: false,
      payouts_enabled: false,
    });

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    // Verify readiness booleans are persisted even when all are false
    const [updatedClient] = await db.select().from(clients).where(eq(clients.id, clientId));

    expect(updatedClient.detailsSubmitted).toBe(false);
    expect(updatedClient.chargesEnabled).toBe(false);
    expect(updatedClient.payoutsEnabled).toBe(false);

    // Clean up
    await db.delete(clients).where(eq(clients.id, clientId));
    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it("returns 200 for account.updated when no client matches the account (no-op update)", async () => {
    const stripeAccountId = `acct_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const event = makeStripeEvent("account.updated", {
      id: stripeAccountId,
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
    });
    mockConstructEvent.mockReturnValueOnce(event);

    // account.updated now retrieves current state live from Stripe rather
    // than trusting the webhook payload, to handle out-of-order delivery.
    const accountsRetrieveMock = stripe.accounts.retrieve as ReturnType<typeof vi.fn>;
    accountsRetrieveMock.mockResolvedValueOnce({
      id: stripeAccountId,
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
    });

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it("returns 200 for invoice.payment_succeeded event", async () => {
    const event = makeStripeEvent("invoice.payment_succeeded", {
      id: "inv_success123",
      metadata: { clientId: "client_123" },
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it("returns 200 for invoice.payment_failed event", async () => {
    const event = makeStripeEvent("invoice.payment_failed", {
      id: "inv_failed123",
      metadata: { clientId: "client_123" },
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it("returns 200 for customer.subscription.updated event", async () => {
    const event = makeStripeEvent("customer.subscription.updated", {
      id: "sub_updated123",
      status: "active",
      metadata: { clientId: "client_123" },
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it("returns 200 for customer.subscription.deleted event", async () => {
    const event = makeStripeEvent("customer.subscription.deleted", {
      id: "sub_deleted123",
      metadata: { clientId: "client_123" },
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it("returns 200 for subscription_schedule.completed event", async () => {
    const event = makeStripeEvent("subscription_schedule.completed", {
      id: "sched_completed123",
      metadata: { clientId: "client_123" },
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it("returns 200 for subscription_schedule.canceled event", async () => {
    const event = makeStripeEvent("subscription_schedule.canceled", {
      id: "sched_canceled123",
      metadata: { clientId: "client_123" },
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it("returns 200 for customer.subscription.paused event", async () => {
    const event = makeStripeEvent("customer.subscription.paused", {
      id: "sub_paused123",
      metadata: { clientId: "client_123" },
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it("returns 200 for customer.subscription.resumed event", async () => {
    const event = makeStripeEvent("customer.subscription.resumed", {
      id: "sub_resumed123",
      metadata: { clientId: "client_123" },
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it("returns 200 for invoice.paid event with subscription and updates payment count", async () => {
    const subscriptionId = `sub_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const event = makeStripeEvent("invoice.paid", {
      id: "inv_paid123",
      parent: { subscription_details: { subscription: subscriptionId } },
      metadata: { clientId: "client_123" },
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it("returns 500 for invoice.paid when subscription update fails (so Stripe retries)", async () => {
    const subscriptionId = `sub_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const retrieveMock = stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>;
    retrieveMock.mockRejectedValueOnce(new Error("stripe retrieve failed"));

    const event = makeStripeEvent("invoice.paid", {
      id: "inv_paid_failure_branch",
      parent: { subscription_details: { subscription: subscriptionId } },
      metadata: { clientId: "client_123" },
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    // Error must propagate so processedAt is NOT set and Stripe will retry
    expect(response.statusCode).toBe(500);

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it("does not reprocess duplicate webhook events", async () => {
    const subscriptionId = `sub_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const retrieveMock = stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>;
    const updateMock = stripe.subscriptions.update as ReturnType<typeof vi.fn>;

    const event = makeStripeEvent("invoice.paid", {
      id: `evt_duplicate_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      parent: { subscription_details: { subscription: subscriptionId } },
      metadata: { clientId: "client_123" },
    });

    // Gate the winner's first Stripe call so it parks mid-processing with its
    // claim row inserted but unprocessed. That lets us deterministically send
    // the concurrent duplicate while the claim is genuinely in-flight, instead
    // of racing two concurrent injects and hoping for a particular ordering.
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    retrieveMock.mockImplementationOnce(async () => {
      await gate;
      return { id: "sub_test", metadata: { paymentsMade: "0" } };
    });

    mockConstructEvent.mockReturnValue(event);

    // Delivery A: fire without awaiting so it parks inside the gated retrieve
    // call while holding the claim.
    const firstPromise = sendWebhook(app, event);

    // Wait until A has actually claimed the event and is blocked on retrieve.
    await vi.waitFor(() => expect(retrieveMock).toHaveBeenCalledTimes(1));

    // Delivery B: the claim is unprocessed and not stale, so this must be
    // told to back off and let Stripe retry later rather than double-processing.
    const second = await sendWebhook(app, event);
    expect(second.statusCode).toBe(409);

    // Release A and let it finish.
    releaseGate();
    const first = await firstPromise;
    expect(first.statusCode).toBe(200);
    expect(retrieveMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledTimes(1);

    // A genuine Stripe retry after A completed should be idempotent: the event
    // is already marked processed, so it short-circuits with 200 and no new
    // Stripe API calls.
    mockConstructEvent.mockReturnValueOnce(event);
    const retry = await sendWebhook(app, event);
    expect(retry.statusCode).toBe(200);
    expect(retrieveMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledTimes(1);

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it("reclaims a stale lease (crashed processor) and processes the event", async () => {
    const updateMock = stripe.subscriptions.update as ReturnType<typeof vi.fn>;
    const subscriptionId = `sub_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const event = makeStripeEvent("invoice.paid", {
      id: "inv_stale_lease",
      parent: { subscription_details: { subscription: subscriptionId } },
      metadata: { clientId: "client_123" },
    });

    // Simulate a crashed processor: a claim row exists, unprocessed, with a
    // lease older than STALE_CLAIM_MS.
    await db.insert(webhookEvents).values({
      id: randomUUID(),
      stripeEventId: event.id,
      type: event.type,
      payload: JSON.parse(JSON.stringify(event)) as Record<string, unknown>,
      processedAt: null,
      claimedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    mockConstructEvent.mockReturnValueOnce(event);
    const response = await sendWebhook(app, event);

    // The stale lease must be reclaimed and the event processed to completion.
    expect(response.statusCode).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);

    const [row] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, event.id));
    expect(row.processedAt).not.toBeNull();

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it("releases the claim on a retryable failure so Stripe's retry re-processes the event", async () => {
    const scheduleUpdateMock = stripe.subscriptionSchedules.update as ReturnType<typeof vi.fn>;
    const event = makeStripeEvent("subscription_schedule.completed", {
      id: "sched_completed_error_branch",
      metadata: { clientId: "client_123" },
    });

    // First delivery: processing fails with a retryable error → 500.
    scheduleUpdateMock.mockRejectedValueOnce(new Error("schedule update failed"));
    mockConstructEvent.mockReturnValueOnce(event);
    const first = await sendWebhook(app, event);
    expect(first.statusCode).toBe(500);

    // The claim row MUST have been released — otherwise the retry below would
    // hit the unique-index conflict, short-circuit as "already handled", and the
    // event would stay claimed-but-unprocessed forever.
    const afterFail = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, event.id));
    expect(afterFail).toHaveLength(0);

    // Stripe retry: processing now succeeds → 200, event re-processed and marked done.
    scheduleUpdateMock.mockResolvedValueOnce({ id: "sched_test" });
    mockConstructEvent.mockReturnValueOnce(event);
    const retry = await sendWebhook(app, event);
    expect(retry.statusCode).toBe(200);
    expect(scheduleUpdateMock).toHaveBeenCalledTimes(2);

    const afterRetry = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, event.id));
    expect(afterRetry).toHaveLength(1);
    expect(afterRetry[0].processedAt).not.toBeNull();

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  describe("payment ledger PaymentIntent linkage", () => {
    let clientId: string;
    const ledgerIds: string[] = [];
    const eventIds: string[] = [];

    beforeAll(async () => {
      clientId = randomUUID();
      await db.insert(clients).values({
        id: clientId,
        name: "Ledger Linkage Client",
        email: `ledger-${clientId}@example.com`,
        status: "active",
        stripeAccountId: `acct_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      });
    });

    afterAll(async () => {
      // Ledger rows cascade-delete with the client.
      await db.delete(clients).where(eq(clients.id, clientId));
    });

    afterEach(async () => {
      for (const id of ledgerIds.splice(0)) {
        await db.delete(paymentLedger).where(eq(paymentLedger.id, id));
      }
      for (const id of eventIds.splice(0)) {
        await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, id));
      }
      vi.restoreAllMocks();
    });

    async function seedLedgerRow(
      overrides: Partial<typeof paymentLedger.$inferInsert> = {}
    ): Promise<{ id: string; sessionId: string; paymentIntentId: string }> {
      const id = randomUUID();
      const suffix = randomUUID().replace(/-/g, "");
      const sessionId = `cs_test_${suffix}`;
      await db.insert(paymentLedger).values({
        id,
        idempotencyKey: `idem_${suffix}`,
        connectedAccountId: "acct_ledger_test",
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
      const event = makeStripeEvent(type, dataObject);
      if (created !== undefined) event.created = created;
      eventIds.push(event.id);
      mockConstructEvent.mockReturnValueOnce(event);
      const response = await sendWebhook(app, event);
      expect(response.statusCode).toBe(200);
      return event;
    }

    it("checkout.session.completed marks the row paid and records the PaymentIntent id", async () => {
      const row = await seedLedgerRow();

      await deliver("checkout.session.completed", {
        id: row.sessionId,
        payment_status: "paid",
        payment_intent: row.paymentIntentId,
      });

      const updated = await getRow(row.id);
      expect(updated.status).toBe("paid");
      expect(updated.stripePaymentIntentId).toBe(row.paymentIntentId);
    });

    it("lets PaymentIntent-keyed charge.refunded reach the row after the id is recorded", async () => {
      const row = await seedLedgerRow();
      const created = Math.floor(Date.now() / 1000);

      await deliver(
        "checkout.session.completed",
        { id: row.sessionId, payment_status: "paid", payment_intent: row.paymentIntentId },
        created
      );
      await deliver(
        "charge.refunded",
        { id: "ch_linkage_refund", payment_intent: row.paymentIntentId, amount_refunded: 5150 },
        created + 10
      );

      const updated = await getRow(row.id);
      expect(updated.status).toBe("refunded");
      expect(updated.refundedAmountCents).toBe(5150);
      expect(updated.stripePaymentIntentId).toBe(row.paymentIntentId);
    });

    it("lets payment_intent.payment_failed and charge.dispute.created reach the row after the id is recorded", async () => {
      const failedRow = await seedLedgerRow();
      await deliver("checkout.session.completed", {
        id: failedRow.sessionId,
        payment_intent: failedRow.paymentIntentId,
      });
      // A PaymentIntent-keyed failure finds the row (it is already paid, so
      // precedence keeps `paid`, but the lookup must succeed rather than skip).
      const debugSpy = vi.spyOn(app.log, "debug");
      await deliver("payment_intent.payment_failed", {
        id: failedRow.paymentIntentId,
        status: "requires_payment_method",
      });
      expect(
        debugSpy.mock.calls.some(([, msg]) => String(msg).includes("No ledger row found"))
      ).toBe(false);
      expect(
        debugSpy.mock.calls.some(([, msg]) => String(msg).includes("precedence prevents downgrade"))
      ).toBe(true);

      // charge.dispute.created retrieves the charge from Stripe; mock that call.
      const disputeRow = await seedLedgerRow();
      const created = Math.floor(Date.now() / 1000);
      await deliver(
        "checkout.session.completed",
        { id: disputeRow.sessionId, payment_intent: disputeRow.paymentIntentId },
        created
      );
      const chargesRetrieve = stripe.charges.retrieve as ReturnType<typeof vi.fn>;
      chargesRetrieve.mockResolvedValueOnce({
        id: "ch_linkage_dispute",
        payment_intent: disputeRow.paymentIntentId,
      });
      await deliver(
        "charge.dispute.created",
        { id: "dp_linkage", charge: "ch_linkage_dispute" },
        created + 10
      );

      expect(chargesRetrieve).toHaveBeenCalledTimes(1);
      expect((await getRow(disputeRow.id)).status).toBe("disputed");
    });

    it("does not overwrite a different existing PaymentIntent id and logs a warning", async () => {
      const row = await seedLedgerRow({ stripePaymentIntentId: "pi_original" });
      const warnSpy = vi.spyOn(app.log, "warn");

      await deliver("checkout.session.completed", {
        id: row.sessionId,
        payment_intent: "pi_different",
      });

      const updated = await getRow(row.id);
      expect(updated.stripePaymentIntentId).toBe("pi_original");
      expect(updated.status).toBe("paid");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          ledgerId: row.id,
          existingPaymentIntentId: "pi_original",
          incomingPaymentIntentId: "pi_different",
        }),
        expect.stringContaining("different PaymentIntent id")
      );
    });

    it("does not warn when the incoming PaymentIntent id equals the recorded one", async () => {
      const row = await seedLedgerRow({ stripePaymentIntentId: "pi_same" });
      const warnSpy = vi.spyOn(app.log, "warn");

      await deliver("checkout.session.completed", { id: row.sessionId, payment_intent: "pi_same" });

      expect(warnSpy).not.toHaveBeenCalled();
      const updated = await getRow(row.id);
      expect(updated.stripePaymentIntentId).toBe("pi_same");
      expect(updated.status).toBe("paid");
    });

    it("a stale checkout.session.completed still records the PaymentIntent id without changing status or ordering", async () => {
      const lastEventAt = Math.floor(Date.now() / 1000);
      const row = await seedLedgerRow({
        status: "refunded",
        lastStripeEventCreatedAt: lastEventAt,
      });

      await deliver(
        "checkout.session.completed",
        { id: row.sessionId, payment_intent: row.paymentIntentId },
        lastEventAt - 60
      );

      const updated = await getRow(row.id);
      expect(updated.stripePaymentIntentId).toBe(row.paymentIntentId);
      expect(updated.status).toBe("refunded");
      expect(updated.lastStripeEventCreatedAt).toBe(lastEventAt);
    });

    it("records the PaymentIntent id even when status precedence blocks the update", async () => {
      const lastEventAt = Math.floor(Date.now() / 1000);
      const row = await seedLedgerRow({
        status: "disputed",
        lastStripeEventCreatedAt: lastEventAt,
      });

      await deliver(
        "checkout.session.completed",
        { id: row.sessionId, payment_intent: row.paymentIntentId },
        lastEventAt + 5
      );

      const updated = await getRow(row.id);
      expect(updated.stripePaymentIntentId).toBe(row.paymentIntentId);
      expect(updated.status).toBe("disputed");
      expect(updated.lastStripeEventCreatedAt).toBe(lastEventAt);
    });

    it("checkout.session.async_payment_succeeded records the PaymentIntent id", async () => {
      const row = await seedLedgerRow();

      await deliver("checkout.session.async_payment_succeeded", {
        id: row.sessionId,
        payment_intent: row.paymentIntentId,
      });

      const updated = await getRow(row.id);
      expect(updated.status).toBe("paid");
      expect(updated.stripePaymentIntentId).toBe(row.paymentIntentId);
    });

    it("checkout.session.async_payment_failed records the PaymentIntent id", async () => {
      const row = await seedLedgerRow();

      await deliver("checkout.session.async_payment_failed", {
        id: row.sessionId,
        payment_intent: row.paymentIntentId,
      });

      const updated = await getRow(row.id);
      expect(updated.status).toBe("failed");
      expect(updated.stripePaymentIntentId).toBe(row.paymentIntentId);
    });

    it("checkout.session.expired records a PaymentIntent id when the session carries one", async () => {
      const row = await seedLedgerRow();

      await deliver("checkout.session.expired", {
        id: row.sessionId,
        payment_intent: row.paymentIntentId,
      });

      const updated = await getRow(row.id);
      expect(updated.status).toBe("expired");
      expect(updated.stripePaymentIntentId).toBe(row.paymentIntentId);
    });

    it("leaves the PaymentIntent id null when the session has none", async () => {
      const row = await seedLedgerRow();

      await deliver("checkout.session.completed", { id: row.sessionId, payment_intent: null });

      const updated = await getRow(row.id);
      expect(updated.status).toBe("paid");
      expect(updated.stripePaymentIntentId).toBeNull();
    });
  });
});
