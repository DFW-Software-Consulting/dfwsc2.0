import { vi } from 'vitest';
import jwt from 'jsonwebtoken';

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
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';

describe('Onboarding Token Lifecycle Integration', () => {
  let app: any;
  const originalEnv = { ...process.env };

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

  afterAll(async () => {
    // Restore original environment
    Object.keys(process.env).forEach(key => {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    });
    Object.assign(process.env, originalEnv);

    if (app) {
      await app.close();
    }
  });

  it('should verify token remains pending until explicit state transition via /onboard-client', async () => {
    // Create an admin JWT token for authentication
    const adminToken = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET || 'test_jwt_secret');

    // Call POST /api/v1/accounts endpoint which creates a client and a token with 'pending' status
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts',
      headers: {
        'Authorization': `Bearer ${adminToken}`
      },
      payload: {
        name: 'Test Client',
        email: 'test@example.com'
      }
    });

    expect(response.statusCode).toBe(201);

    // Verify that a token was created with 'pending' status
    const [tokenRecord] = await db.select()
      .from(onboardingTokens)
      .where(eq(onboardingTokens.email, 'test@example.com'));

    expect(tokenRecord).toBeDefined();
    expect(tokenRecord.status).toBe('pending');

    // Verify that the token remains 'pending' without calling /onboard-client
    // Check again after a brief moment to ensure persistence
    const [stillPendingToken] = await db.select()
      .from(onboardingTokens)
      .where(eq(onboardingTokens.id, tokenRecord.id));

    expect(stillPendingToken.status).toBe('pending');

    // Now call /onboard-client endpoint which should transition status to 'in_progress'
    const onboardResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/onboard-client?token=${tokenRecord.token}`,
    });

    expect(onboardResponse.statusCode).toBe(200);

    // Verify status changed to 'in_progress' after calling /onboard-client
    const [updatedToken] = await db.select()
      .from(onboardingTokens)
      .where(eq(onboardingTokens.id, tokenRecord.id));

    expect(updatedToken.status).toBe('in_progress');

    // Clean up
    await db.delete(clients).where(eq(clients.email, 'test@example.com'));
    await db.delete(onboardingTokens).where(eq(onboardingTokens.id, tokenRecord.id));
  });

  it('allows retry when stripe.accountLinks.create fails', async () => {
    // Create an admin JWT token for authentication
    const adminToken = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET || 'test_jwt_secret');

    // Call POST /api/v1/accounts endpoint which creates a client and a token with 'pending' status
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts',
      headers: {
        'Authorization': `Bearer ${adminToken}`
      },
      payload: {
        name: 'Retry Test Client',
        email: 'retry-test@example.com'
      }
    });

    expect(response.statusCode).toBe(201);

    // Get the token record
    const [tokenRecord] = await db.select()
      .from(onboardingTokens)
      .where(eq(onboardingTokens.email, 'retry-test@example.com'));

    expect(tokenRecord).toBeDefined();
    expect(tokenRecord.status).toBe('pending');

    // Mock stripe.accountLinks.create to reject on first call
    const { stripe } = await import('../../lib/stripe');
    stripe.accountLinks.create.mockRejectedValueOnce(new Error('Stripe API failed'));

    // Call /onboard-client endpoint which should fail due to Stripe error
    const failedOnboardResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/onboard-client?token=${tokenRecord.token}`,
    });

    expect(failedOnboardResponse.statusCode).toBe(502);
    expect(failedOnboardResponse.json()).toEqual({
      error: 'Failed to create Stripe account link. Please try again.',
      code: 'STRIPE_ACCOUNT_LINK_FAILED'
    });

    // Verify token still has 'pending' status after failure
    const [stillPendingToken] = await db.select()
      .from(onboardingTokens)
      .where(eq(onboardingTokens.id, tokenRecord.id));

    expect(stillPendingToken.status).toBe('pending');

    // Reset the mock to succeed on the next call
    stripe.accountLinks.create.mockResolvedValueOnce({ url: 'https://connect.stripe.com/setup/success' });

    // Call /onboard-client endpoint again which should now succeed
    const successOnboardResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/onboard-client?token=${tokenRecord.token}`,
    });

    expect(successOnboardResponse.statusCode).toBe(200);
    expect(successOnboardResponse.json()).toEqual({
      url: 'https://connect.stripe.com/setup/success'
    });

    // Verify status changed to 'in_progress' after successful retry
    const [updatedToken] = await db.select()
      .from(onboardingTokens)
      .where(eq(onboardingTokens.id, tokenRecord.id));

    expect(updatedToken.status).toBe('in_progress');

    // Clean up
    await db.delete(clients).where(eq(clients.email, 'retry-test@example.com'));
    await db.delete(onboardingTokens).where(eq(onboardingTokens.id, tokenRecord.id));
  });
});