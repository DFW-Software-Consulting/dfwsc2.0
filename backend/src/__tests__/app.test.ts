import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';

const webhookHelper = new Stripe('sk_test_12345', { apiVersion: '2023-10-16' });

vi.mock('drizzle-orm', () => ({
  eq: (_field: unknown, value: unknown) => ({ value }),
}));

const dataStore = {
  clients: new Map<string, any>(),
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

const dbMock = {
  select: vi.fn(() => ({
    from: (table: any) => ({
      where: (expr: any) => ({
        limit: async () => {
          if (isTable(table, 'clients')) {
            const row = dataStore.clients.get(expr.value);
            return row ? [row] : [];
          }
          return [];
        },
      }),
    }),
  })),
  insert: vi.fn((table: any) => ({
    values: (payload: any) => {
      if (isTable(table, 'clients')) {
        const existing = dataStore.clients.get(payload.id);
        const next = {
          id: payload.id,
          name: payload.name ?? existing?.name,
          email: payload.email ?? existing?.email,
          stripeAccountId: payload.stripeAccountId ?? existing?.stripeAccountId ?? null,
          createdAt: existing?.createdAt ?? new Date(),
          updatedAt: new Date(),
        };
        dataStore.clients.set(payload.id, next);
      }

      if (isTable(table, 'webhook_events')) {
        if (!dataStore.webhookEvents.has(payload.stripeEventId)) {
          dataStore.webhookEvents.set(payload.stripeEventId, { ...payload });
        }
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
}: {
  id: string;
  stripeAccountId?: string | null;
  name?: string;
  email?: string;
}) {
  dataStore.clients.set(id, {
    id,
    name,
    email,
    stripeAccountId: stripeAccountId ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

beforeEach(async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_12345';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
  process.env.FRONTEND_ORIGIN = 'http://localhost:5173';
  process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/test';
  process.env.API_BASE_URL = 'http://localhost:4242';
  process.env.USE_CHECKOUT = 'false';

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
  dataStore.webhookEvents.clear();
  mailhogMessages.length = 0;

  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.API_BASE_URL;
  delete process.env.FRONTEND_ORIGIN;
  delete process.env.USE_CHECKOUT;
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
  it('rejects missing role header', async () => {
    const server = await createServer();

    const response = await server.inject({
      method: 'POST',
      url: '/payments/create',
      payload: {},
      headers: {
        'idempotency-key': 'abc',
      },
    });

    expect(response.statusCode).toBe(403);
    await server.close();
  });

  it('requires idempotency key on write', async () => {
    const server = await createServer();

    dataStore.clients.set('client_1', {
      id: 'client_1',
      name: 'Acme',
      email: 'billing@acme.test',
      stripeAccountId: 'acct_123',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await server.inject({
      method: 'POST',
      url: '/payments/create',
      headers: {
        'x-api-role': 'admin',
      },
      payload: {
        clientId: 'client_1',
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
  it('requires a known client id', async () => {
    const server = await createServer();

    const response = await server.inject({
      method: 'POST',
      url: '/payments/create',
      headers: {
        'x-api-role': 'admin',
        'idempotency-key': 'missing-client',
      },
      payload: {
        clientId: 'does-not-exist',
        amount: 500,
        currency: 'usd',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Client not found.' });
    await server.close();
  });

  it('requires client to have a connected account', async () => {
    const server = await createServer();

    seedClient({ id: 'client_no_connect', stripeAccountId: null });

    const response = await server.inject({
      method: 'POST',
      url: '/payments/create',
      headers: {
        'x-api-role': 'admin',
        'idempotency-key': 'no-connect',
      },
      payload: {
        clientId: 'client_no_connect',
        amount: 1000,
        currency: 'usd',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Client does not have a connected Stripe account.' });
    await server.close();
  });

  it('creates a payment intent when USE_CHECKOUT=false', async () => {
    stripeMock.paymentIntents.create.mockResolvedValue({
      id: 'pi_123',
      client_secret: 'secret_123',
    });

    const server = await createServer();

    seedClient({ id: 'client_1', stripeAccountId: 'acct_123' });

    const response = await server.inject({
      method: 'POST',
      url: '/payments/create',
      headers: {
        'x-api-role': 'admin',
        'idempotency-key': 'test-key',
      },
      payload: {
        clientId: 'client_1',
        amount: 1000,
        currency: 'usd',
        applicationFeeAmount: 100,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(stripeMock.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 1000,
        currency: 'usd',
        application_fee_amount: 100,
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

    seedClient({ id: 'client_invalid_amount', stripeAccountId: 'acct_123' });

    const response = await server.inject({
      method: 'POST',
      url: '/payments/create',
      headers: {
        'x-api-role': 'admin',
        'idempotency-key': 'invalid-fee',
      },
      payload: {
        clientId: 'client_invalid_amount',
        currency: 'usd',
        applicationFeeAmount: 10,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'amount and currency are required for PaymentIntents.' });
    await server.close();
  });

  it('rejects fees that exceed the payment amount', async () => {
    const server = await createServer();

    seedClient({ id: 'client_fee', stripeAccountId: 'acct_123' });

    const response = await server.inject({
      method: 'POST',
      url: '/payments/create',
      headers: {
        'x-api-role': 'admin',
        'idempotency-key': 'too-high-fee',
      },
      payload: {
        clientId: 'client_fee',
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

    seedClient({ id: 'client_1', stripeAccountId: 'acct_123' });

    const response = await server.inject({
      method: 'POST',
      url: '/payments/create',
      headers: {
        'x-api-role': 'admin',
        'idempotency-key': 'checkout-key',
      },
      payload: {
        clientId: 'client_1',
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

    seedClient({ id: 'client_checkout', stripeAccountId: 'acct_123' });

    const response = await server.inject({
      method: 'POST',
      url: '/payments/create',
      headers: {
        'x-api-role': 'admin',
        'idempotency-key': 'missing-line-items',
      },
      payload: {
        clientId: 'client_checkout',
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

    seedClient({ id: 'client_checkout', stripeAccountId: 'acct_123' });

    const response = await server.inject({
      method: 'POST',
      url: '/payments/create',
      headers: {
        'x-api-role': 'admin',
        'idempotency-key': 'no-frontend',
      },
      payload: {
        clientId: 'client_checkout',
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
  it('requires body fields and idempotency header', async () => {
    const server = await createServer();

    const response = await server.inject({
      method: 'POST',
      url: '/connect/onboard',
      headers: {
        'x-api-role': 'admin',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'clientId, name, email are required.' });

    const headerResponse = await server.inject({
      method: 'POST',
      url: '/connect/onboard',
      headers: {
        'x-api-role': 'admin',
      },
      payload: { clientId: 'client_1', name: 'Client', email: 'client@example.com' },
    });

    expect(headerResponse.statusCode).toBe(400);
    expect(headerResponse.json()).toEqual({ error: 'Idempotency-Key header is required.' });

    await server.close();
  });

  it('creates an account link and stores the account id', async () => {
    stripeMock.accounts.create.mockResolvedValue({ id: 'acct_new' });
    stripeMock.accountLinks.create.mockResolvedValue({ url: 'https://connect.stripe.com/setup/mock' });

    const server = await createServer();

    const response = await server.inject({
      method: 'POST',
      url: '/connect/onboard',
      headers: {
        'x-api-role': 'admin',
        'idempotency-key': 'connect-key',
      },
      payload: {
        clientId: 'client_new',
        name: 'New Client',
        email: 'owner@example.com',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(stripeMock.accounts.create).toHaveBeenCalled();
    expect(stripeMock.accountLinks.create).toHaveBeenCalledWith(
      expect.objectContaining({ account: 'acct_new' }),
      expect.objectContaining({ idempotencyKey: 'connect-key' }),
    );

    const savedClient = dataStore.clients.get('client_new');
    expect(savedClient?.stripeAccountId).toBe('acct_new');
    await server.close();
  });

  it('updates an existing client record when onboarding again', async () => {
    stripeMock.accounts.create.mockResolvedValue({ id: 'acct_existing' });
    stripeMock.accountLinks.create.mockResolvedValue({ url: 'https://connect.stripe.com/setup/mock' });

    seedClient({
      id: 'client_existing',
      stripeAccountId: null,
      name: 'Old Name',
      email: 'old@example.com',
    });

    const server = await createServer();

    const response = await server.inject({
      method: 'POST',
      url: '/connect/onboard',
      headers: {
        'x-api-role': 'admin',
        'idempotency-key': 'connect-update',
      },
      payload: {
        clientId: 'client_existing',
        name: 'Updated Name',
        email: 'updated@example.com',
      },
    });

    expect(response.statusCode).toBe(201);
    const savedClient = dataStore.clients.get('client_existing');
    expect(savedClient?.name).toBe('Updated Name');
    expect(savedClient?.email).toBe('updated@example.com');
    expect(savedClient?.stripeAccountId).toBe('acct_existing');
    await server.close();
  });

  it('builds callback URLs from API_BASE_URL when provided', async () => {
    stripeMock.accounts.create.mockResolvedValue({ id: 'acct_base_url' });
    stripeMock.accountLinks.create.mockResolvedValue({ url: 'https://connect.stripe.com/setup/mock' });

    process.env.API_BASE_URL = 'https://api.example.com';

    const server = await createServer();

    await server.inject({
      method: 'POST',
      url: '/connect/onboard',
      headers: {
        'x-api-role': 'admin',
        'idempotency-key': 'connect-base-url',
      },
      payload: {
        clientId: 'client_base_url',
        name: 'Client Base',
        email: 'base@example.com',
      },
    });

    expect(stripeMock.accountLinks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        refresh_url: 'https://api.example.com/connect/callback?client_id=client_base_url&refresh=true',
        return_url: 'https://api.example.com/connect/callback?client_id=client_base_url',
      }),
      expect.any(Object),
    );

    await server.close();
  });
});

describe('connect callback', () => {
  it('redirects to the frontend success page when the client exists', async () => {
    const clientId = 'client_existing';
    dataStore.clients.set(clientId, {
      id: clientId,
      name: 'Existing Client',
      email: 'existing@example.com',
      stripeAccountId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const server = await createServer();

    const origin = process.env.FRONTEND_ORIGIN;

    const response = await server.inject({
      method: 'GET',
      url: `/connect/callback?client_id=${clientId}&account=acct_789`,
    });

    expect(response.statusCode).toBe(302);
    expect(origin).toBeDefined();
    expect(response.headers.location).toBe(
      `${origin}/connect/success?client_id=${encodeURIComponent(clientId)}&stripe_account_id=acct_789`,
    );

    const updatedClient = dataStore.clients.get(clientId);
    expect(updatedClient?.stripeAccountId).toBe('acct_789');

    await server.close();
  });

  it('returns JSON payload when no frontend origin is configured', async () => {
    delete process.env.FRONTEND_ORIGIN;

    const clientId = 'client_json';
    dataStore.clients.set(clientId, {
      id: clientId,
      name: 'Json Client',
      email: 'json@example.com',
      stripeAccountId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const server = await createServer({ skipEnvValidation: true });

    const response = await server.inject({
      method: 'GET',
      url: `/connect/callback?client_id=${clientId}&account=acct_json`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ clientId, stripeAccountId: 'acct_json', status: 'saved' });

    await server.close();
  });

  it('returns 404 when the client cannot be found', async () => {
    const server = await createServer();

    const response = await server.inject({
      method: 'GET',
      url: '/connect/callback?client_id=missing&account=acct_missing',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Client not found.' });

    await server.close();
  });

  it('validates the required query parameters', async () => {
    const server = await createServer();

    const response = await server.inject({
      method: 'GET',
      url: '/connect/callback',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'client_id, account are required.' });

    await server.close();
  });
});

describe('reports', () => {
  it('requires a client id query parameter', async () => {
    const server = await createServer();

    const response = await server.inject({
      method: 'GET',
      url: '/reports/payments',
      headers: {
        'x-api-role': 'admin',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'clientId query parameter is required.' });
    await server.close();
  });

  it('returns 404 when the client does not exist', async () => {
    const server = await createServer();

    const response = await server.inject({
      method: 'GET',
      url: '/reports/payments?clientId=unknown',
      headers: {
        'x-api-role': 'admin',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Client with connected account not found.' });
    await server.close();
  });

  it('validates limit parameter', async () => {
    seedClient({ id: 'client_invalid_limit', stripeAccountId: 'acct_123' });

    const server = await createServer();

    const response = await server.inject({
      method: 'GET',
      url: '/reports/payments?clientId=client_invalid_limit&limit=200',
      headers: {
        'x-api-role': 'admin',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'limit must be an integer between 1 and 100.' });
    await server.close();
  });

  it('lists payment intents for a client', async () => {
    stripeMock.paymentIntents.list.mockResolvedValue({ data: [], has_more: false });

    const server = await createServer();

    seedClient({ id: 'client_1', stripeAccountId: 'acct_123' });

    const response = await server.inject({
      method: 'GET',
      url: '/reports/payments?clientId=client_1&limit=5',
      headers: {
        'x-api-role': 'admin',
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
      url: '/webhooks/stripe',
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
      url: '/webhooks/stripe',
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
      url: '/webhooks/stripe',
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

describe('email', () => {
  it('sends a test email', async () => {
    const server = await createServer();

    const response = await server.inject({
      method: 'GET',
      url: '/test-email',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, message: 'Test email sent successfully.' });

    const messagesResponse = await fetch('http://localhost:1025/api/v2/messages');
    const messages = await messagesResponse.json();

    expect(messages.total).toBe(1);
    const email = messages.items[0];
    expect(email.Content.Headers.Subject[0]).toBe('Test Email from Stripe Payment Portal');
    expect(email.Content.Headers.To[0]).toBe('test@example.com');
    await server.close();
  });
});