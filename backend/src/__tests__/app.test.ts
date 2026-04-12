import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAdminToken } from "./helpers/auth";
import { TEST_WEBHOOK_SECRET } from "./helpers/constants";
import { setTestEnv } from "./helpers/env";
import { createAppDbMock, createNodemailerMock, createStripeMock } from "./helpers/mock-factories";
import { seedClient as _seedClient, seedClientGroup, seedOnboardingToken } from "./helpers/seed";

vi.mock("bcryptjs", () => ({
  default: {
    hash: async (plaintext: string) => `hashed:${plaintext}`,
    compare: async (plaintext: string, hashed: string) => hashed === `hashed:${plaintext}`,
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (field: unknown, value: unknown) => ({ value, field }),
  inArray: (field: unknown, values: unknown[]) => ({ inArray: true, field, values }),
  and: (...conditions: any[]) => ({ all: conditions }),
  isNull: (field: unknown) => ({ isNull: true, field }),
}));

const dataStore = {
  clients: new Map<string, any>(),
  clientsByApiKey: new Map<string, string>(),
  onboardingTokens: new Map<string, any>(),
  webhookEvents: new Map<string, any>(),
  clientGroups: new Map<string, any>(),
  admins: new Map<string, any>(),
};

type MailhogMessage = {
  Content: {
    Headers: {
      Subject: string[];
      To: string[];
    };
  };
};

const realFetch = globalThis.fetch?.bind(globalThis);

if (!realFetch) {
  throw new Error("Global fetch API is not available in the test environment.");
}

const mailhogMessages: MailhogMessage[] = [];

vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  const requestUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input instanceof Request
          ? input.url
          : undefined;

  if (!requestUrl) {
    throw new Error("Request URL is required.");
  }

  if (requestUrl.startsWith("http://localhost:1025/api/v1/messages")) {
    mailhogMessages.length = 0;
    return new Response(null, { status: 204 });
  }

  if (requestUrl.startsWith("http://localhost:1025/api/v2/messages")) {
    return new Response(
      JSON.stringify({
        total: mailhogMessages.length,
        count: mailhogMessages.length,
        items: mailhogMessages,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  }

  return realFetch(input as RequestInfo, init);
});

const dbMock = createAppDbMock(dataStore);

vi.mock("../db/client", () => ({
  db: dbMock,
  __dataStore: dataStore,
}));

const stripeMock = createStripeMock();

vi.mock("../lib/stripe", () => ({
  stripe: stripeMock,
}));

vi.mock("../lib/stripe-billing", () => ({
  stripe: stripeMock,
}));

const nodemailerMock = createNodemailerMock(mailhogMessages, (options: any) => {
  const to = options.to;
  const recipients = Array.isArray(to) ? to.map(String) : [String(to ?? "")];
  return {
    Content: {
      Headers: {
        Subject: [options.subject ?? ""],
        To: recipients,
      },
    },
  };
});

vi.mock("nodemailer", () => nodemailerMock);

function seedClient(opts: Parameters<typeof _seedClient>[1]) {
  return _seedClient(dataStore, opts);
}

beforeEach(async () => {
  setTestEnv();

  try {
    await fetch("http://localhost:1025/api/v1/messages", { method: "DELETE" });
  } catch (error) {
    console.warn("Failed to clear MailHog messages before test execution.", error);
  }

  dataStore.clients.clear();
  dataStore.clientsByApiKey.clear();
  dataStore.onboardingTokens.clear();
  dataStore.webhookEvents.clear();
  dataStore.clientGroups.clear();
  mailhogMessages.length = 0;

  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.API_BASE_URL;
  delete process.env.FRONTEND_ORIGIN;
  delete process.env.USE_CHECKOUT;
  delete process.env.DEFAULT_PROCESS_FEE_CENTS;
});

async function createServer({ skipEnvValidation = false }: { skipEnvValidation?: boolean } = {}) {
  if (skipEnvValidation) {
    vi.doMock("../lib/env", () => ({
      validateEnv: () => ({}),
      logMaskedEnvSummary: () => {},
    }));
  } else {
    vi.unmock("../lib/env");
  }

  vi.resetModules();
  const { buildServer } = await import("../app");
  return buildServer();
}

describe("route guards and validation", () => {
  it("rejects missing API key", async () => {
    const server = await createServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      payload: {},
      headers: {
        "idempotency-key": "abc",
      },
    });

    expect(response.statusCode).toBe(401);
    await server.close();
  });

  it("requires idempotency key on write", async () => {
    const server = await createServer();

    const apiKey = "api-key-client_1";
    seedClient({
      id: "client_1",
      stripeAccountId: "acct_123",
      apiKey,
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: {
        "x-api-key": apiKey,
      },
      payload: {
        amount: 1000,
        currency: "usd",
        applicationFeeAmount: 100,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "Idempotency-Key header is required for API calls.",
    });
    await server.close();
  });
});

describe("payments", () => {
  it("rejects requests with an unknown API key", async () => {
    const server = await createServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: {
        "x-api-key": "unknown-api-key",
        "idempotency-key": "missing-client",
      },
      payload: {
        amount: 500,
        currency: "usd",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid API key." });
    await server.close();
  });

  it("requires client to have a connected account", async () => {
    const server = await createServer();

    const apiKey = "api-key-client_no_connect";
    seedClient({ id: "client_no_connect", stripeAccountId: null, apiKey });

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: {
        "x-api-key": apiKey,
        "idempotency-key": "no-connect",
      },
      payload: {
        amount: 1000,
        currency: "usd",
      },
    });

    expect(response.statusCode).toBe(500); // Platform payment fails without mock setup
    await server.close();
  });

  it("creates a payment intent when USE_CHECKOUT=false", async () => {
    process.env.DEFAULT_PROCESS_FEE_CENTS = "100";
    stripeMock.paymentIntents.create.mockResolvedValue({
      id: "pi_123",
      client_secret: "secret_123",
    });

    const server = await createServer();

    const apiKey = "api-key-client_1";
    seedClient({ id: "client_1", stripeAccountId: "acct_123", apiKey });

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: {
        "x-api-key": apiKey,
        "idempotency-key": "test-key",
      },
      payload: {
        clientId: "different-id",
        amount: 1000,
        currency: "usd",
        applicationFeeAmount: 50,
        metadata: { order: "42" },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(stripeMock.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 1100,
        currency: "usd",
        application_fee_amount: 100,
        metadata: expect.objectContaining({
          clientId: "client_1",
          baseAmount: "1000",
          feeAmount: "100",
          order: "42",
        }),
      }),
      expect.objectContaining({
        stripeAccount: "acct_123",
        idempotencyKey: "test-key",
      })
    );
    expect(response.json()).toEqual({
      clientSecret: "secret_123",
      paymentIntentId: "pi_123",
    });
    await server.close();
  });

  it("validates payment intent amount and fee values", async () => {
    const server = await createServer();

    const apiKey = "api-key-client_invalid_amount";
    seedClient({ id: "client_invalid_amount", stripeAccountId: "acct_123", apiKey });

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: {
        "x-api-key": apiKey,
        "idempotency-key": "invalid-fee",
      },
      payload: {
        currency: "usd",
        applicationFeeAmount: 10,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "amount and currency are required for PaymentIntents.",
    });
    await server.close();
  });

  it("rejects fees that exceed the payment amount", async () => {
    process.env.DEFAULT_PROCESS_FEE_CENTS = "2000";

    const server = await createServer();

    const apiKey = "api-key-client_fee";
    seedClient({ id: "client_fee", stripeAccountId: "acct_123", apiKey });

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: {
        "x-api-key": apiKey,
        "idempotency-key": "too-high-fee",
      },
      payload: {
        amount: 1000,
        currency: "usd",
        applicationFeeAmount: 2000,
      },
    });

    expect(response.statusCode).toBe(201); // Fee validation removed - fees handled by DFWSC
    await server.close();
  });

  it("creates a checkout session when USE_CHECKOUT=true", async () => {
    process.env.USE_CHECKOUT = "true";
    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/c/pay/mock",
    });

    const server = await createServer();

    const apiKey = "api-key-client_1";
    seedClient({ id: "client_1", stripeAccountId: "acct_123", apiKey });

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: {
        "x-api-key": apiKey,
        "idempotency-key": "checkout-key",
      },
      payload: {
        applicationFeeAmount: 100,
        lineItems: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: "Service" },
              unit_amount: 1000,
            },
            quantity: 1,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalled();
    expect(response.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/mock" });
    await server.close();
  });
  it("validates checkout payload requirements", async () => {
    process.env.USE_CHECKOUT = "true";

    const server = await createServer();

    const apiKey = "api-key-client_checkout";
    seedClient({ id: "client_checkout", stripeAccountId: "acct_123", apiKey });

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: {
        "x-api-key": apiKey,
        "idempotency-key": "missing-line-items",
      },
      payload: {
        applicationFeeAmount: 10,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "lineItems are required when USE_CHECKOUT=true." });
    await server.close();
  });

  it("uses client paymentSuccessUrl as checkout success_url when set", async () => {
    process.env.USE_CHECKOUT = "true";
    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/c/pay/mock",
    });

    const server = await createServer();

    const apiKey = "api-key-client_custom_url";
    dataStore.clients.set("client_custom_url", {
      id: "client_custom_url",
      name: "Custom URL Client",
      email: "custom@example.test",
      apiKey,
      apiKeyHash: `hashed:${apiKey}`,
      status: "active",
      stripeAccountId: "acct_custom",
      paymentSuccessUrl: "https://myclient.com/thank-you",
      paymentCancelUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    dataStore.clientsByApiKey.set(apiKey, "client_custom_url");

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: {
        "x-api-key": apiKey,
        "idempotency-key": "custom-url-key",
      },
      payload: {
        lineItems: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: "Service" },
              unit_amount: 1000,
            },
            quantity: 1,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url: "https://myclient.com/thank-you",
      }),
      expect.anything()
    );
    await server.close();
  });

  it("fails when checkout requires a frontend origin but it is not configured", async () => {
    process.env.USE_CHECKOUT = "true";
    delete process.env.FRONTEND_ORIGIN;

    const server = await createServer({ skipEnvValidation: true });

    const apiKey = "api-key-client_checkout";
    seedClient({ id: "client_checkout", stripeAccountId: "acct_123", apiKey });

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: {
        "x-api-key": apiKey,
        "idempotency-key": "no-frontend",
      },
      payload: {
        lineItems: [
          {
            price_data: {
              currency: "usd",
              unit_amount: 1000,
              product_data: { name: "Service" },
            },
            quantity: 1,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "FRONTEND_ORIGIN is not configured." });
    await server.close();
  });
});

