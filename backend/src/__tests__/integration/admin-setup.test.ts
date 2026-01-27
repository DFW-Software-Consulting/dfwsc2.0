import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Admin Setup Integration Tests
 *
 * NOTE: These tests use the vitest environment defined in vitest.config.ts.
 * Full E2E testing of the setup flow should be done in the Docker environment
 * where environment variables can be properly controlled.
 *
 * The tests focus on guard conditions that don't require modifying ADMIN_PASSWORD.
 */

describe('Admin Setup Integration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    vi.resetModules();
    // Reset the setupUsed flag after each test
    const authModule = await import('../../routes/auth');
    authModule.resetSetupState();
  });

  async function createServer() {
    vi.resetModules();
    const rateLimitModule = await import('../../lib/rate-limit');
    if (rateLimitModule.hitBuckets) {
      rateLimitModule.hitBuckets.clear();
    }
    vi.resetModules();
    const authModule = await import('../../routes/auth');
    authModule.resetSetupState();
    vi.resetModules();
    const { buildServer } = await import('../../app');
    return buildServer();
  }

  describe('GET /auth/setup/status', () => {
    it('should return setupAllowed=false when ALLOW_ADMIN_SETUP is not set', async () => {
      delete process.env.ALLOW_ADMIN_SETUP;
      const server = await createServer();

      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/auth/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.setupAllowed).toBe(false);
      // adminConfigured=true because vitest.config.ts sets ADMIN_PASSWORD
      expect(body.adminConfigured).toBe(true);

      await server.close();
    });

    it('should return adminConfigured=true when ADMIN_PASSWORD is set', async () => {
      const server = await createServer();

      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/auth/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.adminConfigured).toBe(true);

      await server.close();
    });
  });

  describe('POST /auth/setup - guards', () => {
    it('should return 403 when ALLOW_ADMIN_SETUP is not enabled', async () => {
      delete process.env.ALLOW_ADMIN_SETUP;
      const server = await createServer();

      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'admin', password: 'securepass123' },
        headers: { 'content-type': 'application/json' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe('Admin setup is not enabled');

      await server.close();
    });

    it('should return 403 when admin is already configured', async () => {
      // Enable admin setup but ADMIN_PASSWORD is already set (from vitest.config.ts)
      process.env.ALLOW_ADMIN_SETUP = 'true';
      const server = await createServer();

      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'admin', password: 'securepass123' },
        headers: { 'content-type': 'application/json' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe('Admin is already configured');

      await server.close();
      delete process.env.ALLOW_ADMIN_SETUP;
    });
  });

  describe('resetSetupState function', () => {
    it('should export resetSetupState function for testing', async () => {
      const authModule = await import('../../routes/auth');
      expect(typeof authModule.resetSetupState).toBe('function');
    });
  });
});
