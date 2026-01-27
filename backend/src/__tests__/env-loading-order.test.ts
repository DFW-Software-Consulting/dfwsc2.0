import { buildServer } from '../app';

describe('Environment Loading Order Integration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Set up required environment variables for the test
    process.env.STRIPE_SECRET_KEY = 'sk_test_12345';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test12345';
    process.env.FRONTEND_ORIGIN = 'http://localhost:5173';
    process.env.USE_CHECKOUT = 'true';
    process.env.DATABASE_URL = 'postgresql://user:password@localhost:5432/test_db';
    process.env.SMTP_HOST = 'localhost';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'test_user';
    process.env.SMTP_PASS = 'test_pass';
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'testpass';
    process.env.JWT_SECRET = 'test_jwt_secret';
    process.env.API_BASE_URL = 'http://localhost:4242';
  });

  afterEach(() => {
    // Restore original environment
    Object.keys(process.env).forEach(key => {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    });
    Object.assign(process.env, originalEnv);
  });

  it('should verify env vars are loaded before route registration reads them', async () => {
    // Capture any errors during server build to ensure env vars are available when routes register
    let server;
    let errorDuringBuild = null;

    try {
      server = await buildServer();
    } catch (error) {
      errorDuringBuild = error;
    }

    // Verify that no error occurred during server build due to missing env vars
    expect(errorDuringBuild).toBeNull();

    // Verify that the server was built successfully
    expect(server).toBeDefined();

    // Verify that the server was built successfully without errors related to missing env vars
    // The fact that we can build the server means env vars were available during route registration
    // since routes like webhooks.ts would throw an error if STRIPE_WEBHOOK_SECRET wasn't available

    // Clean up
    if (server) {
      await server.close();
    }
  });

  it('should verify validateEnv is called before routes access env vars', async () => {
    // Verify that validateEnv can be called successfully before building server
    const { validateEnv } = await import('../lib/env');
    const validatedEnv = validateEnv();

    // Check that required env vars are present in the validated environment
    expect(validatedEnv.USE_CHECKOUT).toBe('true');
    expect(validatedEnv.STRIPE_WEBHOOK_SECRET).toBe('whsec_test12345');

    // Now build the server, which should also call validateEnv internally
    const server = await buildServer();

    // Verify server was built successfully
    expect(server).toBeDefined();

    // Clean up
    await server.close();
  });
});