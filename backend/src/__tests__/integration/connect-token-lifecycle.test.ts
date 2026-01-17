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
});