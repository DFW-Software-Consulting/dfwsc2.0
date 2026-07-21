import { vi } from "vitest";

vi.mock("../../lib/stripe", () => ({
  stripe: {
    paymentIntents: {
      create: vi.fn(),
      list: vi.fn().mockResolvedValue({ data: [], has_more: false }),
    },
    checkout: {
      sessions: { create: vi.fn() },
    },
    accounts: { create: vi.fn() },
    accountLinks: { create: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
  },
}));

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clientGroups, clients } from "../../db/schema";
import { hashApiKey, sha256Lookup } from "../../lib/auth";
import { stripe } from "../../lib/stripe";

const TEST_JWT_SECRET = "test_jwt_secret_minimum_32_characters_long_random_string";

function makeAdminToken() {
  return jwt.sign({ role: "admin" }, TEST_JWT_SECRET, { expiresIn: "1h" });
}

function ensureBaseEnv() {
  process.env.FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:5173";
  process.env.SMTP_HOST = process.env.SMTP_HOST ?? "mailhog";
  process.env.SMTP_PORT = process.env.SMTP_PORT ?? "1025";
  process.env.SMTP_USER = process.env.SMTP_USER ?? "test";
  process.env.SMTP_PASS = process.env.SMTP_PASS ?? "test";
}

// ---------------------------------------------------------------------------
// Checkout edge cases
// ---------------------------------------------------------------------------

