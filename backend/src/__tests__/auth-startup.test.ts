import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateAdminPasswordConfig } from '../routes/auth';

describe('Production password enforcement', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should reject plaintext password in production mode', () => {
    process.env.NODE_ENV = 'production';
    process.env.ADMIN_PASSWORD = 'plaintext-password';

    expect(() => validateAdminPasswordConfig()).toThrow(
      'SECURITY ERROR: ADMIN_PASSWORD must be a bcrypt hash in production mode'
    );
  });

  it('should accept bcrypt hash in production mode', () => {
    process.env.NODE_ENV = 'production';
    // Real bcrypt hash for "test-password"
    process.env.ADMIN_PASSWORD = '$2a$10$kW7ozp0Y3axIfPJcfHSNjOih8JPC1JLX8KXg5MUl3e4LoVP.Hwn/C';

    expect(() => validateAdminPasswordConfig()).not.toThrow();
    expect(validateAdminPasswordConfig()).toBe(true);
  });

  it('should allow plaintext password in development mode (returns false)', () => {
    process.env.NODE_ENV = 'development';
    process.env.ADMIN_PASSWORD = 'dev-password';

    expect(() => validateAdminPasswordConfig()).not.toThrow();
    expect(validateAdminPasswordConfig()).toBe(false);
  });

  it('should return true when ADMIN_PASSWORD is not set', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ADMIN_PASSWORD;

    expect(() => validateAdminPasswordConfig()).not.toThrow();
    expect(validateAdminPasswordConfig()).toBe(true);
  });
});
