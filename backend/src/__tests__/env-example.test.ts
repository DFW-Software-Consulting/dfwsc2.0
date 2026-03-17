import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Documentation Verification Test
 *
 * Purpose: Ensures that backend/.env.example contains all required admin authentication
 * variables with proper documentation. This prevents regression where critical environment
 * variables might be accidentally removed from the template file.
 *
 * This test validates the completeness of the environment template, not the actual
 * environment configuration. It ensures new developers have a complete reference when
 * setting up their local environment.
 */
describe("Environment Template Documentation", () => {
  let envExampleContent: string;

  beforeAll(() => {
    // ENV_EXAMPLE_PATH is set by docker-compose.dev.yml to /tmp/env-example (mounted from root .env.example).
    // Falls back to ../../.env.example for local runs outside Docker.
    const envExamplePath = process.env.ENV_EXAMPLE_PATH ?? join(__dirname, "../../.env.example");
    try {
      envExampleContent = readFileSync(envExamplePath, "utf-8");
    } catch (error) {
      throw new Error(
        `Failed to read .env.example file at ${envExamplePath}. ` +
          `Ensure the file exists and is readable. Error: ${error}`
      );
    }
  });

  describe("Admin Authentication Variables", () => {
    it("should document JWT_SECRET variable", () => {
      const hasJwtSecret = envExampleContent.includes("JWT_SECRET=");

      expect(hasJwtSecret).toBe(true);

      if (!hasJwtSecret) {
        throw new Error(
          "JWT_SECRET variable is missing from backend/.env.example. " +
            "This variable is required for signing JWT tokens in admin authentication. " +
            "Add: JWT_SECRET=your_jwt_secret_minimum_32_characters_long_random_string " +
            "with minimum length requirement comment (32 characters)."
        );
      }
    });

    it("should document JWT_EXPIRY variable (optional)", () => {
      const hasJwtExpiry = envExampleContent.includes("JWT_EXPIRY=");

      expect(hasJwtExpiry).toBe(true);

      if (!hasJwtExpiry) {
        throw new Error(
          "JWT_EXPIRY variable is missing from backend/.env.example. " +
            'While optional at runtime (defaults to "1h"), it should be documented ' +
            "in the template for developer awareness. " +
            'Add: JWT_EXPIRY=1h with comment noting it is optional and defaults to "1h".'
        );
      }
    });
  });

  describe("Admin Authentication Documentation Quality", () => {
    it("should include minimum length requirement for JWT_SECRET", () => {
      // Check for minimum length guidance near JWT_SECRET
      const hasLengthGuidance =
        envExampleContent.includes("32") ||
        (envExampleContent.includes("minimum") && envExampleContent.includes("JWT_SECRET"));

      expect(hasLengthGuidance).toBe(true);

      if (!hasLengthGuidance) {
        console.warn(
          "Warning: backend/.env.example should include minimum length requirement " +
            "(32 characters) for JWT_SECRET variable."
        );
      }
    });

    it("should indicate JWT_EXPIRY is optional with default value", () => {
      // Check for optional/default value indication near JWT_EXPIRY
      const hasDefaultValue =
        envExampleContent.includes("1h") && envExampleContent.includes("JWT_EXPIRY");

      expect(hasDefaultValue).toBe(true);

      if (!hasDefaultValue) {
        console.warn(
          "Warning: backend/.env.example should indicate that JWT_EXPIRY is optional " +
            'and defaults to "1h" if not specified.'
        );
      }
    });
  });

  describe("Admin Authentication Section Organization", () => {
    it("should have an Admin Authentication comment section", () => {
      const hasAdminAuthSection =
        envExampleContent.includes("Admin Authentication") ||
        envExampleContent.includes("ADMIN AUTH") ||
        (envExampleContent.includes("JWT") && envExampleContent.includes("#"));

      expect(hasAdminAuthSection).toBe(true);

      if (!hasAdminAuthSection) {
        console.warn(
          "Warning: backend/.env.example should have a clear comment section header " +
            'for Admin Authentication variables (e.g., "# Admin Authentication (JWT)").'
        );
      }
    });

    it("should group JWT_SECRET and JWT_EXPIRY together", () => {
      const jwtSecretIndex = envExampleContent.indexOf("JWT_SECRET=");
      const jwtExpiryIndex = envExampleContent.indexOf("JWT_EXPIRY=");

      expect(jwtSecretIndex).toBeGreaterThan(-1);
      expect(jwtExpiryIndex).toBeGreaterThan(-1);

      const groupingDistance = Math.abs(jwtExpiryIndex - jwtSecretIndex);
      expect(groupingDistance).toBeLessThan(500);
    });
  });
});

/**
 * Helper function to be used in beforeAll hook
 */
function beforeAll(fn: () => void) {
  // Vitest doesn't have beforeAll for individual describe blocks,
  // so we'll execute this immediately when the test file is loaded
  fn();
}

beforeAll(() => {
  // This runs before all tests in this file
});
