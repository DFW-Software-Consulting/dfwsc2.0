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
  USE_CHECKOUT: "false",
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

  it("throws when USE_CHECKOUT has an invalid value", () => {
    for (const [k, v] of Object.entries(BASE_ENV)) {
      process.env[k] = v;
    }
    process.env.USE_CHECKOUT = "maybe";

    expect(() => validateEnv()).toThrow('USE_CHECKOUT must be either "true" or "false"');
  });

  it("accepts USE_CHECKOUT=true as a valid value", () => {
    for (const [k, v] of Object.entries(BASE_ENV)) {
      process.env[k] = v;
    }
    process.env.USE_CHECKOUT = "true";

    expect(() => validateEnv()).not.toThrow();
  });

  it("accepts USE_CHECKOUT=false as a valid value", () => {
    for (const [k, v] of Object.entries(BASE_ENV)) {
      process.env[k] = v;
    }
    process.env.USE_CHECKOUT = "false";

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

  it("masks a long value by keeping the first 6 chars visible", () => {
    const fakeServer = { log: { info: vi.fn() } };
    logMaskedEnvSummary(fakeServer as any, { LONG: "sk_test_supersecretvalue" });

    const call = fakeServer.log.info.mock.calls[0];
    const masked: string = call[0].env.LONG;
    expect(masked.startsWith("sk_tes")).toBe(true);
    expect(masked).toContain("*");
  });
});