describe("connect onboarding", () => {
  it("creates an onboarding token and client via /accounts", async () => {
    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/accounts",
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        name: "New Client",
        email: "owner@example.com",
        workspace: "dfwsc_services",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.onboardingToken).toBeDefined();
    expect(body.onboardingUrlHint).toContain(body.onboardingToken);
    expect(body.apiKey).toBeDefined();
    expect(body.clientId).toBeDefined();

    const savedClient = Array.from(dataStore.clients.values()).find(
      (client) => client.email === "owner@example.com"
    );
    expect(savedClient).toBeDefined();
    expect(savedClient?.apiKeyHash).toBe(`hashed:${body.apiKey}`);
    expect(savedClient?.id).toBe(body.clientId);
    await server.close();
  });

  it("sends onboarding email via /onboard-client/initiate", async () => {
    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/onboard-client/initiate",
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        name: "Client",
        email: "client@example.com",
        workspace: "dfwsc_services",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ message: "Onboarding email sent successfully." });
    expect(body.apiKey).toBeDefined();
    expect(body.clientId).toBeDefined();
    const savedClient = Array.from(dataStore.clients.values()).find(
      (client) => client.email === "client@example.com"
    );
    expect(savedClient?.apiKeyHash).toBe(`hashed:${body.apiKey}`);
    expect(savedClient?.id).toBe(body.clientId);
    expect(mailhogMessages.length).toBe(1);
    expect(mailhogMessages[0].Content.Headers.Subject[0]).toBe(
      "DFW Software Consulting - Stripe Onboarding"
    );
    expect(mailhogMessages[0].Content.Headers.To[0]).toBe("client@example.com");
    await server.close();
  });

  it("creates an account link from a pending onboarding token", async () => {
    stripeMock.accounts.create.mockResolvedValue({ id: "acct_new" });
    stripeMock.accountLinks.create.mockResolvedValue({
      url: "https://connect.stripe.com/setup/mock",
    });

    process.env.API_BASE_URL = "https://api.example.com";

    const clientId = "client_onboard";
    seedClient({
      id: clientId,
      stripeAccountId: null,
      name: "Pending Client",
      email: "pending@example.com",
    });

    const onboardingTokenId = "token_1";
    const onboardingToken = "token_value_1";
    seedOnboardingToken(dataStore, {
      id: onboardingTokenId,
      clientId,
      token: onboardingToken,
      status: "pending",
      email: "pending@example.com",
    });

    const server = await createServer();

    const response = await server.inject({
      method: "GET",
      url: `/api/v1/onboard-client?token=${onboardingToken}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ url: "https://connect.stripe.com/setup/mock" });
    expect(stripeMock.accounts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "pending@example.com",
        metadata: { clientId },
      })
    );
    const updatedToken = dataStore.onboardingTokens.get(onboardingTokenId);
    expect(updatedToken?.status).toBe("in_progress");
    expect(updatedToken?.state).toBeDefined();
    expect(stripeMock.accountLinks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        account: "acct_new",
        type: "account_onboarding",
        refresh_url: `https://api.example.com/api/v1/connect/refresh?token=${onboardingToken}`,
        return_url: `https://api.example.com/api/v1/connect/callback?client_id=client_onboard&state=${updatedToken?.state}`,
      })
    );

    const updatedClient = dataStore.clients.get(clientId);
    expect(updatedClient?.stripeAccountId).toBe("acct_new");
    await server.close();
  });
});

