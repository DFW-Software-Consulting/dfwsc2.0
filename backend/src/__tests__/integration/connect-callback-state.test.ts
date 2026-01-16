import { buildServer } from '../../app';
import { db } from '../../db/client';
import { clients, onboardingTokens } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';

describe('Connect Callback State Validation Integration', () => {
  let app: any;

  beforeAll(async () => {
    app = await buildServer();
  });

  beforeEach(async () => {
    // Clear any existing test data
    await db.delete(clients).where(eq(clients.name, 'Test Client'));
    await db.delete(onboardingTokens).where(eq(onboardingTokens.email, 'test@example.com'));
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('should accept valid state parameter and update stripeAccountId', async () => {
    // Create a client
    const clientId = randomUUID();
    const testEmail = 'test@example.com';
    
    await db.insert(clients).values({
      id: clientId,
      name: 'Test Client',
      email: testEmail,
      apiKey: 'test_api_key_' + randomUUID().replace(/-/g, ''),
      status: 'active'
    });

    // Create an onboarding token with a valid state
    const onboardingTokenId = randomUUID();
    const state = 'test_state_' + randomUUID().replace(/-/g, '');
    const testStripeAccount = 'acct_test123456789';
    
    // Set state to expire in 30 minutes from now
    const stateExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
    
    await db.insert(onboardingTokens).values({
      id: onboardingTokenId,
      clientId: clientId,
      token: 'test_token_' + randomUUID().replace(/-/g, ''),
      status: 'completed',
      email: testEmail,
      state: state,
      stateExpiresAt: stateExpiresAt
    });

    // Make a request to the callback with valid state
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/connect/callback?client_id=${clientId}&account=${testStripeAccount}&state=${state}`,
    });

    // Should redirect successfully (302 for redirect)
    expect(response.statusCode).toBe(302);

    // Verify that the stripeAccountId was updated in the database
    const [updatedClient] = await db.select().from(clients).where(eq(clients.id, clientId));
    expect(updatedClient.stripeAccountId).toBe(testStripeAccount);

    // Clean up
    await db.delete(clients).where(eq(clients.id, clientId));
    await db.delete(onboardingTokens).where(eq(onboardingTokens.id, onboardingTokenId));
  });

  it('should reject request without state parameter', async () => {
    const clientId = randomUUID();
    const testStripeAccount = 'acct_test123456789';
    
    await db.insert(clients).values({
      id: clientId,
      name: 'Test Client',
      email: 'test@example.com',
      apiKey: 'test_api_key_' + randomUUID().replace(/-/g, ''),
      status: 'active'
    });

    // Make a request to the callback without state parameter
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/connect/callback?client_id=${clientId}&account=${testStripeAccount}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Missing state parameter.'
    });

    // Clean up
    await db.delete(clients).where(eq(clients.id, clientId));
  });

  it('should reject request with invalid state parameter', async () => {
    const clientId = randomUUID();
    const testStripeAccount = 'acct_test123456789';
    
    await db.insert(clients).values({
      id: clientId,
      name: 'Test Client',
      email: 'test@example.com',
      apiKey: 'test_api_key_' + randomUUID().replace(/-/g, ''),
      status: 'active'
    });

    // Create an onboarding token with a valid state
    const onboardingTokenId = randomUUID();
    const validState = 'valid_state_' + randomUUID().replace(/-/g, '');
    const invalidState = 'invalid_state_' + randomUUID().replace(/-/g, '');
    
    // Set state to expire in 30 minutes from now
    const stateExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
    
    await db.insert(onboardingTokens).values({
      id: onboardingTokenId,
      clientId: clientId,
      token: 'test_token_' + randomUUID().replace(/-/g, ''),
      status: 'completed',
      email: 'test@example.com',
      state: validState,
      stateExpiresAt: stateExpiresAt
    });

    // Make a request to the callback with invalid state parameter
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/connect/callback?client_id=${clientId}&account=${testStripeAccount}&state=${invalidState}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Invalid state parameter.'
    });

    // Clean up
    await db.delete(clients).where(eq(clients.id, clientId));
    await db.delete(onboardingTokens).where(eq(onboardingTokens.id, onboardingTokenId));
  });

  it('should reject request with expired state parameter', async () => {
    const clientId = randomUUID();
    const testStripeAccount = 'acct_test123456789';
    
    await db.insert(clients).values({
      id: clientId,
      name: 'Test Client',
      email: 'test@example.com',
      apiKey: 'test_api_key_' + randomUUID().replace(/-/g, ''),
      status: 'active'
    });

    // Create an onboarding token with an expired state
    const onboardingTokenId = randomUUID();
    const expiredState = 'expired_state_' + randomUUID().replace(/-/g, '');
    
    // Set state to have expired in the past
    const expiredStateExpiresAt = new Date(Date.now() - 1000); // 1 second ago
    
    await db.insert(onboardingTokens).values({
      id: onboardingTokenId,
      clientId: clientId,
      token: 'test_token_' + randomUUID().replace(/-/g, ''),
      status: 'completed',
      email: 'test@example.com',
      state: expiredState,
      stateExpiresAt: expiredStateExpiresAt
    });

    // Make a request to the callback with expired state parameter
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/connect/callback?client_id=${clientId}&account=${testStripeAccount}&state=${expiredState}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Expired state parameter.'
    });

    // Clean up
    await db.delete(clients).where(eq(clients.id, clientId));
    await db.delete(onboardingTokens).where(eq(onboardingTokens.id, onboardingTokenId));
  });

  it('should reject request with mismatched account ID', async () => {
    const clientId = randomUUID();
    const existingStripeAccount = 'acct_existing123456';
    const newStripeAccount = 'acct_new123456789';
    
    await db.insert(clients).values({
      id: clientId,
      name: 'Test Client',
      email: 'test@example.com',
      apiKey: 'test_api_key_' + randomUUID().replace(/-/g, ''),
      status: 'active',
      stripeAccountId: existingStripeAccount
    });

    // Create an onboarding token with a valid state
    const onboardingTokenId = randomUUID();
    const state = 'test_state_' + randomUUID().replace(/-/g, '');
    
    // Set state to expire in 30 minutes from now
    const stateExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
    
    await db.insert(onboardingTokens).values({
      id: onboardingTokenId,
      clientId: clientId,
      token: 'test_token_' + randomUUID().replace(/-/g, ''),
      status: 'completed',
      email: 'test@example.com',
      state: state,
      stateExpiresAt: stateExpiresAt
    });

    // Make a request to the callback with a different account ID than already exists
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/connect/callback?client_id=${clientId}&account=${newStripeAccount}&state=${state}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Stripe account already linked to this client.'
    });

    // Verify that the original stripeAccountId was not changed
    const [unchangedClient] = await db.select().from(clients).where(eq(clients.id, clientId));
    expect(unchangedClient.stripeAccountId).toBe(existingStripeAccount);

    // Clean up
    await db.delete(clients).where(eq(clients.id, clientId));
    await db.delete(onboardingTokens).where(eq(onboardingTokens.id, onboardingTokenId));
  });
});