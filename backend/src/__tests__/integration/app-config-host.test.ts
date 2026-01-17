import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import configRoutes from '../../routes/config';

describe('App Config Host Header Validation', () => {
  let app: any;

  beforeEach(async () => {
    // Mock the API_BASE_URL environment variable
    process.env.API_BASE_URL = 'https://api.example.com';
    
    app = Fastify();
    await app.register(configRoutes);
    await app.ready();
  });

  afterEach(() => {
    // Clean up environment variable
    delete process.env.API_BASE_URL;
    vi.clearAllMocks();
    app.close();
  });

  it('ignores malicious Host header when API_BASE_URL is set', async () => {
    // Send request with malicious Host header
    const maliciousHost = 'evil.com';
    const response = await app.inject({
      method: 'GET',
      url: '/app-config.js',
      headers: {
        host: maliciousHost,
        'x-forwarded-host': maliciousHost,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/javascript');

    // Verify that the response contains only the configured API_BASE_URL value, not the malicious host
    const responseBody = response.body;
    expect(responseBody).toContain('https://api.example.com'); // Should contain the legitimate API URL
    expect(responseBody).not.toContain(maliciousHost); // Should NOT contain the malicious host
  });

  it('returns 500 error when API_BASE_URL is not set', async () => {
    // Unset the API_BASE_URL to simulate misconfiguration
    delete process.env.API_BASE_URL;
    
    // Restart the app to pick up the changed environment
    app.close();
    app = Fastify();
    await app.register(configRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/app-config.js',
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: 'Internal Server Error: API_BASE_URL not configured'
    });
  });
});