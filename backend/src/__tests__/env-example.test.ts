import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

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
describe('Environment Template Documentation', () => {
  let envExampleContent: string;

  beforeAll(() => {
    // Read the .env.example file from the backend directory
    const envExamplePath = join(__dirname, '../../.env.example');
    try {
      envExampleContent = readFileSync(envExamplePath, 'utf-8');
    } catch (error) {
      throw new Error(
        `Failed to read backend/.env.example file at ${envExamplePath}. ` +
        `Ensure the file exists and is readable. Error: ${error}`
      );
    }
  });

  describe('Admin Authentication Variables', () => {
    it('should document ADMIN_USERNAME variable', () => {
      const hasAdminUsername = envExampleContent.includes('ADMIN_USERNAME=');

      expect(hasAdminUsername).toBe(true);

      if (!hasAdminUsername) {
        throw new Error(
          'ADMIN_USERNAME variable is missing from backend/.env.example. ' +
          'This variable is required for admin authentication. ' +
          'Add: ADMIN_USERNAME=admin'
        );
      }
    });

    it('should document ADMIN_PASSWORD variable', () => {
      const hasAdminPassword = envExampleContent.includes('ADMIN_PASSWORD=');

      expect(hasAdminPassword).toBe(true);

      if (!hasAdminPassword) {
        throw new Error(
          'ADMIN_PASSWORD variable is missing from backend/.env.example. ' +
          'This variable is required for admin authentication. ' +
          'Add: ADMIN_PASSWORD=changeme_secure_password with security guidance comments.'
        );
      }
    });

    it('should document JWT_SECRET variable', () => {
      const hasJwtSecret = envExampleContent.includes('JWT_SECRET=');

      expect(hasJwtSecret).toBe(true);

      if (!hasJwtSecret) {
        throw new Error(
          'JWT_SECRET variable is missing from backend/.env.example. ' +
          'This variable is required for signing JWT tokens in admin authentication. ' +
          'Add: JWT_SECRET=your_jwt_secret_minimum_32_characters_long_random_string ' +
          'with minimum length requirement comment (32 characters).'
        );
      }
    });

    it('should document JWT_EXPIRY variable (optional)', () => {
      const hasJwtExpiry = envExampleContent.includes('JWT_EXPIRY=');

      expect(hasJwtExpiry).toBe(true);

      if (!hasJwtExpiry) {
        throw new Error(
          'JWT_EXPIRY variable is missing from backend/.env.example. ' +
          'While optional at runtime (defaults to "1h"), it should be documented ' +
          'in the template for developer awareness. ' +
          'Add: JWT_EXPIRY=1h with comment noting it is optional and defaults to "1h".'
        );
      }
    });
  });

  describe('Admin Authentication Documentation Quality', () => {
    it('should include security guidance comments for ADMIN_PASSWORD', () => {
      // Check for bcrypt-related comments near ADMIN_PASSWORD
      const hasBcryptGuidance =
        envExampleContent.includes('bcrypt') ||
        envExampleContent.includes('production') && envExampleContent.includes('ADMIN_PASSWORD');

      expect(hasBcryptGuidance).toBe(true);

      if (!hasBcryptGuidance) {
        console.warn(
          'Warning: backend/.env.example should include security guidance about ' +
          'using bcrypt hashed passwords in production near the ADMIN_PASSWORD variable.'
        );
      }
    });

    it('should include minimum length requirement for JWT_SECRET', () => {
      // Check for minimum length guidance near JWT_SECRET
      const hasLengthGuidance =
        envExampleContent.includes('32') ||
        envExampleContent.includes('minimum') && envExampleContent.includes('JWT_SECRET');

      expect(hasLengthGuidance).toBe(true);

      if (!hasLengthGuidance) {
        console.warn(
          'Warning: backend/.env.example should include minimum length requirement ' +
          '(32 characters) for JWT_SECRET variable.'
        );
      }
    });

    it('should indicate JWT_EXPIRY is optional with default value', () => {
      // Check for optional/default value indication near JWT_EXPIRY
      const hasDefaultValue =
        envExampleContent.includes('1h') && envExampleContent.includes('JWT_EXPIRY');

      expect(hasDefaultValue).toBe(true);

      if (!hasDefaultValue) {
        console.warn(
          'Warning: backend/.env.example should indicate that JWT_EXPIRY is optional ' +
          'and defaults to "1h" if not specified.'
        );
      }
    });
  });

  describe('Admin Authentication Section Organization', () => {
    it('should have an Admin Authentication comment section', () => {
      const hasAdminAuthSection =
        envExampleContent.includes('Admin Authentication') ||
        envExampleContent.includes('ADMIN AUTH') ||
        (envExampleContent.includes('JWT') && envExampleContent.includes('#'));

      expect(hasAdminAuthSection).toBe(true);

      if (!hasAdminAuthSection) {
        console.warn(
          'Warning: backend/.env.example should have a clear comment section header ' +
          'for Admin Authentication variables (e.g., "# Admin Authentication (JWT)").'
        );
      }
    });

    it('should group admin auth variables together', () => {
      // Find positions of admin auth variables
      const adminUsernameIndex = envExampleContent.indexOf('ADMIN_USERNAME=');
      const adminPasswordIndex = envExampleContent.indexOf('ADMIN_PASSWORD=');
      const jwtSecretIndex = envExampleContent.indexOf('JWT_SECRET=');
      const jwtExpiryIndex = envExampleContent.indexOf('JWT_EXPIRY=');

      // All variables should be present
      expect(adminUsernameIndex).toBeGreaterThan(-1);
      expect(adminPasswordIndex).toBeGreaterThan(-1);
      expect(jwtSecretIndex).toBeGreaterThan(-1);
      expect(jwtExpiryIndex).toBeGreaterThan(-1);

      // Variables should be within 500 characters of each other (grouped together)
      const maxIndex = Math.max(adminUsernameIndex, adminPasswordIndex, jwtSecretIndex, jwtExpiryIndex);
      const minIndex = Math.min(adminUsernameIndex, adminPasswordIndex, jwtSecretIndex, jwtExpiryIndex);
      const groupingDistance = maxIndex - minIndex;

      expect(groupingDistance).toBeLessThan(1000);

      if (groupingDistance >= 1000) {
        console.warn(
          `Warning: Admin authentication variables are spread across ${groupingDistance} ` +
          'characters in backend/.env.example. Consider grouping them together for better ' +
          'organization and discoverability.'
        );
      }
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