describe("connect callback", () => {
  it("rejects callback without state", async () => {
    const server = await createServer();
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/connect/callback?client_id=client_1&account=acct_123",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Missing state parameter." });
    await server.close();
  });

  it("rejects callback with invalid state", async () => {
    const server = await createServer();
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/connect/callback?client_id=client_1&account=acct_123&state=invalid",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid or expired state parameter." });
    await server.close();
  });

  it("rejects callback with expired state", async () => {
    const clientId = "client_expired_state";
    const onboardingTokenId = "token_expired";
    seedOnboardingToken(dataStore, {
      id: onboardingTokenId,
      clientId,
      token: "expired_token",
      status: "in_progress",
      email: "test@test.com",
      state: "expired_state_val",
      stateExpiresAt: new Date(Date.now() - 1000),
    });
    const server = await createServer();
    const response = await server.inject({
      method: "GET",
      url: `/api/v1/connect/callback?client_id=${clientId}&account=acct_123&state=expired_state_val`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Expired state parameter." });
    await server.close();
  });

  it("redirects to the frontend success page when the client exists", async () => {
    const clientId = "client_existing";
    seedClient({
      id: clientId,
      name: "Existing Client",
      email: "existing@example.com",
      stripeAccountId: null,
    });
    const onboardingTokenId = "token_existing";
    const state = "state_existing";
    seedOnboardingToken(dataStore, {
      id: onboardingTokenId,
      clientId,
      token: "token_value_existing",
      status: "in_progress",
      email: "existing@example.com",
      state,
      stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    const server = await createServer();

    const origin = process.env.FRONTEND_ORIGIN;

    const response = await server.inject({
      method: "GET",
      url: `/api/v1/connect/callback?client_id=${clientId}&account=acct_789&state=${state}`,
    });

    expect(response.statusCode).toBe(302);
    expect(origin).toBeDefined();
    expect(response.headers.location).toBe(`${origin}/onboarding-success`);

    const updatedClient = dataStore.clients.get(clientId);
    expect(updatedClient?.stripeAccountId).toBe("acct_789");
    const updatedToken = dataStore.onboardingTokens.get(onboardingTokenId);
    expect(updatedToken?.status).toBe("completed");

    await server.close();
  });

  it("fails when no frontend origin is configured for the connect callback", async () => {
    delete process.env.FRONTEND_ORIGIN;

    const clientId = "client_json";
    seedClient({
      id: clientId,
      name: "Json Client",
      email: "json@example.com",
      stripeAccountId: null,
    });
    const onboardingTokenId = "token_json";
    const state = "state_json";
    seedOnboardingToken(dataStore, {
      id: onboardingTokenId,
      clientId,
      token: "token_value_json",
      status: "in_progress",
      email: "json@example.com",
      state,
      stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    const server = await createServer({ skipEnvValidation: true });

    const response = await server.inject({
      method: "GET",
      url: `/api/v1/connect/callback?client_id=${clientId}&account=acct_json&state=${state}`,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: "Server configuration error: FRONTEND_ORIGIN not set.",
    });

    await server.close();
  });

  it("returns 400 when the client cannot be found during callback", async () => {
    const clientId = "missing";
    const onboardingTokenId = "token_missing";
    const state = "state_missing";
    seedOnboardingToken(dataStore, {
      id: onboardingTokenId,
      clientId,
      token: "token_value_missing",
      status: "in_progress",
      email: "missing@example.com",
      state,
      stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    const server = await createServer();

    const response = await server.inject({
      method: "GET",
      url: `/api/v1/connect/callback?client_id=${clientId}&account=acct_missing&state=${state}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Client not found." });

    await server.close();
  });

  it("rejects callback when required query parameters are missing", async () => {
    const server = await createServer();

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/connect/callback",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Missing state parameter." });

    await server.close();
  });

  it("rejects callback when account is missing and preserves onboarding state", async () => {
    const clientId = "client_missing_account";
    seedClient({
      id: clientId,
      name: "Missing Account Client",
      email: "missing-account@example.com",
      stripeAccountId: null,
    });
    const onboardingTokenId = "token_missing_account";
    const state = "state_missing_account";
    seedOnboardingToken(dataStore, {
      id: onboardingTokenId,
      clientId,
      token: "token_value_missing_account",
      status: "in_progress",
      email: "missing-account@example.com",
      state,
      stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    const server = await createServer();

    const response = await server.inject({
      method: "GET",
      url: `/api/v1/connect/callback?client_id=${clientId}&state=${state}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Missing account parameter." });

    const updatedClient = dataStore.clients.get(clientId);
    expect(updatedClient?.stripeAccountId).toBeNull();
    const updatedToken = dataStore.onboardingTokens.get(onboardingTokenId);
    expect(updatedToken?.status).toBe("in_progress");

    await server.close();
  });
});

describe("reports", () => {
  it("requires clientId or groupId query parameter", async () => {
    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/reports/payments?workspace=dfwsc_services",
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "clientId or groupId query parameter is required." });
    await server.close();
  });

  it("returns 404 when the client does not exist", async () => {
    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/reports/payments?clientId=unknown&workspace=dfwsc_services",
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Client with connected account not found." });
    await server.close();
  });

  it("validates limit parameter", async () => {
    seedClient({ id: "client_invalid_limit", stripeAccountId: "acct_123" });

    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/reports/payments?clientId=client_invalid_limit&limit=200&workspace=dfwsc_services",
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "limit must be an integer between 1 and 100." });
    await server.close();
  });

  it("lists payment intents for a client", async () => {
    stripeMock.paymentIntents.list.mockResolvedValue({ data: [], has_more: false });

    const server = await createServer();
    const adminToken = makeAdminToken();

    seedClient({ id: "client_1", stripeAccountId: "acct_123" });

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/reports/payments?clientId=client_1&limit=5&workspace=dfwsc_services",
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(stripeMock.paymentIntents.list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 }),
      expect.objectContaining({ stripeAccount: "acct_123" })
    );
    await server.close();
  });
});

describe("webhooks", () => {
  it("rejects missing signature headers", async () => {
    const server = await createServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/webhooks/stripe",
      payload: "{}",
      headers: {
        "content-type": "application/json",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Missing Stripe-Signature header." });
    await server.close();
  });

  it("rejects invalid signatures", async () => {
    const server = await createServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/webhooks/stripe",
      payload: "{}",
      headers: {
        "stripe-signature": "invalid",
        "content-type": "application/json",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("Webhook Error:");
    await server.close();
  });

  it("verifies Stripe signatures and stores events", async () => {
    const payload = JSON.stringify({
      id: "evt_test",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_123", status: "succeeded" } },
    });
    const signature = stripeMock.webhooks.generateTestHeaderString({
      payload,
      secret: TEST_WEBHOOK_SECRET,
    });

    const server = await createServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/webhooks/stripe",
      payload,
      headers: {
        "stripe-signature": signature,
        "content-type": "application/json",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(dataStore.webhookEvents.has("evt_test")).toBe(true);
    await server.close();
  });
});

describe("app-config", () => {
  it("returns API_URL from environment variables, ignoring host headers", async () => {
    process.env.API_BASE_URL = "https://my-api.com/api";
    const server = await createServer();
    const response = await server.inject({
      method: "GET",
      url: "/app-config.js",
      headers: {
        host: "evil.com",
        "x-forwarded-host": "evil.com",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/javascript");
    expect(response.body).toBe('window.API_URL = "https://my-api.com/api";');
    await server.close();
  });
});

describe("email", () => {
  it("sends an onboarding email", async () => {
    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/onboard-client/initiate",
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        name: "Test Client",
        email: "test@example.com",
        workspace: "dfwsc_services",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ message: "Onboarding email sent successfully." });
    expect(mailhogMessages.length).toBe(1);
    expect(mailhogMessages[0].Content.Headers.Subject[0]).toBe(
      "DFW Software Consulting - Stripe Onboarding"
    );
    expect(mailhogMessages[0].Content.Headers.To[0]).toBe("test@example.com");
    await server.close();
  });
});

describe("client groups", () => {
  it("creates a group", async () => {
    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/groups",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "Acme Properties", workspace: "dfwsc_services" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBe("Acme Properties");
    expect(body.status).toBe("active");
    await server.close();
  });

  it("rejects group creation without a name", async () => {
    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/groups",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { workspace: "dfwsc_services" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "name is required." });
    await server.close();
  });

  it("lists groups", async () => {
    seedClientGroup(dataStore, { id: "grp_1", name: "Group One", workspace: "dfwsc_services" });

    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/groups?workspace=dfwsc_services",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.length).toBe(1);
    expect(body[0].id).toBe("grp_1");
    await server.close();
  });

  it("updates a group name and status", async () => {
    seedClientGroup(dataStore, { id: "grp_2", name: "Old Name", workspace: "dfwsc_services" });

    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/groups/grp_2",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "New Name", status: "inactive" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.name).toBe("New Name");
    expect(body.status).toBe("inactive");
    await server.close();
  });

  it("returns 404 when patching a non-existent group", async () => {
    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/groups/does_not_exist",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "Whatever", workspace: "dfwsc_services" },
    });

    expect(response.statusCode).toBe(404);
    await server.close();
  });

  it("filters GET /clients by groupId", async () => {
    seedClientGroup(dataStore, { id: "grp_3", name: "PropCo", workspace: "dfwsc_services" });
    seedClient({ id: "c_a", stripeAccountId: "acct_a", workspace: "dfwsc_services" });
    seedClient({ id: "c_b", stripeAccountId: "acct_b", workspace: "dfwsc_services" });
    dataStore.clients.get("c_a").groupId = "grp_3";
    dataStore.clients.get("c_b").groupId = "grp_3";
    seedClient({ id: "c_other", stripeAccountId: "acct_other", workspace: "dfwsc_services" });

    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/clients?groupId=grp_3&workspace=dfwsc_services",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.length).toBe(2);
    expect(body.every((c: any) => c.groupId === "grp_3")).toBe(true);
    await server.close();
  });

  it("assigns a groupId to a client via PATCH /clients/:id", async () => {
    seedClientGroup(dataStore, { id: "grp_4", name: "MegaCo", workspace: "dfwsc_services" });
    seedClient({ id: "c_patch", stripeAccountId: "acct_p", workspace: "dfwsc_services" });

    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/clients/c_patch",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { groupId: "grp_4" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().groupId).toBe("grp_4");
    await server.close();
  });

  it("rejects assigning a non-existent groupId to a client", async () => {
    seedClient({ id: "c_bad_grp", stripeAccountId: "acct_bg", workspace: "dfwsc_services" });

    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/clients/c_bad_grp",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { groupId: "nonexistent_group" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Group not found." });
    await server.close();
  });

  it("aggregates payments for a group via GET /reports/payments?groupId=", async () => {
    seedClientGroup(dataStore, { id: "grp_5", name: "PropGroup", workspace: "dfwsc_services" });
    seedClient({ id: "gc_1", stripeAccountId: "acct_gc1", workspace: "dfwsc_services" });
    seedClient({ id: "gc_2", stripeAccountId: "acct_gc2", workspace: "dfwsc_services" });
    dataStore.clients.get("gc_1").groupId = "grp_5";
    dataStore.clients.get("gc_2").groupId = "grp_5";

    stripeMock.paymentIntents.list
      .mockResolvedValueOnce({ data: [{ id: "pi_gc1" }], has_more: false })
      .mockResolvedValueOnce({ data: [{ id: "pi_gc2" }], has_more: false });

    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/reports/payments?groupId=grp_5&workspace=dfwsc_services",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.groupId).toBe("grp_5");
    expect(body.data.length).toBe(2);
    expect(body.data.map((p: any) => p.id)).toEqual(expect.arrayContaining(["pi_gc1", "pi_gc2"]));
    await server.close();
  });

  it("returns 404 for reports with a non-existent groupId", async () => {
    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/reports/payments?groupId=no_such_group&workspace=dfwsc_services",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Group not found." });
    await server.close();
  });
});

