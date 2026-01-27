import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';

const webhookHelper = new Stripe('sk_test_12345', { apiVersion: '2023-10-16' });

vi.mock('bcryptjs', () => ({
  default: {
    hash: async (plaintext: string) => `hashed:${plaintext}`,
    compare: async (plaintext: string, hashed: string) => hashed === `hashed:${plaintext}`,
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (field: unknown, value: unknown) => ({ value, field }),
  and: (...conditions: any[]) => ({ all: conditions }),
}));

const dataStore = {
  clients: new Map<string, any>(),
  clientsByApiKey: new Map<string, string>(),
  onboardingTokens: new Map<string, any>(),
  webhookEvents: new Map<string, any>(),
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
  throw new Error('Global fetch API is not available in the test environment.');
}

const mailhogMessages: MailhogMessage[] = [];

vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  const requestUrl =
    typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.toString()
      : input instanceof Request
      ? input.url
      : undefined;

  if (!requestUrl) {
    throw new Error('Request URL is required.');
  }

  if (requestUrl.startsWith('http://localhost:1025/api/v1/messages')) {
    mailhogMessages.length = 0;
    return new Response(null, { status: 204 });
  }

  if (requestUrl.startsWith('http://localhost:1025/api/v2/messages')) {
    return new Response(
      JSON.stringify({
        total: mailhogMessages.length,
        count: mailhogMessages.length,
        items: mailhogMessages,
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  }

  return realFetch(input as RequestInfo, init);
});

const DRIZZLE_NAME_SYMBOL = Symbol.for('drizzle:Name');

function resolveTableName(table: any): string | undefined {
  if (!table) {
    return undefined;
  }
  if (typeof table.tableName === 'string') {
    return table.tableName;
  }
  const symbolValue = (table as Record<symbol, unknown>)[DRIZZLE_NAME_SYMBOL];
  return typeof symbolValue === 'string' ? symbolValue : undefined;
}

function isTable(table: any, name: string): boolean {
  return resolveTableName(table) === name;
}

function resolveColumnName(column: any): string | undefined {
  if (!column) {
    return undefined;
  }
  if (typeof column === 'string') {
    return column;
  }
  if (typeof column.name === 'string') {
    return column.name;
  }
  const columnName = (column as { columnName?: unknown }).columnName;
  if (typeof columnName === 'string') {
    return columnName;
  }
  const symbolValue = (column as Record<symbol, unknown>)[DRIZZLE_NAME_SYMBOL];
  return typeof symbolValue === 'string' ? symbolValue : undefined;
}

function isColumn(column: any, name: string): boolean {
  const resolved = resolveColumnName(column);
  if (!resolved) {
    return false;
  }
  if (resolved === name) {
    return true;
  }
  const camelCased = name.replace(/_([a-z])/g, (_match, char) => char.toUpperCase());
  return resolved === camelCased;
}

function createWhereResult(rowsPromise: Promise<any[]>) {
  return {
    limit: async () => (await rowsPromise).slice(0, 1),
    then: rowsPromise.then.bind(rowsPromise),
    catch: rowsPromise.catch.bind(rowsPromise),
    finally: rowsPromise.finally.bind(rowsPromise),
  };
}

function findOnboardingTokenByToken(token?: string) {
  if (!token) {
    return undefined;
  }
  for (const record of dataStore.onboardingTokens.values()) {
    if (record.token === token) {
      return record;
    }
  }
  return undefined;
}

function findClientByApiKey(apiKey?: string) {
  if (!apiKey) {
    return undefined;
  }
  const clientId = dataStore.clientsByApiKey.get(apiKey);
  if (clientId) {
    return dataStore.clients.get(clientId);
  }
  for (const client of dataStore.clients.values()) {
    if (client.apiKey === apiKey) {
      return client;
    }
  }
  return undefined;
}

const dbMock = {
  select: vi.fn(() => ({
    from: (table: any) => ({
      ...(() => {
        const rowsPromise = (async () => {
          if (isTable(table, 'clients')) {
            return Array.from(dataStore.clients.values());
          }
          if (isTable(table, 'onboarding_tokens')) {
            return Array.from(dataStore.onboardingTokens.values());
          }
          if (isTable(table, 'webhook_events')) {
            return Array.from(dataStore.webhookEvents.values());
          }
          return [];
        })();

        return {
          then: rowsPromise.then.bind(rowsPromise),
          catch: rowsPromise.catch.bind(rowsPromise),
          finally: rowsPromise.finally.bind(rowsPromise),
        };
      })(),
      where: (expr: any) => {
        const rowsPromise = (async () => {
          if (isTable(table, 'clients')) {
            if (isColumn(expr?.field, 'api_key')) {
              const client = findClientByApiKey(expr?.value);
              return client ? [client] : [];
            }

            const row = dataStore.clients.get(expr?.value);
            return row ? [row] : [];
          }

          if (isTable(table, 'onboarding_tokens')) {
            if (expr?.all?.length) {
              const records = Array.from(dataStore.onboardingTokens.values());
              const matches = records.filter(record =>
                expr.all.every((condition: any) => {
                  if (!condition) {
                    return false;
                  }
                  if (isColumn(condition.field, 'token')) {
                    return record.token === condition.value;
                  }
                  if (isColumn(condition.field, 'status')) {
                    return record.status === condition.value;
                  }
                  if (isColumn(condition.field, 'client_id') || isColumn(condition.field, 'clientId')) {
                    return record.clientId === condition.value;
                  }
                  if (isColumn(condition.field, 'state')) {
                    return record.state === condition.value;
                  }
                  return false;
                }),
              );
              return matches;
            }

            if (isColumn(expr?.field, 'token')) {
              const record = findOnboardingTokenByToken(expr?.value);
              return record ? [record] : [];
            }

            const record = dataStore.onboardingTokens.get(expr?.value);
            return record ? [record] : [];
          }

          return [];
        })();

        return createWhereResult(rowsPromise);
      },
    }),
  })),
  insert: vi.fn((table: any) => ({
    values: (payload: any) => {
      if (isTable(table, 'clients')) {
        const existing = dataStore.clients.get(payload.id);
        const apiKey = payload.apiKey ?? existing?.apiKey ?? null;
        const apiKeyHash =
          payload.apiKeyHash ?? existing?.apiKeyHash ?? (apiKey ? `hashed:${apiKey}` : null);
        const next = {
          id: payload.id,
          name: payload.name ?? existing?.name,
          email: payload.email ?? existing?.email,
          apiKey,
          apiKeyHash,
          status: payload.status ?? existing?.status ?? 'active',
          stripeAccountId: payload.stripeAccountId ?? existing?.stripeAccountId ?? null,
          createdAt: existing?.createdAt ?? new Date(),
          updatedAt: new Date(),
        };
        dataStore.clients.set(payload.id, next);
        if (apiKey) {
          dataStore.clientsByApiKey.set(apiKey, payload.id);
        }
      }

      if (isTable(table, 'webhook_events')) {
        if (!dataStore.webhookEvents.has(payload.stripeEventId)) {
          dataStore.webhookEvents.set(payload.stripeEventId, { ...payload });
        }
      }

      if (isTable(table, 'onboarding_tokens')) {
        const next = {
          id: payload.id,
          clientId: payload.clientId,
          token: payload.token,
          status: payload.status ?? 'pending',
          email: payload.email,
          state: payload.state ?? null,
          stateExpiresAt: payload.stateExpiresAt ?? null,
          createdAt: payload.createdAt ?? new Date(),
          updatedAt: new Date(),
        };
        dataStore.onboardingTokens.set(payload.id, next);
      }

      return {
        onConflictDoNothing: async () => {},
      };
    },
  })),
  update: vi.fn((table: any) => ({
    set: (values: any) => ({
      where: async (expr: any) => {
        if (isTable(table, 'clients')) {
          const row = dataStore.clients.get(expr.value);
          if (!row) {
            return { rowCount: 0 };
          }
          Object.assign(row, values);
          if (values.apiKey) {
            dataStore.clientsByApiKey.set(values.apiKey, row.id);
          }
          if (Object.prototype.hasOwnProperty.call(values, 'apiKeyHash')) {
            row.apiKeyHash = values.apiKeyHash;
          }
          return { rowCount: 1 };
        }

        if (isTable(table, 'onboarding_tokens')) {
          const row = dataStore.onboardingTokens.get(expr.value);
          if (!row) {
            return { rowCount: 0 };
          }
          Object.assign(row, values);
          return { rowCount: 1 };
        }

        if (isTable(table, 'webhook_events')) {
          const row = dataStore.webhookEvents.get(expr.value);
          if (!row) {
            return { rowCount: 0 };
          }
          Object.assign(row, values);
          return { rowCount: 1 };
        }

        return { rowCount: 0 };
      },
    }),
  })),
};

vi.mock('../db/client', () => ({
  db: dbMock,
  __dataStore: dataStore,
}));

const stripeMock = {
  accounts: {
    create: vi.fn(),
  },
  accountLinks: {
    create: vi.fn(),
  },
  paymentIntents: {
    create: vi.fn(),
    list: vi.fn(),
  },
  checkout: {
    sessions: {
      create: vi.fn(),
    },
  },
  webhooks: webhookHelper.webhooks,
};

vi.mock('../lib/stripe', () => ({
  stripe: stripeMock,
}));

vi.mock('nodemailer', () => {
  const sendMail = vi.fn(async (options: any) => {
    const to = options.to;
    const recipients = Array.isArray(to) ? to.map(String) : [String(to ?? '')];

    mailhogMessages.push({
      Content: {
        Headers: {
          Subject: [options.subject ?? ''],
          To: recipients,
        },
      },
    });

    return {};
  });

  const createTransport = () => ({ sendMail });

  return {
    __esModule: true,
    default: { createTransport },
    createTransport,
  };
});

function seedClient({
  id,
  stripeAccountId,
  name = 'Acme Corp',
  email = 'billing@acme.test',
  apiKey = `api-key-${id}`,
  apiKeyHash,
  status = 'active',
}: {
  id: string;
  stripeAccountId?: string | null;
  name?: string;
  email?: string;
  apiKey?: string;
  apiKeyHash?: string | null;
  status?: string;
}) {
  dataStore.clients.set(id, {
    id,
    name,
    email,
    apiKey,
    apiKeyHash: apiKeyHash ?? `hashed:${apiKey}`,
    status,
    stripeAccountId: stripeAccountId ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  dataStore.clientsByApiKey.set(apiKey, id);
}

beforeEach(async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_12345';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
  process.env.FRONTEND_ORIGIN = 'http://localhost:5173';
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/test';
  process.env.API_BASE_URL = 'http://localhost:4242';
  process.env.USE_CHECKOUT = 'false';
  process.env.JWT_SECRET = 'test_jwt_secret_minimum_32_characters_long';

  // MailHog config
  process.env.SMTP_HOST = 'mailhog';
  process.env.SMTP_PORT = '1025';
  process.env.SMTP_USER = 'test';
  process.env.SMTP_PASS = 'test';

  try {
    await fetch('http://localhost:1025/api/v1/messages', { method: 'DELETE' });
  } catch (error) {
    console.warn('Failed to clear MailHog messages before test execution.', error);
  }

  dataStore.clients.clear();
  dataStore.clientsByApiKey.clear();
  dataStore.onboardingTokens.clear();
  dataStore.webhookEvents.clear();
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
    vi.doMock('../lib/env', () => ({
      validateEnv: () => ({}),
      logMaskedEnvSummary: () => {},
    }));
  } else {
    vi.unmock('../lib/env');
  }

  vi.resetModules();
  const { buildServer } = await import('../app');
  return buildServer();
}

describe('route guards and validation', () => {
  it('rejects missing API key', async () => {
    const server = await createServer();

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/payments/create',
      payload: {},
      headers: {
        'idempotency-key': 'abc',
      },
    });

    expect(response.statusCode).toBe(401);
    await server.close();
  });

  it('requires idempotency key on write', async () => {
    const server = await createServer();

    const apiKey = 'api-key-client_1';
    seedClient({
      id: 'client_1',
      stripeAccountId: 'acct_123',
      apiKey,
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/payments/create',
      headers: {
        'x-api-key': apiKey,
      },
      payload: {
        amount: 1000,
        currency: 'usd',
        applicationFeeAmount: 100,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'Idempotency-Key header is required.' });
    await server.close();
  });
});

describe('payments', () => {
  it('rejects requests with an unknown API key', async () => {
    const server = await createServer();

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/payments/create',
      headers: {
        'x-api-key': 'unknown-api-key',
        'idempotency-key': 'missing-client',
      },
      payload: {
        amount: 500,
        currency: 'usd',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Invalid API key.' });
    await server.close();
  });

  it('requires client to have a connected account', async () => {
    const server = await createServer();

    const apiKey = 'api-key-client_no_connect';
    seedClient({ id: 'client_no_connect', stripeAccountId: null, apiKey });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/payments/create',
      headers: {
        'x-api-key': apiKey,
        'idempotency-key': 'no-connect',
      },
      payload: {
        amount: 1000,
        currency: 'usd',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Client does not have a connected Stripe account.' });
    await server.close();
  });

  it('creates a payment intent when USE_CHECKOUT=false', async () => {
    process.env.DEFAULT_PROCESS_FEE_CENTS = '100';
    stripeMock.paymentIntents.create.mockResolvedValue({
      id: 'pi_123',
      client_secret: 'secret_123',
    });

    const server = await createServer();

    const apiKey = 'api-key-client_1';
    seedClient({ id: 'client_1', stripeAccountId: 'acct_123', apiKey });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/payments/create',
      headers: {
        'x-api-key': apiKey,
        'idempotency-key': 'test-key',
      },
      payload: {
        clientId: 'different-id',
        amount: 1000,
        currency: 'usd',
        applicationFeeAmount: 50,
        metadata: { order: '42' },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(stripeMock.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 1000,
        currency: 'usd',
        application_fee_amount: 100,
        metadata: expect.objectContaining({
          clientId: 'client_1',
          order: '42',
        }),
      }),
      expect.objectContaining({
        stripeAccount: 'acct_123',
        idempotencyKey: 'test-key',
      }),
    );
    expect(response.json()).toEqual({
      clientSecret: 'secret_123',
      paymentIntentId: 'pi_123',
    });
    await server.close();
  });

  it('validates payment intent amount and fee values', async () => {
    const server = await createServer();

    const apiKey = 'api-key-client_invalid_amount';
    seedClient({ id: 'client_invalid_amount', stripeAccountId: 'acct_123', apiKey });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/payments/create',
      headers: {
        'x-api-key': apiKey,
        'idempotency-key': 'invalid-fee',
      },
      payload: {
        currency: 'usd',
        applicationFeeAmount: 10,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'amount and currency are required for PaymentIntents.' });
    await server.close();
  });

  it('rejects fees that exceed the payment amount', async () => {
    process.env.DEFAULT_PROCESS_FEE_CENTS = '2000';

    const server = await createServer();

    const apiKey = 'api-key-client_fee';
    seedClient({ id: 'client_fee', stripeAccountId: 'acct_123', apiKey });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/payments/create',
      headers: {
        'x-api-key': apiKey,
        'idempotency-key': 'too-high-fee',
      },
      payload: {
        amount: 1000,
        currency: 'usd',
        applicationFeeAmount: 2000,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'applicationFeeAmount must be between 0 and the payment amount.' });
    await server.close();
  });

  it('creates a checkout session when USE_CHECKOUT=true', async () => {
    process.env.USE_CHECKOUT = 'true';
    stripeMock.checkout.sessions.create.mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/mock' });

    const server = await createServer();

    const apiKey = 'api-key-client_1';
    seedClient({ id: 'client_1', stripeAccountId: 'acct_123', apiKey });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/payments/create',
      headers: {
        'x-api-key': apiKey,
        'idempotency-key': 'checkout-key',
      },
      payload: {
        applicationFeeAmount: 100,
        lineItems: [
          {
            price_data: {
              currency: 'usd',
              product_data: { name: 'Service' },
              unit_amount: 1000,
            },
            quantity: 1,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalled();
    expect(response.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/mock' });
    await server.close();
  });
  it('validates checkout payload requirements', async () => {
    process.env.USE_CHECKOUT = 'true';

    const server = await createServer();

    const apiKey = 'api-key-client_checkout';
    seedClient({ id: 'client_checkout', stripeAccountId: 'acct_123', apiKey });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/payments/create',
      headers: {
        'x-api-key': apiKey,
        'idempotency-key': 'missing-line-items',
      },
      payload: {
        applicationFeeAmount: 10,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'lineItems are required when USE_CHECKOUT=true.' });
    await server.close();
  });

  it('fails when checkout requires a frontend origin but it is not configured', async () => {
    process.env.USE_CHECKOUT = 'true';
    delete process.env.FRONTEND_ORIGIN;

    const server = await createServer({ skipEnvValidation: true });

    const apiKey = 'api-key-client_checkout';
    seedClient({ id: 'client_checkout', stripeAccountId: 'acct_123', apiKey });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/payments/create',
      headers: {
        'x-api-key': apiKey,
        'idempotency-key': 'no-frontend',
      },
      payload: {
        lineItems: [
          {
            price_data: {
              currency: 'usd',
              unit_amount: 1000,
              product_data: { name: 'Service' },
            },
            quantity: 1,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'FRONTEND_ORIGIN is not configured.' });
    await server.close();
  });
});

describe('connect onboarding', () => {
  it('creates an onboarding token and client via /accounts', async () => {
    const server = await createServer();
    const adminToken = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET!, { expiresIn: '1h' });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/accounts',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        name: 'New Client',
        email: 'owner@example.com',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.onboardingToken).toBeDefined();
    expect(body.onboardingUrlHint).toContain(body.onboardingToken);
    expect(body.apiKey).toBeDefined();
    expect(body.clientId).toBeDefined();

    const savedClient = Array.from(dataStore.clients.values()).find(client => client.email === 'owner@example.com');
    expect(savedClient).toBeDefined();
    expect(savedClient?.apiKeyHash).toBe(`hashed:${body.apiKey}`);
    expect(savedClient?.id).toBe(body.clientId);
    await server.close();
  });

  it('sends onboarding email via /onboard-client/initiate', async () => {
    const server = await createServer();
    const adminToken = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET!, { expiresIn: '1h' });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/onboard-client/initiate',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        name: 'Client',
        email: 'client@example.com',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ message: 'Onboarding email sent successfully.' });
    expect(body.apiKey).toBeDefined();
    expect(body.clientId).toBeDefined();
    const savedClient = Array.from(dataStore.clients.values()).find(client => client.email === 'client@example.com');
    expect(savedClient?.apiKeyHash).toBe(`hashed:${body.apiKey}`);
    expect(savedClient?.id).toBe(body.clientId);
    expect(mailhogMessages.length).toBe(1);
    expect(mailhogMessages[0].Content.Headers.Subject[0]).toBe('DFW Software Consulting - Stripe Onboarding');
    expect(mailhogMessages[0].Content.Headers.To[0]).toBe('client@example.com');
    await server.close();
  });

  it('creates an account link from a pending onboarding token', async () => {
    stripeMock.accounts.create.mockResolvedValue({ id: 'acct_new' });
    stripeMock.accountLinks.create.mockResolvedValue({ url: 'https://connect.stripe.com/setup/mock' });

    process.env.API_BASE_URL = 'https://api.example.com';

    const clientId = 'client_onboard';
    seedClient({
      id: clientId,
      stripeAccountId: null,
      name: 'Pending Client',
      email: 'pending@example.com',
    });

    const onboardingTokenId = 'token_1';
    const onboardingToken = 'token_value_1';
    dataStore.onboardingTokens.set(onboardingTokenId, {
      id: onboardingTokenId,
      clientId,
      token: onboardingToken,
      status: 'pending',
      email: 'pending@example.com',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const server = await createServer();

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/onboard-client?token=${onboardingToken}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ url: 'https://connect.stripe.com/setup/mock' });
    expect(stripeMock.accounts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'pending@example.com',
        metadata: { clientId },
      }),
    );
    const updatedToken = dataStore.onboardingTokens.get(onboardingTokenId);
    expect(updatedToken?.status).toBe('in_progress');
    expect(updatedToken?.state).toBeDefined();
    expect(stripeMock.accountLinks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        account: 'acct_new',
        type: 'account_onboarding',
        refresh_url: `https://api.example.com/api/v1/connect/refresh?token=${onboardingToken}`,
        return_url: `https://api.example.com/api/v1/connect/callback?client_id=client_onboard&state=${updatedToken?.state}`,
      }),
    );

    const updatedClient = dataStore.clients.get(clientId);
    expect(updatedClient?.stripeAccountId).toBe('acct_new');
    await server.close();
  });
});

