import { TEST_WEBHOOK_SECRET } from "./constants";

// For integration tests — idempotent, only sets if missing
export function ensureBaseEnv(): void {
  process.env.FRONTEND_ORIGIN ??= "http://localhost:5173";
  process.env.USE_CHECKOUT ??= "false";
  process.env.SMTP_HOST ??= "mailhog";
  process.env.SMTP_PORT ??= "1025";
  process.env.SMTP_USER ??= "test";
  process.env.SMTP_PASS ??= "test";
}

// For unit tests (mocked DB) — forces all values
export function setTestEnv(): void {
  process.env.STRIPE_SECRET_KEY = "sk_test_12345";
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
  process.env.FRONTEND_ORIGIN = "http://localhost:5173";
  process.env.API_BASE_URL = "http://localhost:4242";
  process.env.USE_CHECKOUT = "false";
  process.env.SMTP_HOST = "mailhog";
  process.env.SMTP_PORT = "1025";
  process.env.SMTP_USER = "test";
  process.env.SMTP_PASS = "test";
}
