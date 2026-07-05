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
  count: () => ({ fn: "count" }),
  eq: (field: unknown, value: unknown) => ({ value, field }),
  ne: (field: unknown, value: unknown) => ({ not: true, value, field }),
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
    Body: string;
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
  resolveClientFee: vi.fn(async (_client: any, _group: any, _amount?: number) => {
    // Default fee calculation: use DEFAULT_PROCESS_FEE_CENTS env var or 0
    return Number(process.env.DEFAULT_PROCESS_FEE_CENTS ?? 0);
  }),
  ensureStripeCustomer: vi.fn(async (client: any) => {
    return `cus_${client.id}`;
  }),
  toStripeInterval: vi.fn((interval: string) => {
    switch (interval) {
      case "week":
        return { interval: "week", interval_count: 1 };
      case "bi_weekly":
        return { interval: "week", interval_count: 2 };
      case "month":
      case "monthly":
        return { interval: "month", interval_count: 1 };
      case "quarter":
      case "quarterly":
        return { interval: "month", interval_count: 3 };
      case "year":
      case "yearly":
        return { interval: "year", interval_count: 1 };
      default:
        return { interval: "month", interval_count: 1 };
    }
  }),
  calculateIterations: vi.fn(() => 12),
  getSettings: vi.fn(async () => ({
    default_fee_cents: process.env.DEFAULT_PROCESS_FEE_CENTS ?? "0",
  })),
}));

