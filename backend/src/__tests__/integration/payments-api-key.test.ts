import { randomUUID } from "node:crypto";
import { vi } from "vitest";

describe("Payments API Key Authentication Integration", () => {
  let app: any;
  let db: any;
  let clients: any;
  let eq: (left: unknown, right: unknown) => unknown;
  let hashApiKey: (apiKey: string) => Promise<string>;
  let sha256Lookup: (apiKey: string) => string;
  let stripeMock: {
    paymentIntents: { create: ReturnType<typeof vi.fn> };
    checkout: { sessions: { create: ReturnType<typeof vi.fn> } };
  };

  beforeAll(async () => {
    // Set up environment variables for testing
    process.env.STRIPE_SECRET_KEY = "sk_test_12345";
    process.env.FRONTEND_ORIGIN = "http://localhost:5173";
    process.env.API_BASE_URL = "http://localhost:4242";
    process.env.JWT_SECRET = "test_jwt_secret_minimum_32_characters_long";

    // MailHog config
    process.env.SMTP_HOST = "mailhog";
    process.env.SMTP_PORT = "1025";
    process.env.SMTP_USER = "test";
    process.env.SMTP_PASS = "test";

    process.env.USE_CHECKOUT = "true";

    // Ensure this suite uses real bcrypt/drizzle behavior even if other tests mock them.
    vi.unmock("bcryptjs");
    vi.unmock("drizzle-orm");
    vi.resetModules();

    stripeMock = {
      paymentIntents: { create: vi.fn() },
      checkout: { sessions: { create: vi.fn() } },
    };
    vi.doMock("../../lib/stripe", () => ({ stripe: stripeMock }));

    const [{ buildServer }, dbModule, schemaModule, authModule, drizzleModule] = await Promise.all([
      import("../../app"),
      import("../../db/client"),
      import("../../db/schema"),
      import("../../lib/auth"),
      import("drizzle-orm"),
    ]);

    db = dbModule.db;
    clients = schemaModule.clients;
    hashApiKey = authModule.hashApiKey;
    sha256Lookup = authModule.sha256Lookup;
    eq = drizzleModule.eq;

    app = await buildServer();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("should create payment successfully with valid API key", async () => {
    // Create a client with a hashed API key
    const clientId = randomUUID();
    const apiKey = `test_api_key_${randomUUID().replace(/-/g, "")}`;
    const apiKeyHash = await hashApiKey(apiKey);

    await db.insert(clients).values({
      id: clientId,
      name: "Test Client",
      email: `payments-${randomUUID()}@example.com`,
      apiKeyHash: apiKeyHash,
      apiKeyLookup: sha256Lookup(apiKey),
      status: "active",
    });

    // Make a request to create a payment with the valid API key
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: {
        "x-api-key": apiKey,
        "idempotency-key": `test-idempotency-key-${randomUUID().replace(/-/g, "")}`,
      },
      payload: {
        amount: 1000,
        currency: "usd",
        description: "Test payment",
      },
    });

    // API key auth succeeds, but the client has no connected Stripe account,
    // so payment creation is rejected before ever calling Stripe.
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "Client Stripe account is not connected or cannot accept charges.",
    });

    // Clean up
    await db.delete(clients).where(eq(clients.id, clientId));
  });

  it("should reject waiveFee from an API-key caller and still apply the platform fee (C1)", async () => {
    const clientId = randomUUID();
    const apiKey = `test_api_key_${randomUUID().replace(/-/g, "")}`;
    const apiKeyHash = await hashApiKey(apiKey);

    // Connected client (stripeAccountId + chargesEnabled: true) so the
    // request passes the ACCOUNT_NOT_CONNECTED gate and actually reaches
    // fee resolution / Stripe PaymentIntent creation.
    await db.insert(clients).values({
      id: clientId,
      name: "Waive Fee Test Client",
      email: `payments-waive-${randomUUID()}@example.com`,
      apiKeyHash: apiKeyHash,
      apiKeyLookup: sha256Lookup(apiKey),
      status: "active",
      stripeAccountId: "acct_waive_fee_test",
      chargesEnabled: true,
      // Fixed, deterministic fee (independent of global settings defaults)
      // so the "fee is still charged" assertion below is not flaky.
      processingFeeCents: 150,
    });

    stripeMock.checkout.sessions.create.mockResolvedValueOnce({
      url: "https://checkout.stripe.com/c/pay/waive_fee_test",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: {
        "x-api-key": apiKey,
        "idempotency-key": `test-idempotency-key-${randomUUID().replace(/-/g, "")}`,
      },
      payload: {
        description: "Test payment",
        waiveFee: true,
        lineItems: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: "Test payment" },
              unit_amount: 1000,
            },
            quantity: 1,
          },
        ],
      },
    });

    // A client-facing API-key caller cannot waive the platform fee (C1) —
    // the request still succeeds, but the application fee is still charged
    // as if waiveFee had not been set.
    expect(response.statusCode).toBe(201);
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent_data: expect.objectContaining({
          application_fee_amount: expect.any(Number),
        }),
      }),
      expect.objectContaining({ stripeAccount: "acct_waive_fee_test" })
    );
    const [callArgs] = stripeMock.checkout.sessions.create.mock.calls;
    expect(callArgs[0].payment_intent_data.application_fee_amount).toBeGreaterThan(0);
    expect(callArgs[0].payment_intent_data.metadata.waivedFeeAmount).toBe("0");

    await db.delete(clients).where(eq(clients.id, clientId));
  });

  it("should return 401 for invalid API key", async () => {
    // Make a request to create a payment with an invalid API key
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: {
        "x-api-key": "invalid-api-key",
        "idempotency-key": `test-idempotency-key-${randomUUID().replace(/-/g, "")}`,
      },
      payload: {
        amount: 1000,
        currency: "usd",
        description: "Test payment",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "Invalid API key.",
    });
  });

  it("should return 401 for missing API key", async () => {
    // Make a request to create a payment without an API key
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: {
        "idempotency-key": `test-idempotency-key-${randomUUID().replace(/-/g, "")}`,
      },
      payload: {
        amount: 1000,
        currency: "usd",
        description: "Test payment",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "Authorization header required",
    });
  });

  it("should return 401 for inactive client", async () => {
    // Create a client with a hashed API key but inactive status
    const clientId = randomUUID();
    const apiKey = `test_inactive_api_key_${randomUUID().replace(/-/g, "")}`;
    const apiKeyHash = await hashApiKey(apiKey);

    await db.insert(clients).values({
      id: clientId,
      name: "Inactive Client",
      email: "inactive@example.com",
      apiKeyHash: apiKeyHash,
      status: "inactive", // This should cause auth to fail
    });

    // Make a request to create a payment with the API key from inactive client
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: {
        "x-api-key": apiKey,
        "idempotency-key": `test-idempotency-key-${randomUUID().replace(/-/g, "")}`,
      },
      payload: {
        amount: 1000,
        currency: "usd",
        description: "Test payment",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "Invalid API key.",
    });

    // Clean up
    await db.delete(clients).where(eq(clients.id, clientId));
  });
});
