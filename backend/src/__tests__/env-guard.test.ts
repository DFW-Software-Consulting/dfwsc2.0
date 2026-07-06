import dotenv from "dotenv";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateEnv } from "../lib/env";

describe("Environment Variable Loading Order", () => {
  beforeEach(() => {
    // Store original env
    this.originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore original env
    process.env = this.originalEnv;
    vi.resetModules(); // Reset module cache for each test
  });

  it("should throw clear error when STRIPE_WEBHOOK_SECRET is missing", () => {
    // Mock dotenv.config to do nothing
    const dotenvSpy = vi.spyOn(dotenv, "config").mockImplementation(() => ({ parsed: {} }));

    // Temporarily remove the webhook secret to test error handling
    const originalValue = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;

    try {
      expect(() => validateEnv()).toThrow(
        "Missing required environment variables: STRIPE_WEBHOOK_SECRET"
      );
    } finally {
      // Restore the original value and mock
      process.env.STRIPE_WEBHOOK_SECRET = originalValue;
      dotenvSpy.mockRestore();
    }
  });

  it("should throw clear error when SMTP_HOST is missing", () => {
    // Mock dotenv.config to do nothing
    const dotenvSpy = vi.spyOn(dotenv, "config").mockImplementation(() => ({ parsed: {} }));

    // Temporarily remove SMTP_HOST to test error handling
    const originalValue = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST;

    try {
      expect(() => validateEnv()).toThrow(/Missing required environment variables:.*SMTP_HOST/);
    } finally {
      // Restore the original value and mock
      process.env.SMTP_HOST = originalValue;
      dotenvSpy.mockRestore();
    }
  });
});