const nodemailerMock = createNodemailerMock(mailhogMessages, (options: any) => {
  const to = options.to;
  const recipients = Array.isArray(to) ? to.map(String) : [String(to ?? "")];
  return {
    Content: {
      Body: options.html ?? "",
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
    process.env.DEFAULT_PROCESS_FEE_CENTS = "100";

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

    // A client without a connected + charges-enabled Stripe account cannot
    // accept payments (H1).
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "Client Stripe account is not connected or cannot accept charges.",
    });
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    await server.close();
  });

  it("allows fees that exceed the payment amount (fees handled by DFWSC)", async () => {
    process.env.USE_CHECKOUT = "true";
    process.env.DEFAULT_PROCESS_FEE_CENTS = "2000";
    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/c/pay/mock",
    });

    const server = await createServer();

    const apiKey = "api-key-client_fee";
    seedClient({ id: "client_fee", stripeAccountId: "acct_123", chargesEnabled: true, apiKey });

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/payments/create",
      headers: {
        "x-api-key": apiKey,
        "idempotency-key": "too-high-fee",
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

    // Fee validation removed - fees handled by DFWSC
    expect(response.statusCode).toBe(201);
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalled();
    await server.close();
  });

  it("creates a checkout session", async () => {
    process.env.USE_CHECKOUT = "true";
    process.env.DEFAULT_PROCESS_FEE_CENTS = "100";
    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/c/pay/mock",
    });

    const server = await createServer();

    const apiKey = "api-key-client_checkout";
    seedClient({
      id: "client_checkout",
      stripeAccountId: "acct_checkout",
      chargesEnabled: true,
      apiKey,
    });

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
    seedClient({
      id: "client_checkout",
      stripeAccountId: "acct_123",
      chargesEnabled: true,
      apiKey,
    });

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
    expect(response.json()).toMatchObject({
      error: "lineItems are required when USE_CHECKOUT=true.",
    });
    await server.close();
  });

  it("uses client paymentSuccessUrl as checkout success_url when set", async () => {
    process.env.USE_CHECKOUT = "true";
    process.env.DEFAULT_PROCESS_FEE_CENTS = "100";
    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/c/pay/mock",
    });

    const server = await createServer();

    const apiKey = "api-key-client_custom_url";
    seedClient({
      id: "client_custom_url",
      name: "Custom URL Client",
      email: "custom@example.test",
      apiKey,
      stripeAccountId: "acct_custom",
      chargesEnabled: true,
      paymentSuccessUrl: "https://myclient.com/thank-you",
      paymentCancelUrl: null,
    });

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

    expect(
      response.statusCode,
      `Expected 201 but got ${response.statusCode}: ${JSON.stringify(response.json())}`
    ).toBe(201);
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
    seedClient({
      id: "client_checkout",
      stripeAccountId: "acct_123",
      chargesEnabled: true,
      apiKey,
    });

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
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("FRONTEND_ORIGIN is not configured"),
    });
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
        workspace: "client_portal",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    // The raw onboarding token is no longer returned in the /accounts
    // response (L24/M21) — only a non-secret hint URL is included.
    expect(body.onboardingToken).toBeUndefined();
    expect(body.onboardingUrlHint).toBeDefined();
    expect(body.apiKey).toBeDefined();
    expect(body.clientId).toBeDefined();

    const savedClient = Array.from(dataStore.clients.values()).find(
      (client) => client.email === "owner@example.com"
    );
    expect(savedClient).toBeDefined();
    expect(savedClient?.apiKeyHash).toBe(`hashed:${body.apiKey}`);
    expect(savedClient?.id).toBe(body.clientId);

    const savedToken = Array.from(dataStore.onboardingTokens.values()).find(
      (token) => token.clientId === body.clientId
    );
    expect(savedToken).toBeDefined();
    const rawToken = new URLSearchParams(new URL(body.onboardingUrlHint).hash.slice(1)).get(
      "token"
    );
    expect(rawToken).toBeTruthy();
    expect(savedToken?.token).not.toBe(rawToken);
    expect(savedToken?.token).toHaveLength(64);
    await server.close();
  });

  it("creates a direct billable DFWSC client via /accounts", async () => {
    stripeMock.customers.create.mockResolvedValue({ id: "cus_ledger_1" });

    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/accounts",
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        name: "Ledger Client",
        email: "ledger@example.com",
        workspace: "client_portal",
      },
    });

    expect(response.statusCode).toBe(201);
    const json = response.json();
    expect(json.name).toBe("Ledger Client");
    expect(json.clientId).toBeDefined();
    expect(json.apiKey).toBeDefined();
    expect(json.onboardingToken).toBeUndefined();
    expect(json.onboardingUrlHint).toBeDefined();
    expect(json.workspace).toBe("client_portal");

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
        workspace: "client_portal",
      },
    });

    expect(
      response.statusCode,
      `Expected 201 but got ${response.statusCode}: ${JSON.stringify(response.json())}`
    ).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ message: "Onboarding email sent successfully." });
    expect(body.apiKey).toBeNull();
    expect(body.clientId).toBeDefined();
    const savedClient = Array.from(dataStore.clients.values()).find(
      (client) => client.email === "client@example.com"
    );
    expect(savedClient?.apiKeyHash).toMatch(/^hashed:.+/);
    expect(savedClient?.id).toBe(body.clientId);
    expect(mailhogMessages.length).toBe(1);
    expect(mailhogMessages[0].Content.Headers.Subject[0]).toBe(
      "DFW Software Consulting - Stripe Onboarding"
    );
    expect(mailhogMessages[0].Content.Headers.To[0]).toBe("client@example.com");
    expect(mailhogMessages[0].Content.Body).toContain("/onboard#token=");
    expect(mailhogMessages[0].Content.Body).toContain("/regenerate-key#token=");
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
      method: "POST",
      url: "/api/v1/onboard-client",
      payload: { token: onboardingToken },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ url: "https://connect.stripe.com/setup/mock" });
    expect(stripeMock.accounts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "pending@example.com",
        metadata: { clientId },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      }),
      expect.objectContaining({ idempotencyKey: `acct-create-${clientId}` })
    );
    const updatedToken = dataStore.onboardingTokens.get(onboardingTokenId);
    expect(updatedToken?.status).toBe("in_progress");
    expect(updatedToken?.state).toBeDefined();
    expect(stripeMock.accountLinks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        account: "acct_new",
        type: "account_onboarding",
        refresh_url: `https://api.example.com/api/v1/connect/refresh?client_id=client_onboard&state=${updatedToken?.state}`,
        return_url: `https://api.example.com/api/v1/connect/callback?client_id=client_onboard&state=${updatedToken?.state}`,
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String) })
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
    expect(response.json()).toMatchObject({ error: "Missing state parameter." });
    await server.close();
  });

  it("rejects callback with invalid state", async () => {
    const server = await createServer();
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/connect/callback?client_id=client_1&account=acct_123&state=invalid",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Invalid or expired state parameter." });
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
    expect(response.json()).toMatchObject({ error: "Expired state parameter." });
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

    stripeMock.accounts.retrieve.mockResolvedValue({
      type: "express",
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
    });

    const origin = process.env.FRONTEND_ORIGIN;

    const response = await server.inject({
      method: "GET",
      url: `/api/v1/connect/callback?client_id=${clientId}&account=acct_789&state=${state}`,
    });

    expect(response.statusCode).toBe(302);
    expect(origin).toBeDefined();
    expect(response.headers.location).toBe(`${origin}/onboarding-success?status=completed`);

    const updatedClient = dataStore.clients.get(clientId);
    expect(updatedClient?.stripeAccountId).toBe("acct_789");
    expect(updatedClient?.chargesEnabled).toBe(true);
    expect(updatedClient?.payoutsEnabled).toBe(true);
    expect(updatedClient?.detailsSubmitted).toBe(true);
    const updatedToken = dataStore.onboardingTokens.get(onboardingTokenId);
    expect(updatedToken?.status).toBe("completed");

    await server.close();
  });

  it("resolves account from stored stripeAccountId when account param omitted", async () => {
    const clientId = "client_stored_acct";
    seedClient({
      id: clientId,
      name: "Stored Account Client",
      email: "stored@example.com",
      stripeAccountId: "acct_stored",
    });
    const onboardingTokenId = "token_stored_acct";
    const state = "state_stored_acct";
    seedOnboardingToken(dataStore, {
      id: onboardingTokenId,
      clientId,
      token: "token_value_stored_acct",
      status: "in_progress",
      email: "stored@example.com",
      state,
      stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    const server = await createServer();

    stripeMock.accounts.retrieve.mockResolvedValue({
      type: "express",
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
    });

    const origin = process.env.FRONTEND_ORIGIN;

    const response = await server.inject({
      method: "GET",
      url: `/api/v1/connect/callback?client_id=${clientId}&state=${state}`,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${origin}/onboarding-success?status=completed`);
    expect(stripeMock.accounts.retrieve).toHaveBeenCalledWith("acct_stored");

    const updatedToken = dataStore.onboardingTokens.get(onboardingTokenId);
    expect(updatedToken?.status).toBe("completed");

    await server.close();
  });

  it("keeps token in_progress when details_submitted is false", async () => {
    const clientId = "client_not_submitted";
    seedClient({
      id: clientId,
      name: "Not Submitted Client",
      email: "notsubmitted@example.com",
      stripeAccountId: "acct_notsubmitted",
    });
    const onboardingTokenId = "token_not_submitted";
    const state = "state_not_submitted";
    seedOnboardingToken(dataStore, {
      id: onboardingTokenId,
      clientId,
      token: "token_value_not_submitted",
      status: "in_progress",
      email: "notsubmitted@example.com",
      state,
      stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    const server = await createServer();

    stripeMock.accounts.retrieve.mockResolvedValue({
      type: "express",
      details_submitted: false,
      charges_enabled: false,
      payouts_enabled: false,
    });

    const origin = process.env.FRONTEND_ORIGIN;

    const response = await server.inject({
      method: "GET",
      url: `/api/v1/connect/callback?client_id=${clientId}&state=${state}`,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${origin}/onboarding-success?status=pending`);

    const updatedToken = dataStore.onboardingTokens.get(onboardingTokenId);
    expect(updatedToken?.status).toBe("in_progress");

    const updatedClient = dataStore.clients.get(clientId);
    expect(updatedClient?.detailsSubmitted).toBe(false);

    await server.close();
  });

  it("fails when no frontend origin is configured for the connect callback", async () => {
    delete process.env.FRONTEND_ORIGIN;

    const clientId = "client_json";
    seedClient({
      id: clientId,
      name: "Json Client",
      email: "json@example.com",
      stripeAccountId: "acct_json",
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

    stripeMock.accounts.retrieve.mockResolvedValue({
      type: "express",
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
    });

    const response = await server.inject({
      method: "GET",
      url: `/api/v1/connect/callback?client_id=${clientId}&account=acct_json&state=${state}`,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json().error).toBe("FRONTEND_ORIGIN is not configured.");
    expect(response.json().code).toBe("CONFIGURATION_ERROR");

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

    stripeMock.accounts.retrieve.mockResolvedValue({
      type: "express",
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
    });

    const response = await server.inject({
      method: "GET",
      url: `/api/v1/connect/callback?client_id=${clientId}&account=acct_missing&state=${state}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Client not found." });

    await server.close();
  });

  it("rejects callback when required query parameters are missing", async () => {
    const server = await createServer();

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/connect/callback",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Missing state parameter." });

    await server.close();
  });

  it("redirects to success and keeps token in_progress when account param omitted and no stored account", async () => {
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

    const origin = process.env.FRONTEND_ORIGIN;
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${origin}/onboarding-success?status=pending`);

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
      url: "/api/v1/reports/payments?workspace=client_portal",
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "clientId or groupId query parameter is required.",
    });
    await server.close();
  });

  it("returns 404 when the client does not exist", async () => {
    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/reports/payments?clientId=unknown&workspace=client_portal",
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "Client not found." });
    await server.close();
  });

  it("validates limit parameter", async () => {
    seedClient({ id: "client_invalid_limit", stripeAccountId: "acct_123" });

    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/reports/payments?clientId=client_invalid_limit&limit=200&workspace=client_portal",
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "limit must be an integer between 1 and 100." });
    await server.close();
  });

  it("lists payment intents for a client", async () => {
    stripeMock.paymentIntents.list.mockResolvedValue({ data: [], has_more: false });

    const server = await createServer();
    const adminToken = makeAdminToken();

    seedClient({ id: "client_1", workspace: "client_portal", stripeAccountId: "acct_test_1" });

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/reports/payments?clientId=client_1&limit=5&workspace=client_portal",
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(stripeMock.paymentIntents.list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 }),
      expect.objectContaining({ stripeAccount: "acct_test_1" })
    );
    await server.close();
  });

  it("lists workspace payments for group clients by connected account", async () => {
    seedClientGroup(dataStore, {
      id: "grp_payments",
      name: "Payments Group",
      workspace: "client_portal",
    });
    seedClient({
      id: "dfwsc_client_1",
      name: "DFWSC A",
      email: "dfwsc-a@example.com",
      workspace: "client_portal",
      stripeAccountId: "acct_ledger_a",
      groupId: "grp_payments",
    });
    seedClient({
      id: "dfwsc_client_2",
      name: "DFWSC B",
      email: "dfwsc-b@example.com",
      workspace: "client_portal",
      stripeAccountId: "acct_ledger_b",
      groupId: "grp_payments",
    });
    seedClient({
      id: "dfwsc_client_3",
      name: "DFWSC C",
      email: "dfwsc-c@example.com",
      workspace: "client_portal",
      stripeAccountId: null,
      groupId: null,
    });

    stripeMock.paymentIntents.list
      .mockResolvedValueOnce({ data: [{ id: "pi_ledger_a" }], has_more: false })
      .mockResolvedValueOnce({ data: [{ id: "pi_ledger_b" }], has_more: false });

    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/reports/payments?groupId=grp_payments&workspace=client_portal",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.groupId).toBe("grp_payments");
    expect(body.data).toHaveLength(2);
    expect(body.data.map((p: { id: string }) => p.id)).toEqual(
      expect.arrayContaining(["pi_ledger_a", "pi_ledger_b"])
    );
    expect(stripeMock.paymentIntents.list).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ stripeAccount: "acct_ledger_a" })
    );
    expect(stripeMock.paymentIntents.list).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ stripeAccount: "acct_ledger_b" })
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

  it("stores invoice.payment_failed events", async () => {
    seedClient({
      id: "ledger_webhook_client",
      workspace: "client_portal",
      stripeAccountId: "acct_webhook_test",
    });

    const payload = JSON.stringify({
      id: "evt_invoice_failed",
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_failed",
          customer: "cus_ledger_webhook",
          metadata: {},
        },
      },
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
    expect(dataStore.webhookEvents.has("evt_invoice_failed")).toBe(true);

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
        workspace: "client_portal",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ message: "Onboarding email sent successfully." });
    expect(response.json().apiKey).toBeNull();
    expect(mailhogMessages.length).toBe(1);
    expect(mailhogMessages[0].Content.Headers.Subject[0]).toBe(
      "DFW Software Consulting - Stripe Onboarding"
    );
    expect(mailhogMessages[0].Content.Headers.To[0]).toBe("test@example.com");
    expect(mailhogMessages[0].Content.Body).toContain("/regenerate-key#token=");
    await server.close();
  });
});

