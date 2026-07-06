import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Prevent dotenv from overwriting process.env in tests
vi.mock("dotenv", () => ({
  default: { config: vi.fn() },
}));

import { logMaskedEnvSummary, validateEnv } from "../../lib/env";

// Minimal valid env (all required vars except the conditionally-required admin ones)
const BASE_ENV: Record<string, string> = {
  STRIPE_SECRET_KEY: "sk_test_validkey",
  STRIPE_WEBHOOK_SECRET: "whsec_validwebhook",
  FRONTEND_ORIGIN: "http://localhost:5173",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/stripe_portal",
  SMTP_HOST: "localhost",
  SMTP_PORT: "1025",
  SMTP_USER: "user",
  SMTP_PASS: "pass",
  JWT_SECRET: "test_jwt_secret_minimum_32_characters_long_random_string",
};

describe("validateEnv", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Start each test with a clean slate, then layer in only what we want
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore original environment
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  it("does not throw when admin credentials are missing (always optional now)", () => {
    // Set all required vars
    for (const [k, v] of Object.entries(BASE_ENV)) {
      process.env[k] = v;
    }

    // Should not throw — admin creds are optional
    expect(() => validateEnv()).not.toThrow();
  });

  it("throws in production when ADMIN_PASSWORD is too short", () => {
    for (const [k, v] of Object.entries(BASE_ENV)) {
      process.env[k] = v;
    }
    process.env.NODE_ENV = "production";
    process.env.ADMIN_PASSWORD = "short1";

    expect(() => validateEnv()).toThrow("ADMIN_PASSWORD is too weak");
  });

  it("throws in production when ADMIN_PASSWORD is a known-dev value", () => {
    for (const [k, v] of Object.entries(BASE_ENV)) {
      process.env[k] = v;
    }
    process.env.NODE_ENV = "production";
    process.env.ADMIN_PASSWORD = "changeme";

    expect(() => validateEnv()).toThrow("ADMIN_PASSWORD is too weak");
  });

  it("allows a strong ADMIN_PASSWORD in production", () => {
    for (const [k, v] of Object.entries(BASE_ENV)) {
      process.env[k] = v;
    }
    process.env.NODE_ENV = "production";
    process.env.ADMIN_PASSWORD = "Str0ng-Adm1n-Passw0rd!";

    expect(() => validateEnv()).not.toThrow();
  });

  it("allows a weak ADMIN_PASSWORD outside production", () => {
    for (const [k, v] of Object.entries(BASE_ENV)) {
      process.env[k] = v;
    }
    process.env.NODE_ENV = "development";
    process.env.ADMIN_PASSWORD = "changeme";

    expect(() => validateEnv()).not.toThrow();
  });
});

describe("logMaskedEnvSummary (maskValue behaviour)", () => {
  it("masks a short value (≤ 6 chars) as all asterisks", () => {
    const fakeServer = { log: { info: vi.fn() } };
    logMaskedEnvSummary(fakeServer as any, { SHORT: "abc" });

    const call = fakeServer.log.info.mock.calls[0];
    expect(call[0].env.SHORT).toBe("***");
  });

  it("masks a value of exactly 6 chars as all asterisks", () => {
    const fakeServer = { log: { info: vi.fn() } };
    logMaskedEnvSummary(fakeServer as any, { SIX: "abcdef" });

    const call = fakeServer.log.info.mock.calls[0];
    expect(call[0].env.SIX).toBe("******");
  });

  it('masks an empty string as "undefined"', () => {
    const fakeServer = { log: { info: vi.fn() } };
    logMaskedEnvSummary(fakeServer as any, { EMPTY: "" });

    const call = fakeServer.log.info.mock.calls[0];
    expect(call[0].env.EMPTY).toBe("undefined");
  });

  it("masks a long non-secret value by keeping the first 6 chars visible", () => {
    const fakeServer = { log: { info: vi.fn() } };
    logMaskedEnvSummary(fakeServer as any, { LONG: "some_long_preview_value" });

    const call = fakeServer.log.info.mock.calls[0];
    const masked: string = call[0].env.LONG;
    expect(masked.startsWith("some_l")).toBe(true);
    expect(masked).toContain("*");
  });

  it("fully redacts a fully-secret key with no prefix or length leak", () => {
    const fakeServer = { log: { info: vi.fn() } };
    logMaskedEnvSummary(fakeServer as any, { STRIPE_SECRET_KEY: "sk_test_supersecretvalue" });

    const call = fakeServer.log.info.mock.calls[0];
    expect(call[0].env.STRIPE_SECRET_KEY).toBe("<redacted>");
  });

  it("fully redacts any key matching *_SECRET/*_PASSWORD/*_KEY patterns", () => {
    const fakeServer = { log: { info: vi.fn() } };
    logMaskedEnvSummary(fakeServer as any, {
      JWT_SECRET: "abcdefghijklmnopqrstuvwxyz",
      SMTP_PASS: "abcdefghijklmnop",
      DATABASE_URL: "postgresql://user:pass@host:5432/db",
      ADMIN_PASSWORD: "Str0ng-Adm1n-Passw0rd!",
      NEXTCLOUD_APP_PASSWORD: "some-app-password",
      CUSTOM_KEY: "custom-key-value",
    });

    const call = fakeServer.log.info.mock.calls[0];
    const env = call[0].env;
    expect(env.JWT_SECRET).toBe("<redacted>");
    expect(env.SMTP_PASS).toBe("<redacted>");
    expect(env.DATABASE_URL).toBe("<redacted>");
    expect(env.ADMIN_PASSWORD).toBe("<redacted>");
    expect(env.NEXTCLOUD_APP_PASSWORD).toBe("<redacted>");
    expect(env.CUSTOM_KEY).toBe("<redacted>");
  });

  it('fully redacts to "undefined" when a secret value is empty', () => {
    const fakeServer = { log: { info: vi.fn() } };
    logMaskedEnvSummary(fakeServer as any, { JWT_SECRET: "" });

    const call = fakeServer.log.info.mock.calls[0];
    expect(call[0].env.JWT_SECRET).toBe("undefined");
  });
});
