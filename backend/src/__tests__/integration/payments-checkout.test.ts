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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clientGroups, clients } from "../../db/schema";
import { hashApiKey, sha256Lookup } from "../../lib/auth";

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
// Checkout mode edge cases (USE_CHECKOUT=true)
// ---------------------------------------------------------------------------

describe("POST /api/v1/payments/create — checkout mode", () => {
  let app: any;
  // Each test gets its own fresh client to avoid any cross-test DB state issues
  let apiKey: string;
  let clientId: string;

  beforeAll(async () => {
    ensureBaseEnv();
    process.env.USE_CHECKOUT = "true";
    app = await buildServer();
  });

  afterAll(async () => {
    if (app) await app.close();
    process.env.USE_CHECKOUT = "false";
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

  it("returns 400 when applicationFeeAmount exceeds the provided amount", async () => {
    // processingFeeCents=1000 (fee), amount=100 (payment) → fee > amount
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
        lineItems: [{ price: "price_test", quantity: 1 }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/applicationFeeAmount cannot exceed/i);
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
    process.env.USE_CHECKOUT = "false";

    app = await buildServer();

    groupId = `grp-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await db.insert(clientGroups).values({
      id: groupId,
      name: "Empty Connected Group",
      status: "active",
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
      url: `/api/v1/reports/payments?groupId=${groupId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.groupId).toBe(groupId);
    expect(body.data).toEqual([]);
    expect(body.hasMore).toBe(false);
  });
});