describe("client groups", () => {
  it("creates a group", async () => {
    const server = await createServer();
    const adminToken = makeAdminToken();

    // POST /groups now persists via `.insert(...).values(...).returning()`
    // (L25). The shared db mock's insert() for client_groups doesn't chain a
    // `.returning()` off `.values()`, so wrap it for this call: run the
    // original side effect (which populates dataStore.clientGroups), then
    // read the inserted row back for `.returning()`.
    const originalInsertImpl = dbMock.insert.getMockImplementation();
    dbMock.insert.mockImplementationOnce((table: any) => {
      const original = originalInsertImpl?.(table);
      return {
        values: (payload: any) => {
          const result = original?.values(payload);
          return {
            ...result,
            returning: async () => [dataStore.clientGroups.get(payload.id)],
          };
        },
      };
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/groups",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "Acme Properties", workspace: "client_portal" },
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
      payload: { workspace: "client_portal" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "name is required." });
    await server.close();
  });

  it("lists groups", async () => {
    seedClientGroup(dataStore, { id: "grp_1", name: "Group One", workspace: "client_portal" });

    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/groups?workspace=client_portal",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0].id).toBe("grp_1");
    await server.close();
  });

  it("updates a group name and status", async () => {
    seedClientGroup(dataStore, { id: "grp_2", name: "Old Name", workspace: "client_portal" });

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
      payload: { name: "Whatever", workspace: "client_portal" },
    });

    expect(response.statusCode).toBe(404);
    await server.close();
  });

  it("filters GET /clients by groupId", async () => {
    seedClientGroup(dataStore, { id: "grp_3", name: "PropCo", workspace: "client_portal" });
    seedClient({ id: "c_a", stripeAccountId: "acct_a", workspace: "client_portal" });
    seedClient({ id: "c_b", stripeAccountId: "acct_b", workspace: "client_portal" });
    dataStore.clients.get("c_a").groupId = "grp_3";
    dataStore.clients.get("c_b").groupId = "grp_3";
    seedClient({ id: "c_other", stripeAccountId: "acct_other", workspace: "client_portal" });

    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/clients?groupId=grp_3&workspace=client_portal",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.length).toBe(2);
    expect(body.data.every((c: any) => c.groupId === "grp_3")).toBe(true);
    await server.close();
  });

  it("assigns a groupId to a client via PATCH /clients/:id", async () => {
    seedClientGroup(dataStore, { id: "grp_4", name: "MegaCo", workspace: "client_portal" });
    seedClient({ id: "c_patch", stripeAccountId: "acct_p", workspace: "client_portal" });

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
    seedClient({ id: "c_bad_grp", stripeAccountId: "acct_bg", workspace: "client_portal" });

    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/clients/c_bad_grp",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { groupId: "nonexistent_group" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Group not found." });
    await server.close();
  });

  it("aggregates payments for a group via GET /reports/payments?groupId=", async () => {
    seedClientGroup(dataStore, { id: "grp_5", name: "PropGroup", workspace: "client_portal" });
    seedClient({
      id: "gc_1",
      stripeAccountId: "acct_gc1",
      workspace: "client_portal",
      groupId: "grp_5",
    });
    seedClient({
      id: "gc_2",
      stripeAccountId: "acct_gc2",
      workspace: "client_portal",
      groupId: "grp_5",
    });

    stripeMock.paymentIntents.list
      .mockResolvedValueOnce({ data: [{ id: "pi_gc1" }], has_more: false })
      .mockResolvedValueOnce({ data: [{ id: "pi_gc2" }], has_more: false });

    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/reports/payments?groupId=grp_5&workspace=client_portal",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.groupId).toBe("grp_5");
    expect(body.data.length).toBe(2);
    expect(body.data.map((p: any) => p.id)).toEqual(expect.arrayContaining(["pi_gc1", "pi_gc2"]));
    expect(stripeMock.paymentIntents.list).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ stripeAccount: "acct_gc1" })
    );
    expect(stripeMock.paymentIntents.list).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ stripeAccount: "acct_gc2" })
    );
    await server.close();
  });

  it("returns 404 for reports with a non-existent groupId", async () => {
    const server = await createServer();
    const adminToken = makeAdminToken();

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/reports/payments?groupId=no_such_group&workspace=client_portal",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Invalid groupId." });
    await server.close();
  });
});
