import { TEST_JWT_SECRET, TEST_WEBHOOK_SECRET } from "./constants";

function setIfMissing(key: string, value: string): void {
  if (!process.env[key] || process.env[key]?.trim().length === 0) {
    process.env[key] = value;
  }
}

// For integration tests — idempotent, only sets if missing
export function ensureBaseEnv(): void {
  setIfMissing("STRIPE_SECRET_KEY", "sk_test_12345");
  setIfMissing("STRIPE_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
  setIfMissing("FRONTEND_ORIGIN", "http://localhost:5173");
  setIfMissing("USE_CHECKOUT", "false");
  setIfMissing("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/postgres");
  setIfMissing("SMTP_HOST", "mailhog");
  setIfMissing("SMTP_PORT", "1025");
  setIfMissing("SMTP_USER", "test");
  setIfMissing("SMTP_PASS", "test");
  setIfMissing("JWT_SECRET", TEST_JWT_SECRET);
  setIfMissing("NEXTCLOUD_BASE_URL", "https://cloud.example.com");
  setIfMissing("NEXTCLOUD_USERNAME", "test");
  setIfMissing("NEXTCLOUD_APP_PASSWORD", "test-password");
  setIfMissing("NEXTCLOUD_REGISTER_ID", "1");
  setIfMissing("NEXTCLOUD_CONTACT_SCHEMA_ID", "1");
  setIfMissing("NEXTCLOUD_LEDGER_SCHEMA_ID", "1");
}

// For unit tests (mocked DB) — forces all values
export function setTestEnv(): void {
  process.env.STRIPE_SECRET_KEY = "sk_test_12345";
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
  process.env.FRONTEND_ORIGIN = "http://localhost:5173";
  process.env.API_BASE_URL = "http://localhost:4242";
  process.env.USE_CHECKOUT = "false";
  process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:5432/postgres";
  process.env.SMTP_HOST = "mailhog";
  process.env.SMTP_PORT = "1025";
  process.env.SMTP_USER = "test";
  process.env.SMTP_PASS = "test";
  process.env.JWT_SECRET = TEST_JWT_SECRET;
}
