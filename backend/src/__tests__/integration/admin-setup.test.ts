import { describe, it, expect, beforeEach, vi } from 'vitest';

// Helper function to create a server instance for testing
async function createServer() {
  // Reset modules to ensure clean state
  vi.resetModules();
  const { buildServer } = await import('../../app');
  return buildServer();
}

describe('Admin Setup Integration', () => {
  beforeEach(async () => {
    vi.resetModules();
    // Clear rate limit buckets before each test
    const rateLimitModule = await import('../../lib/rate-limit');
    if (rateLimitModule.hitBuckets) {
      rateLimitModule.hitBuckets.clear();
    }
  });

  describe('GET /auth/setup/status', () => {
    it('should return setupAllowed=false when ALLOW_ADMIN_SETUP is not set', async () => {
      // Ensure ALLOW_ADMIN_SETUP is not set
      delete process.env.ALLOW_ADMIN_SETUP;

      const server = await createServer();

      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/auth/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.setupAllowed).toBe(false);
      expect(body.adminConfigured).toBe(true); // ADMIN_PASSWORD is set in test env

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

  describe('POST /auth/setup', () => {
    it('should return 403 when ALLOW_ADMIN_SETUP is not enabled', async () => {
      // Ensure ALLOW_ADMIN_SETUP is not set
      delete process.env.ALLOW_ADMIN_SETUP;

      const server = await createServer();

      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: {
          username: 'newadmin',
          password: 'securepassword123',
        },
        headers: {
          'content-type': 'application/json',
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'Admin setup is not enabled' });

      await server.close();
    });

    it('should return 403 when admin is already configured', async () => {
      // Set ALLOW_ADMIN_SETUP but keep ADMIN_PASSWORD (already configured)
      process.env.ALLOW_ADMIN_SETUP = 'true';

      const server = await createServer();

      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: {
          username: 'newadmin',
          password: 'securepassword123',
        },
        headers: {
          'content-type': 'application/json',
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'Admin is already configured' });

      await server.close();
    });

    it('should return 400 when username or password is missing', async () => {
      // Set up conditions for setup to be allowed
      process.env.ALLOW_ADMIN_SETUP = 'true';
      const originalPassword = process.env.ADMIN_PASSWORD;
      delete process.env.ADMIN_PASSWORD;

      try {
        const server = await createServer();

        const response = await server.inject({
          method: 'POST',
          url: '/api/v1/auth/setup',
          payload: {
            username: 'newadmin',
            // missing password
          },
          headers: {
            'content-type': 'application/json',
          },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: 'Username and password are required' });

        await server.close();
      } finally {
        process.env.ADMIN_PASSWORD = originalPassword;
      }
    });

    it('should return 400 when password is too short', async () => {
      // Set up conditions for setup to be allowed
      process.env.ALLOW_ADMIN_SETUP = 'true';
      const originalPassword = process.env.ADMIN_PASSWORD;
      delete process.env.ADMIN_PASSWORD;

      try {
        const server = await createServer();

        const response = await server.inject({
          method: 'POST',
          url: '/api/v1/auth/setup',
          payload: {
            username: 'newadmin',
            password: 'short',
          },
          headers: {
            'content-type': 'application/json',
          },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: 'Password must be at least 8 characters' });

        await server.close();
      } finally {
        process.env.ADMIN_PASSWORD = originalPassword;
      }
    });

    it('should return bcrypt hash on successful setup', async () => {
      // Set up conditions for setup to be allowed
      process.env.ALLOW_ADMIN_SETUP = 'true';
      const originalPassword = process.env.ADMIN_PASSWORD;
      delete process.env.ADMIN_PASSWORD;

      try {
        const server = await createServer();

        const response = await server.inject({
          method: 'POST',
          url: '/api/v1/auth/setup',
          payload: {
            username: 'newadmin',
            password: 'securepassword123',
          },
          headers: {
            'content-type': 'application/json',
          },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.username).toBe('newadmin');
        expect(body.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt hash pattern
        expect(body.instructions).toBeInstanceOf(Array);
        expect(body.instructions.length).toBeGreaterThan(0);

        await server.close();
      } finally {
        process.env.ADMIN_PASSWORD = originalPassword;
      }
    });

    it('should return 403 on subsequent setup attempts (one-time use)', async () => {
      // Set up conditions for setup to be allowed
      process.env.ALLOW_ADMIN_SETUP = 'true';
      const originalPassword = process.env.ADMIN_PASSWORD;
      delete process.env.ADMIN_PASSWORD;

      try {
        const server = await createServer();

        // First setup should succeed
        const firstResponse = await server.inject({
          method: 'POST',
          url: '/api/v1/auth/setup',
          payload: {
            username: 'newadmin',
            password: 'securepassword123',
          },
          headers: {
            'content-type': 'application/json',
          },
        });

        expect(firstResponse.statusCode).toBe(200);

        // Second setup should fail
        const secondResponse = await server.inject({
          method: 'POST',
          url: '/api/v1/auth/setup',
          payload: {
            username: 'anotheradmin',
            password: 'anotherpassword123',
          },
          headers: {
            'content-type': 'application/json',
          },
        });

        expect(secondResponse.statusCode).toBe(403);
        expect(secondResponse.json()).toEqual({ error: 'Setup has already been used this session' });

        await server.close();
      } finally {
        process.env.ADMIN_PASSWORD = originalPassword;
      }
    });

    it('should return 401 when setup token is required but not provided', async () => {
      // Set up conditions for setup to be allowed with token requirement
      process.env.ALLOW_ADMIN_SETUP = 'true';
      process.env.ADMIN_SETUP_TOKEN = 'secret-setup-token';
      const originalPassword = process.env.ADMIN_PASSWORD;
      delete process.env.ADMIN_PASSWORD;

      try {
        const server = await createServer();

        const response = await server.inject({
          method: 'POST',
          url: '/api/v1/auth/setup',
          payload: {
            username: 'newadmin',
            password: 'securepassword123',
          },
          headers: {
            'content-type': 'application/json',
          },
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: 'Invalid setup token' });

        await server.close();
      } finally {
        process.env.ADMIN_PASSWORD = originalPassword;
        delete process.env.ADMIN_SETUP_TOKEN;
      }
    });

    it('should succeed when correct setup token is provided', async () => {
      // Set up conditions for setup to be allowed with token requirement
      process.env.ALLOW_ADMIN_SETUP = 'true';
      process.env.ADMIN_SETUP_TOKEN = 'secret-setup-token';
      const originalPassword = process.env.ADMIN_PASSWORD;
      delete process.env.ADMIN_PASSWORD;

      try {
        const server = await createServer();

        const response = await server.inject({
          method: 'POST',
          url: '/api/v1/auth/setup',
          payload: {
            username: 'newadmin',
            password: 'securepassword123',
          },
          headers: {
            'content-type': 'application/json',
            'x-setup-token': 'secret-setup-token',
          },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.username).toBe('newadmin');
        expect(body.passwordHash).toMatch(/^\$2[aby]\$/);

        await server.close();
      } finally {
        process.env.ADMIN_PASSWORD = originalPassword;
        delete process.env.ADMIN_SETUP_TOKEN;
      }
    });
  });
});
