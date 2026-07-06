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
  "DEFAULT_PROCESS_FEE_CENTS",
  "SMTP_FROM",
  "ADMIN_API_KEY",
  "ALLOW_ADMIN_SETUP",
  "ADMIN_PASSWORD",
  "NEXTCLOUD_APP_PASSWORD",
  "REDIS_URL",
];

// Vars whose values must never appear in logs, even partially — presence only.
const FULLY_SECRET_ENV_VARS = new Set([
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "JWT_SECRET",
  "SMTP_PASS",
  "DATABASE_URL",
  "ADMIN_PASSWORD",
  "NEXTCLOUD_APP_PASSWORD",
]);

function isFullySecretKey(key: string): boolean {
  return (
    FULLY_SECRET_ENV_VARS.has(key) ||
    key.endsWith("_SECRET") ||
    key.endsWith("_PASSWORD") ||
    key.endsWith("_KEY")
  );
}

const WEAK_ADMIN_PASSWORDS = new Set(["testpassword", "password", "changeme"]);

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

  if (process.env.NODE_ENV === "production" && env.ADMIN_PASSWORD) {
    const adminPassword = env.ADMIN_PASSWORD;
    if (adminPassword.length < 12 || WEAK_ADMIN_PASSWORDS.has(adminPassword.toLowerCase())) {
      throw new Error(
        "ADMIN_PASSWORD is too weak for production. Use a value at least 12 characters long that is not a known default."
      );
    }
  }

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