describe("DFWSC client creation", () => {
  it("creates a client with Stripe Customer and returns stripeCustomerId", async () => {
    const server = await createServer();
    const adminToken = makeAdminToken();

    stripeMock.customers.create.mockResolvedValueOnce({
      id: "cus_dfwsc123",
      email: "test@example.com",
      name: "Test Client",
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/dfwsc/clients",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: "Test Client",
        email: "test@example.com",
        phone: "+1234567890",
        billingContactName: "John Doe",
        addressLine1: "123 Main St",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.name).toBe("Test Client");
    expect(body.email).toBe("test@example.com");
    expect(body.stripeCustomerId).toBe("cus_dfwsc123");
    expect(body.status).toBe("active");
    expect(body.phone).toBe("+1234567890");
    expect(body.billingContactName).toBe("John Doe");
    expect(body.addressLine1).toBe("123 Main St");
    expect(body.city).toBe("Austin");
    expect(body.state).toBe("TX");
    expect(body.postalCode).toBe("78701");
    expect(body.country).toBe("US");
    expect(stripeMock.customers.create).toHaveBeenCalledWith({
      email: "test@example.com",
      name: "Test Client",
      phone: "+1234567890",
      metadata: { clientId: expect.any(String) },
    });
    await server.close();
  });

  it("creates a client with only required fields (name, email)", async () => {
    const server = await createServer();
    const adminToken = makeAdminToken();

    stripeMock.customers.create.mockResolvedValueOnce({
      id: "cus_minimal",
      email: "minimal@example.com",
      name: "Minimal Client",
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/dfwsc/clients",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: "Minimal Client",
        email: "minimal@example.com",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.name).toBe("Minimal Client");
    expect(body.email).toBe("minimal@example.com");
    expect(body.stripeCustomerId).toBe("cus_minimal");
    expect(body.phone).toBeNull();
    expect(body.addressLine1).toBeNull();
    await server.close();
  });

  it("rejects duplicate email", async () => {
    seedClient({
      id: "existing_client",
      email: "existing@example.com",
      workspace: "dfwsc_services",
    });

    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/dfwsc/clients",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: "Duplicate Client",
        email: "existing@example.com",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("A client with this email already exists.");
    await server.close();
  });

  it("rejects missing name", async () => {
    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/dfwsc/clients",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        email: "test@example.com",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("name and email are required.");
    await server.close();
  });

  it("rejects missing email", async () => {
    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/dfwsc/clients",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: "Test Client",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("name and email are required.");
    await server.close();
  });

  it("rejects unauthenticated request", async () => {
    const server = await createServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/dfwsc/clients",
      payload: {
        name: "Test Client",
        email: "test@example.com",
      },
    });

    expect(response.statusCode).toBe(401);
    await server.close();
  });
});