describe("POST /api/v1/payments/create — checkout mode", () => {
  let app: any;
  // Each test gets its own fresh client to avoid any cross-test DB state issues
  let apiKey: string;
  let clientId: string;

  beforeAll(async () => {
    ensureBaseEnv();
    app = await buildServer();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    clientId = randomUUID();
    apiKey = randomUUID().replace(/-/g, "");
    const apiKeyHash = await hashApiKey(apiKey);
    const apiKeyLookup = sha256Lookup(apiKey);

    await db.insert(clients).values({
      id: clientId,
      name: "Checkout Edge Client",
      email: `checkoutedge-${clientId}@example.com`,
      apiKeyHash,
      apiKeyLookup,
      status: "active",
      stripeAccountId: `acct_checkout${clientId.replace(/-/g, "").slice(0, 12)}`,
      chargesEnabled: true,
      processingFeeCents: 1000, // $10 flat fee
    });
  });

  afterEach(async () => {
    await db.delete(clients).where(eq(clients.id, clientId));
  });

  it("returns 400 when lineItems are missing in checkout mode", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: {
        "x-api-key": apiKey,
        "idempotency-key": randomUUID(),
        "content-type": "application/json",
      },
      payload: { amount: 5000, currency: "usd" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/lineItems/i);
  });

  it("returns 400 when a lineItem uses a Stripe price ID instead of inline price_data", async () => {
    // Only inline price_data is accepted (see comment atop payments.ts) — Stripe
    // price IDs are platform-scoped and incompatible with connected-account
    // Checkout sessions, so this must be rejected by validation before Stripe
    // is ever called.
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: {
        "x-api-key": apiKey,
        "idempotency-key": randomUUID(),
        "content-type": "application/json",
      },
      payload: {
        amount: 100,
        currency: "usd",
        lineItems: [{ price: "price_test", quantity: 1 }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("returns 502 when the Stripe Checkout session creation call fails", async () => {
    vi.mocked(stripe.checkout.sessions.create).mockRejectedValueOnce(
      Object.assign(new Error("An error occurred with our connection to Stripe."), {
        name: "StripeConnectionError",
      })
    );

    const response = await app.inject({
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
            price_data: {
              currency: "usd",
              product_data: { name: "Service" },
              unit_amount: 5000,
            },
            quantity: 1,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// C1: fee waiver must be server-authoritative for API-key callers.
// H1: un-connected clients must be rejected, not charged to the platform.
// ---------------------------------------------------------------------------

describe("POST /api/v1/payments/create — fee waiver and connected-account guard", () => {
  let app: any;
  let apiKey: string;
  let clientId: string;

  beforeAll(async () => {
    ensureBaseEnv();
    app = await buildServer();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    clientId = randomUUID();
    apiKey = randomUUID().replace(/-/g, "");
    const apiKeyHash = await hashApiKey(apiKey);
    const apiKeyLookup = sha256Lookup(apiKey);

    await db.insert(clients).values({
      id: clientId,
      name: "Fee Guard Client",
      email: `feeguard-${clientId}@example.com`,
      apiKeyHash,
      apiKeyLookup,
      status: "active",
      stripeAccountId: `acct_feeguard${clientId.replace(/-/g, "").slice(0, 12)}`,
      chargesEnabled: true,
      processingFeeCents: 1000,
    });

    vi.mocked(stripe.checkout.sessions.create).mockReset();
    vi.mocked(stripe.checkout.sessions.create).mockResolvedValue({
      url: "https://checkout.stripe.com/c/pay/test",
    } as never);
  });

  afterEach(async () => {
    await db.delete(clients).where(eq(clients.id, clientId));
  });

  it("ignores waiveFee from an API-key caller and still applies the platform fee (C1)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: {
        "x-api-key": apiKey,
        "idempotency-key": randomUUID(),
        "content-type": "application/json",
      },
      payload: {
        waiveFee: true,
        lineItems: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: "Service" },
              unit_amount: 5000,
            },
            quantity: 1,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    const createCall = vi.mocked(stripe.checkout.sessions.create).mock.calls[0][0];
    // The fee is still routed to the platform via application_fee_amount…
    expect(createCall.payment_intent_data?.application_fee_amount).toBe(1000);
    // …and still charged to the customer as the extra "Processing Fee" line item.
    expect(createCall.line_items).toHaveLength(2);
    expect(createCall.line_items?.[1]?.price_data?.unit_amount).toBe(1000);
  });

  it("returns 409 ACCOUNT_NOT_CONNECTED when the client has no connected Stripe account (H1)", async () => {
    const unconnectedId = randomUUID();
    const unconnectedApiKey = randomUUID().replace(/-/g, "");
    const unconnectedHash = await hashApiKey(unconnectedApiKey);
    const unconnectedLookup = sha256Lookup(unconnectedApiKey);

    await db.insert(clients).values({
      id: unconnectedId,
      name: "Unconnected Guard Client",
      email: `unconnectedguard-${unconnectedId}@example.com`,
      apiKeyHash: unconnectedHash,
      apiKeyLookup: unconnectedLookup,
      status: "active",
      stripeAccountId: null,
      chargesEnabled: false,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: {
        "x-api-key": unconnectedApiKey,
        "idempotency-key": randomUUID(),
        "content-type": "application/json",
      },
      payload: { amount: 1000, currency: "usd" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/not connected/i);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();

    await db.delete(clients).where(eq(clients.id, unconnectedId));
  });
});

// ---------------------------------------------------------------------------
// Reports — group with no connected clients (lines 244-245)
// ---------------------------------------------------------------------------

describe("GET /api/v1/reports/payments — group with no connected clients", () => {
  let app: any;
  let groupId: string;
  let clientId: string;

  beforeAll(async () => {
    ensureBaseEnv();

    app = await buildServer();

    groupId = `grp-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await db.insert(clientGroups).values({
      id: groupId,
      name: "Empty Connected Group",
      status: "active",
      workspace: "client_portal",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Client belongs to the group but has NO stripeAccountId
    clientId = randomUUID();
    await db.insert(clients).values({
      id: clientId,
      name: "Unconnected Client",
      email: "unconnected@example.com",
      status: "active",
      groupId,
      workspace: "client_portal",
    });
  });

  afterAll(async () => {
    await db.delete(clients).where(eq(clients.id, clientId));
    await db.delete(clientGroups).where(eq(clientGroups.id, groupId));
    if (app) await app.close();
  });

  it("returns 200 with empty data when no group members have a Stripe account", async () => {
    const token = makeAdminToken();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/reports/payments?groupId=${groupId}&workspace=client_portal`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.groupId).toBe(groupId);
    expect(body.data).toEqual([]);
    expect(body.hasMore).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reports — response must be sanitized, never raw Stripe objects.
// ---------------------------------------------------------------------------

describe("GET /api/v1/reports/payments — sanitizes Stripe payment intents", () => {
  let app: any;
  let clientId: string;

  beforeAll(async () => {
    ensureBaseEnv();
    app = await buildServer();

    clientId = randomUUID();
    await db.insert(clients).values({
      id: clientId,
      name: "Sanitize Report Client",
      email: `sanitize-report-${clientId}@example.com`,
      status: "active",
      workspace: "client_portal",
      stripeAccountId: `acct_sanitize${clientId.replace(/-/g, "").slice(0, 12)}`,
      chargesEnabled: true,
    });
  });

  afterAll(async () => {
    await db.delete(clients).where(eq(clients.id, clientId));
    if (app) await app.close();
  });

  it("does not leak raw Stripe fields (client_secret, customer, payment_method_types, etc.)", async () => {
    const token = makeAdminToken();

    vi.mocked(stripe.paymentIntents.list).mockResolvedValueOnce({
      data: [
        {
          id: "pi_test_sanitize_1",
          object: "payment_intent",
          amount: 5000,
          amount_received: 5000,
          currency: "usd",
          status: "succeeded",
          created: 1700000000,
          description: "Test payment",
          metadata: { foo: "bar" },
          payment_method: "pm_test_123",
          client_secret: "pi_test_sanitize_1_secret_abc123",
          customer: "cus_test_123",
          latest_charge: "ch_test_123",
          payment_method_types: ["card"],
          application: "ca_test_app",
          application_fee_amount: 500,
          transfer_data: { destination: "acct_dest_123" },
          receipt_email: "customer@example.com",
        },
      ],
      has_more: false,
    } as never);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/reports/payments?clientId=${clientId}&workspace=client_portal`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    const pi = body.data[0];

    // Sanitized, payer-safe fields only.
    expect(pi).toEqual({
      id: "pi_test_sanitize_1",
      amount: 5000,
      amountReceived: 5000,
      currency: "usd",
      status: "succeeded",
      created: 1700000000,
      description: "Test payment",
      metadata: { foo: "bar" },
      paymentMethod: "pm_test_123",
    });

    // Explicitly assert none of the raw/sensitive Stripe fields leak through.
    expect(pi).not.toHaveProperty("client_secret");
    expect(pi).not.toHaveProperty("customer");
    expect(pi).not.toHaveProperty("latest_charge");
    expect(pi).not.toHaveProperty("payment_method_types");
    expect(pi).not.toHaveProperty("application");
    expect(pi).not.toHaveProperty("transfer_data");
    expect(pi).not.toHaveProperty("receipt_email");
    expect(pi).not.toHaveProperty("amount_received");
  });
});
