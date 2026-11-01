import dotenv from "dotenv";
import type { FastifyInstance } from "fastify";
import { MIN_JWT_SECRET_LENGTH } from "./constants";

const REQUIRED_ENV_VARS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "FRONTEND_ORIGIN",
  "DATABASE_URL",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "JWT_SECRET",
];

const MASK_KEEP = 6;

const OPTIONAL_ENV_VARS = [
  "API_BASE_URL",
  "DEFAULT_PAYMENT_SUCCESS_URL",
  "DEFAULT_PAYMENT_CANCEL_URL",
  "DEFAULT_PROCESS_FEE_CENTS",
  "SMTP_FROM",
  "ADMIN_NEXTCLOUD_GROUPS",
  "REDIS_URL",
  "CONTACT_INBOX",
  "NEXTCLOUD_BASE_URL",
  "NEXTCLOUD_USERNAME",
  "NEXTCLOUD_APP_PASSWORD",
  "SALES_AUTOMATION_ENABLED",
  "SALES_LEAD_FORM_ID",
  "SALES_PIPELINE_TABLE_ID",
  "SALES_ADDRESSBOOK_PATH",
  "SALES_LEADS_FOLDER",
  "SALES_POLL_INTERVAL_MS",
  "CLIENT_ONBOARDING_ENABLED",
  "CLIENT_ONBOARDING_FORM_ID",
  "CLIENT_ONBOARDING_WEBHOOK_SECRET",
  "CLIENT_ONBOARDING_PROJECTS_TABLE_ID",
  "CLIENT_ONBOARDING_PIPELINE_TABLE_ID",
  "CLIENT_ONBOARDING_ADDRESSBOOK_PATH",
  "CLIENT_ONBOARDING_CLIENTS_FOLDER",
  "CLIENT_ONBOARDING_COLLECTIVE_ID",
  "CLIENT_ONBOARDING_POLL_INTERVAL_MS",
  "CLIENT_ONBOARDING_PROJECT_TEAMS",
  "CLIENT_ONBOARDING_TEAM_ADMINS",
  "CLIENT_ONBOARDING_BILLING_CUSTOMER",
  "CONTACT_STRIPE_SYNC",
  "CONTACT_STRIPE_SYNC_INTERVAL_MS",
  "PORTAL_MIRROR",
  "PORTAL_MIRROR_INTERVAL_MS",
  "PORTAL_MIRROR_BATCH",
  "PORTAL_MIRROR_SHARE_GROUPS",
  "PORTAL_MIRROR_INCLUDE_ARCHIVED",
  "PORTAL_ACCOUNTS_TABLE_ID",
  "BILLING_MIRROR",
  "BILLING_MIRROR_SHARE_GROUPS",
  "BILLING_SWEEP_INTERVAL_MS",
  "STRIPE_BILLING_WEBHOOK_SECRET",
  "BILLING_REQUESTS_ENABLED",
  "BILLING_REQUESTS_FORM_ID",
  "BILLING_REQUESTS_WEBHOOK_SECRET",
  "BILLING_REQUESTS_POLL_INTERVAL_MS",
  "BILLING_REQUESTS_ALLOWED_GROUPS",
  "BILLING_REQUESTS_SHARE_GROUPS",
  "BILLING_REQUESTS_MAX_AGE_HOURS",
  "BILLING_MAX_AMOUNT_CENTS",
  "BILLING_AUTO_SEND",
  "BILLING_DEFAULT_DAYS_UNTIL_DUE",
];

// Vars whose values must never appear in logs, even partially — presence only.
const FULLY_SECRET_ENV_VARS = new Set([
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "JWT_SECRET",
  "SMTP_PASS",
  "DATABASE_URL",
]);

function isFullySecretKey(key: string): boolean {
  return (
    FULLY_SECRET_ENV_VARS.has(key) ||
    key.endsWith("_SECRET") ||
    key.endsWith("_PASSWORD") ||
    key.endsWith("_KEY")
  );
}

export function validateEnv(): Record<string, string> {
  // Load dotenv only when validation is called
  if (process.env.NODE_ENV !== "production") {
    dotenv.config();
  }
  const env: Record<string, string> = {};
  const missing: string[] = [];

  for (const key of REQUIRED_ENV_VARS) {
    const value = process.env[key];
    if (!value) {
      missing.push(key);
    } else {
      env[key] = value;
    }
  }

  for (const key of OPTIONAL_ENV_VARS) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. Please update your environment before starting the server.`
    );
  }

  const jwtSecret = env.JWT_SECRET;
  if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters long`);
  }

  // Set default for optional env vars
  env.JWT_EXPIRY = process.env.JWT_EXPIRY ?? "1h";

  return env;
}

function maskValue(value: string): string {
  if (!value) {
    return "undefined";
  }
  if (value.length <= MASK_KEEP) {
    return "*".repeat(value.length);
  }
  const visible = value.slice(0, MASK_KEEP);
  return `${visible}${"*".repeat(Math.max(value.length - MASK_KEEP, 4))}`;
}

export function logMaskedEnvSummary(server: FastifyInstance, env: Record<string, string>): void {
  const summary = Object.fromEntries(
    Object.entries(env).map(([key, value]) => {
      if (isFullySecretKey(key)) {
        return [key, value ? "<redacted>" : "undefined"];
      }
      return [key, maskValue(value)];
    })
  );

  server.log.info({ env: summary }, "Environment configuration loaded (masked).");
}
