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

  it("returns 502 when Stripe call fails due to missing price", async () => {
    // processingFeeCents=1000 (fee), amount=100 (payment) → fee > amount.
    // Line items use a Stripe price ID (no price_data), so `currency` must be
    // supplied explicitly for the server to resolve the processing-fee line
    // item's currency (L2-adjacent validation) before it ever calls Stripe.
    vi.mocked(stripe.checkout.sessions.create).mockRejectedValueOnce(
      Object.assign(new Error("No such price: 'price_test'"), { name: "StripeInvalidRequestError" })
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
        amount: 100,
        currency: "usd",
        lineItems: [{ price: "price_test", quantity: 1 }],
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
