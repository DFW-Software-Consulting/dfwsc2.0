import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../app';
import { validateEnv } from '../lib/env';
import dotenv from 'dotenv';

describe('Environment Variable Loading Order', () => {
  beforeEach(() => {
    // Store original env
    this.originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore original env
    process.env = this.originalEnv;
    vi.resetModules(); // Reset module cache for each test
  });

  it('should throw clear error when STRIPE_WEBHOOK_SECRET is missing', () => {
    // Mock dotenv.config to do nothing
    const dotenvSpy = vi.spyOn(dotenv, 'config').mockImplementation(() => ({ parsed: {} }));

    // Temporarily remove the webhook secret to test error handling
    const originalValue = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;

    try {
      expect(() => validateEnv()).toThrow('Missing required environment variables: STRIPE_WEBHOOK_SECRET');
    } finally {
      // Restore the original value and mock
      process.env.STRIPE_WEBHOOK_SECRET = originalValue;
      dotenvSpy.mockRestore();
    }
  });

  it('should throw clear error when USE_CHECKOUT is missing', () => {
    // Mock dotenv.config to do nothing
    const dotenvSpy = vi.spyOn(dotenv, 'config').mockImplementation(() => ({ parsed: {} }));

    // Temporarily remove USE_CHECKOUT to test error handling
    const originalValue = process.env.USE_CHECKOUT;
    delete process.env.USE_CHECKOUT;

    try {
      expect(() => validateEnv()).toThrow(/Missing required environment variables:.*USE_CHECKOUT/);
    } finally {
      // Restore the original value and mock
      process.env.USE_CHECKOUT = originalValue;
      dotenvSpy.mockRestore();
    }
  });
});