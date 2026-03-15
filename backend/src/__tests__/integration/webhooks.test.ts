import { vi } from 'vitest';

// Mock Stripe before importing anything else
vi.mock('../../lib/stripe', () => ({
  stripe: {
    webhooks: {
      constructEvent: vi.fn(),
    },
    accounts: { create: vi.fn() },
    accountLinks: { create: vi.fn() },
  },
}));

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildServer } from '../../app';
import { db } from '../../db/client';
import { webhookEvents, clients } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { stripe } from '../../lib/stripe';
import { randomUUID } from 'crypto';

const mockConstructEvent = stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>;

// Helper: build a minimal Stripe event object
function makeStripeEvent(type: string, dataObject: Record<string, unknown> = {}) {
  return {
    id: `evt_${randomUUID().replace(/-/g, '')}`,
    object: 'event',
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
    method: 'POST',
    url: '/api/v1/webhooks/stripe',
    body: JSON.stringify(event),
    headers: {
      'content-type': 'application/json',
      'stripe-signature': 'sig_test',
    },
  });
}

describe('POST /api/v1/webhooks/stripe', () => {
  let app: any;

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_1234567890';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test1234567890';
    process.env.FRONTEND_ORIGIN = 'http://localhost:5173';
    process.env.USE_CHECKOUT = process.env.USE_CHECKOUT ?? 'false';
    process.env.SMTP_HOST = process.env.SMTP_HOST ?? 'mailhog';
    process.env.SMTP_PORT = process.env.SMTP_PORT ?? '1025';
    process.env.SMTP_USER = process.env.SMTP_USER ?? 'test';
    process.env.SMTP_PASS = process.env.SMTP_PASS ?? 'test';
    app = await buildServer();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when stripe-signature header is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Missing Stripe-Signature header/i);
  });

  it('returns 400 when constructEvent throws (bad signature)', async () => {
    mockConstructEvent.mockImplementationOnce(() => {
      throw new Error('No signatures found matching the expected signature for payload');
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      body: JSON.stringify({}),
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'invalid_sig',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Webhook Error/);
  });

  it('returns 200 for payment_intent.succeeded event', async () => {
    const event = makeStripeEvent('payment_intent.succeeded', {
      id: 'pi_test123',
      status: 'succeeded',
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    // Clean up webhook event record
    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it('returns 200 for payment_intent.payment_failed event', async () => {
    const event = makeStripeEvent('payment_intent.payment_failed', {
      id: 'pi_failed123',
      status: 'requires_payment_method',
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it('returns 200 for charge.refunded event', async () => {
    const event = makeStripeEvent('charge.refunded', {
      id: 'ch_refund123',
      amount_refunded: 1000,
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it('returns 200 for payout.paid event', async () => {
    const event = makeStripeEvent('payout.paid', {
      id: 'po_paid123',
      status: 'paid',
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it('returns 200 for payout.failed event', async () => {
    const event = makeStripeEvent('payout.failed', {
      id: 'po_failed123',
      status: 'failed',
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it('returns 200 for an unknown/unhandled event type (default branch)', async () => {
    const event = makeStripeEvent('customer.subscription.created', {
      id: 'sub_unknown123',
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it('returns 200 for account.updated with details_submitted=true and updates client', async () => {
    // Create a client linked to a Stripe account
    const clientId = randomUUID();
    const stripeAccountId = `acct_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    await db.insert(clients).values({
      id: clientId,
      name: 'Webhook Test Client',
      email: 'webhooktest@example.com',
      status: 'active',
      stripeAccountId,
    });

    const event = makeStripeEvent('account.updated', {
      id: stripeAccountId,
      details_submitted: true,
      email: 'updated@example.com',
      settings: {
        dashboard: { display_name: 'Updated Name' },
      },
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    // Verify DB was updated
    const [updatedClient] = await db
      .select()
      .from(clients)
      .where(eq(clients.id, clientId));

    expect(updatedClient.email).toBe('updated@example.com');

    // Clean up
    await db.delete(clients).where(eq(clients.id, clientId));
    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });

  it('returns 200 for account.updated with details_submitted=false (no DB update)', async () => {
    const event = makeStripeEvent('account.updated', {
      id: 'acct_nodeatailssubmit',
      details_submitted: false,
    });
    mockConstructEvent.mockReturnValueOnce(event);

    const response = await sendWebhook(app, event);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });
});
