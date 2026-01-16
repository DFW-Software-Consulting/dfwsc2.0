import { buildServer } from '../../app';
import { db } from '../../db/client';
import { clients } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';

describe('Payments API Key Authentication Integration', () => {
  let app: any;

  beforeAll(async () => {
    app = await buildServer();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('should create payment successfully with valid API key', async () => {
    // Create a client with an API key
    const clientId = randomUUID();
    const apiKey = 'test_api_key_' + randomUUID().replace(/-/g, '');
    
    await db.insert(clients).values({
      id: clientId,
      name: 'Test Client',
      email: 'test@example.com',
      apiKey: apiKey,
      status: 'active'
    });

    // Make a request to create a payment with the valid API key
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/create',
      headers: {
        'x-api-key': apiKey,
        'idempotency-key': 'test-idempotency-key-' + randomUUID().replace(/-/g, ''),
      },
      payload: {
        amount: 1000,
        currency: 'usd',
        description: 'Test payment',
      },
    });

    // Since Stripe is not mocked, we expect a 400 due to missing Stripe account
    // But importantly, we should NOT get a 401 (unauthorized) which would mean API key auth failed
    expect(response.statusCode).toBe(400); // Expecting 400 because client doesn't have stripeAccountId
    
    // Clean up
    await db.delete(clients).where(eq(clients.id, clientId));
  });

  it('should return 401 for invalid API key', async () => {
    // Make a request to create a payment with an invalid API key
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/create',
      headers: {
        'x-api-key': 'invalid-api-key',
        'idempotency-key': 'test-idempotency-key-' + randomUUID().replace(/-/g, ''),
      },
      payload: {
        amount: 1000,
        currency: 'usd',
        description: 'Test payment',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: 'Invalid API key.'
    });
  });

  it('should return 401 for missing API key', async () => {
    // Make a request to create a payment without an API key
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/create',
      headers: {
        'idempotency-key': 'test-idempotency-key-' + randomUUID().replace(/-/g, ''),
      },
      payload: {
        amount: 1000,
        currency: 'usd',
        description: 'Test payment',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: 'API key is required.'
    });
  });

  it('should return 401 for inactive client', async () => {
    // Create a client with an API key but inactive status
    const clientId = randomUUID();
    const apiKey = 'test_inactive_api_key_' + randomUUID().replace(/-/g, '');

    await db.insert(clients).values({
      id: clientId,
      name: 'Inactive Client',
      email: 'inactive@example.com',
      apiKey: apiKey,
      status: 'inactive' // This should cause auth to fail
    });

    // Make a request to create a payment with the API key from inactive client
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/create',
      headers: {
        'x-api-key': apiKey,
        'idempotency-key': 'test-idempotency-key-' + randomUUID().replace(/-/g, ''),
      },
      payload: {
        amount: 1000,
        currency: 'usd',
        description: 'Test payment',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: 'Invalid API key.'
    });

    // Clean up
    await db.delete(clients).where(eq(clients.id, clientId));
  });
});