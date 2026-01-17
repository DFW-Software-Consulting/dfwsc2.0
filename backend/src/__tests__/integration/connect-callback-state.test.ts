import { vi } from 'vitest';

// Mock Stripe before importing other modules
vi.mock('../../lib/stripe', async () => {
  const mockAccounts = {
    create: vi.fn(),
  };
  const mockAccountLinks = {
    create: vi.fn(),
  };

  return {
    stripe: {
      accounts: mockAccounts,
      accountLinks: mockAccountLinks,
    }
  };
});

import { buildServer } from '../../app';
import { db } from '../../db/client';
import { clients, onboardingTokens } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';

describe('Connect Callback State Validation Integration', () => {
  let app: any;

  beforeAll(async () => {
    // Set up environment variables for testing
    process.env.STRIPE_SECRET_KEY = 'sk_test_12345';
    process.env.FRONTEND_ORIGIN = 'http://localhost:5173';
    process.env.API_BASE_URL = 'http://localhost:4242';

    // Mock Stripe methods
    const { stripe } = await import('../../lib/stripe');
    stripe.accounts.create.mockResolvedValue({ id: 'acct_test123456789' });
    stripe.accountLinks.create.mockResolvedValue({ url: 'https://connect.stripe.com/setup/mock' });

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

  it('should verify complete token lifecycle: pending → in_progress → completed', async () => {
    // Create a client
    const clientId = randomUUID();
    const testEmail = 'test@example.com';
    const testToken = 'test_token_' + randomUUID().replace(/-/g, '');

    await db.insert(clients).values({
      id: clientId,
      name: 'Test Client',
      email: testEmail,
      apiKey: 'test_api_key_' + randomUUID().replace(/-/g, ''),
      status: 'active'
    });

    // Create an onboarding token with initial 'pending' status
    const onboardingTokenId = randomUUID();
    const testStripeAccount = 'acct_test123456789';

    await db.insert(onboardingTokens).values({
      id: onboardingTokenId,
      clientId: clientId,
      token: testToken,
      status: 'pending',
      email: testEmail,
    });

    // Verify initial status is 'pending'
    let [tokenRecord] = await db.select().from(onboardingTokens).where(eq(onboardingTokens.id, onboardingTokenId));
    expect(tokenRecord.status).toBe('pending');

    // Call /onboard-client endpoint which should change status to 'in_progress'
    const onboardResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/onboard-client?token=${testToken}`,
    });

    expect(onboardResponse.statusCode).toBe(200);

    // Verify status changed to 'in_progress'
    [tokenRecord] = await db.select().from(onboardingTokens).where(eq(onboardingTokens.id, onboardingTokenId));
    expect(tokenRecord.status).toBe('in_progress');

    // Now simulate the callback with valid state to complete the process
    // First, get the state that was set during the onboard-client call
    [tokenRecord] = await db.select().from(onboardingTokens).where(eq(onboardingTokens.id, onboardingTokenId));
    const state = tokenRecord.state;
    const stateExpiresAt = tokenRecord.stateExpiresAt;

    // Make a request to the callback with valid state
    const callbackResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/connect/callback?client_id=${clientId}&account=${testStripeAccount}&state=${state}`,
    });

    // Should redirect successfully (302 for redirect)
    expect(callbackResponse.statusCode).toBe(302);

    // Verify that the stripeAccountId was updated in the database
    const [updatedClient] = await db.select().from(clients).where(eq(clients.id, clientId));
    expect(updatedClient.stripeAccountId).toBe(testStripeAccount);

    // Verify status changed to 'completed'
    [tokenRecord] = await db.select().from(onboardingTokens).where(eq(onboardingTokens.id, onboardingTokenId));
    expect(tokenRecord.status).toBe('completed');

    // Clean up
    await db.delete(clients).where(eq(clients.id, clientId));
    await db.delete(onboardingTokens).where(eq(onboardingTokens.id, onboardingTokenId));
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
      status: 'in_progress',
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

    // Verify status changed to 'completed'
    const [updatedToken] = await db.select().from(onboardingTokens).where(eq(onboardingTokens.id, onboardingTokenId));
    expect(updatedToken.status).toBe('completed');

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
      status: 'in_progress',
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
      error: 'Invalid or expired state parameter.'
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
      status: 'in_progress',
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
      status: 'in_progress',
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

  it('should reject state parameter from different client (cross-client injection)', async () => {
    // Create two separate clients
    const clientAId = randomUUID();
    const clientBId = randomUUID();
    const testEmailA = 'test-a@example.com';
    const testEmailB = 'test-b@example.com';

    await db.insert(clients).values({
      id: clientAId,
      name: 'Test Client A',
      email: testEmailA,
      apiKey: 'test_api_key_' + randomUUID().replace(/-/g, ''),
      status: 'active'
    });

    await db.insert(clients).values({
      id: clientBId,
      name: 'Test Client B',
      email: testEmailB,
      apiKey: 'test_api_key_' + randomUUID().replace(/-/g, ''),
      status: 'active'
    });

    // Create onboarding tokens with states for both clients
    const onboardingTokenAId = randomUUID();
    const onboardingTokenBId = randomUUID();
    const stateA = 'state_a_' + randomUUID().replace(/-/g, '');
    const stateB = 'state_b_' + randomUUID().replace(/-/g, '');
    const testStripeAccount = 'acct_test123456789';

    // Set states to expire in 30 minutes from now
    const stateExpiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await db.insert(onboardingTokens).values({
      id: onboardingTokenAId,
      clientId: clientAId,
      token: 'test_token_a_' + randomUUID().replace(/-/g, ''),
      status: 'in_progress',
      email: testEmailA,
      state: stateA,
      stateExpiresAt: stateExpiresAt
    });

    await db.insert(onboardingTokens).values({
      id: onboardingTokenBId,
      clientId: clientBId,
      token: 'test_token_b_' + randomUUID().replace(/-/g, ''),
      status: 'in_progress',
      email: testEmailB,
      state: stateB,
      stateExpiresAt: stateExpiresAt
    });

    // Attempt to use Client A's client_id with Client B's state (cross-client injection)
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/connect/callback?client_id=${clientAId}&account=${testStripeAccount}&state=${stateB}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Invalid or expired state parameter.'
    });

    // Also test the reverse: Client B's client_id with Client A's state
    const response2 = await app.inject({
      method: 'GET',
      url: `/api/v1/connect/callback?client_id=${clientBId}&account=${testStripeAccount}&state=${stateA}`,
    });

    expect(response2.statusCode).toBe(400);
    expect(response2.json()).toEqual({
      error: 'Invalid or expired state parameter.'
    });

    // Clean up
    await db.delete(clients).where(eq(clients.id, clientAId));
    await db.delete(clients).where(eq(clients.id, clientBId));
    await db.delete(onboardingTokens).where(eq(onboardingTokens.id, onboardingTokenAId));
    await db.delete(onboardingTokens).where(eq(onboardingTokens.id, onboardingTokenBId));
  });
});