describe('connect callback', () => {
  it('rejects callback without state', async () => {
    const server = await createServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/connect/callback?client_id=client_1&account=acct_123',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Missing state parameter.' });
    await server.close();
  });

  it('rejects callback with invalid state', async () => {
    const server = await createServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/connect/callback?client_id=client_1&account=acct_123&state=invalid',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Invalid or expired state parameter.' });
    await server.close();
  });

  it('rejects callback with expired state', async () => {
    const clientId = 'client_expired_state';
    const onboardingTokenId = 'token_expired';
    dataStore.onboardingTokens.set(onboardingTokenId, {
      id: onboardingTokenId,
      clientId,
      token: 'expired_token',
      status: 'in_progress',
      email: 'test@test.com',
      state: 'expired_state_val',
      stateExpiresAt: new Date(Date.now() - 1000), // Expired
    });
    const server = await createServer();
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/connect/callback?client_id=${clientId}&account=acct_123&state=expired_state_val`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Expired state parameter.' });
    await server.close();
  });

  it('redirects to the frontend success page when the client exists', async () => {
    const clientId = 'client_existing';
    seedClient({
      id: clientId,
      name: 'Existing Client',
      email: 'existing@example.com',
      stripeAccountId: null,
    });
    const onboardingTokenId = 'token_existing';
    const state = 'state_existing';
    dataStore.onboardingTokens.set(onboardingTokenId, {
      id: onboardingTokenId,
      clientId,
      token: 'token_value_existing',
      status: 'in_progress',
      email: 'existing@example.com',
      state,
      stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const server = await createServer();

    const origin = process.env.FRONTEND_ORIGIN;

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/connect/callback?client_id=${clientId}&account=acct_789&state=${state}`,
    });

    expect(response.statusCode).toBe(302);
    expect(origin).toBeDefined();
    expect(response.headers.location).toBe(`${origin}/onboarding-success`);

    const updatedClient = dataStore.clients.get(clientId);
    expect(updatedClient?.stripeAccountId).toBe('acct_789');
    const updatedToken = dataStore.onboardingTokens.get(onboardingTokenId);
    expect(updatedToken?.status).toBe('completed');

    await server.close();
  });

  it('fails when no frontend origin is configured for the connect callback', async () => {
    delete process.env.FRONTEND_ORIGIN;

    const clientId = 'client_json';
    seedClient({
      id: clientId,
      name: 'Json Client',
      email: 'json@example.com',
      stripeAccountId: null,
    });
    const onboardingTokenId = 'token_json';
    const state = 'state_json';
    dataStore.onboardingTokens.set(onboardingTokenId, {
      id: onboardingTokenId,
      clientId,
      token: 'token_value_json',
      status: 'in_progress',
      email: 'json@example.com',
      state,
      stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const server = await createServer({ skipEnvValidation: true });

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/connect/callback?client_id=${clientId}&account=acct_json&state=${state}`,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'Server configuration error: FRONTEND_ORIGIN not set.' });

    await server.close();
  });

  it('redirects even when the client cannot be found', async () => {
    const clientId = 'missing';
    const onboardingTokenId = 'token_missing';
    const state = 'state_missing';
    dataStore.onboardingTokens.set(onboardingTokenId, {
      id: onboardingTokenId,
      clientId,
      token: 'token_value_missing',
      status: 'in_progress',
      email: 'missing@example.com',
      state,
      stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const server = await createServer();

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/connect/callback?client_id=${clientId}&account=acct_missing&state=${state}`,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${process.env.FRONTEND_ORIGIN}/onboarding-success`);

    await server.close();
  });

  it('rejects callback when required query parameters are missing', async () => {
    const server = await createServer();

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/connect/callback',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Missing state parameter.' });

    await server.close();
  });

  it('rejects callback when account is missing and preserves onboarding state', async () => {
    const clientId = 'client_missing_account';
    seedClient({
      id: clientId,
      name: 'Missing Account Client',
      email: 'missing-account@example.com',
      stripeAccountId: null,
    });
    const onboardingTokenId = 'token_missing_account';
    const state = 'state_missing_account';
    dataStore.onboardingTokens.set(onboardingTokenId, {
      id: onboardingTokenId,
      clientId,
      token: 'token_value_missing_account',
      status: 'in_progress',
      email: 'missing-account@example.com',
      state,
      stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const server = await createServer();

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/connect/callback?client_id=${clientId}&state=${state}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Missing account parameter.' });

    const updatedClient = dataStore.clients.get(clientId);
    expect(updatedClient?.stripeAccountId).toBeNull();
    const updatedToken = dataStore.onboardingTokens.get(onboardingTokenId);
    expect(updatedToken?.status).toBe('in_progress');

    await server.close();
  });
});

describe('reports', () => {
  it('requires a client id query parameter', async () => {
    const server = await createServer();
    const adminToken = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET!, { expiresIn: '1h' });

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/reports/payments',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'clientId query parameter is required.' });
    await server.close();
  });

  it('returns 404 when the client does not exist', async () => {
    const server = await createServer();
    const adminToken = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET!, { expiresIn: '1h' });

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/reports/payments?clientId=unknown',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Client with connected account not found.' });
    await server.close();
  });

  it('validates limit parameter', async () => {
    seedClient({ id: 'client_invalid_limit', stripeAccountId: 'acct_123' });

    const server = await createServer();
    const adminToken = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET!, { expiresIn: '1h' });

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/reports/payments?clientId=client_invalid_limit&limit=200',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'limit must be an integer between 1 and 100.' });
    await server.close();
  });

  it('lists payment intents for a client', async () => {
    stripeMock.paymentIntents.list.mockResolvedValue({ data: [], has_more: false });

    const server = await createServer();
    const adminToken = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET!, { expiresIn: '1h' });

    seedClient({ id: 'client_1', stripeAccountId: 'acct_123' });

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/reports/payments?clientId=client_1&limit=5',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(stripeMock.paymentIntents.list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 }),
      expect.objectContaining({ stripeAccount: 'acct_123' }),
    );
    await server.close();
  });
});

describe('webhooks', () => {
  it('rejects missing signature headers', async () => {
    const server = await createServer();

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      payload: '{}',
      headers: {
        'content-type': 'application/json',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Missing Stripe-Signature header.' });
    await server.close();
  });

  it('rejects invalid signatures', async () => {
    const server = await createServer();

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      payload: '{}',
      headers: {
        'stripe-signature': 'invalid',
        'content-type': 'application/json',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('Webhook Error:');
    await server.close();
  });

  it('verifies Stripe signatures and stores events', async () => {
    const payload = JSON.stringify({ id: 'evt_test', type: 'payment_intent.succeeded', data: { object: { id: 'pi_123', status: 'succeeded' } } });
    const signature = webhookHelper.webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET!,
    });

    const server = await createServer();

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      payload,
      headers: {
        'stripe-signature': signature,
        'content-type': 'application/json',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(dataStore.webhookEvents.has('evt_test')).toBe(true);
    await server.close();
  });
});

describe('app-config', () => {
  it('returns API_URL from environment variables, ignoring host headers', async () => {
    process.env.API_BASE_URL = 'https://my-api.com/api';
    const server = await createServer();
    const response = await server.inject({
      method: 'GET',
      url: '/app-config.js',
      headers: {
        'host': 'evil.com',
        'x-forwarded-host': 'evil.com',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/javascript');
    expect(response.body).toBe('window.API_URL = "https://my-api.com/api";');
    await server.close();
  });
});

describe('email', () => {
  it('sends an onboarding email', async () => {
    const server = await createServer();
    const adminToken = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET!, { expiresIn: '1h' });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/onboard-client/initiate',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        name: 'Test Client',
        email: 'test@example.com',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ message: 'Onboarding email sent successfully.' });
    expect(mailhogMessages.length).toBe(1);
    expect(mailhogMessages[0].Content.Headers.Subject[0]).toBe('DFW Software Consulting - Stripe Onboarding');
    expect(mailhogMessages[0].Content.Headers.To[0]).toBe('test@example.com');
    await server.close();
  });
});
