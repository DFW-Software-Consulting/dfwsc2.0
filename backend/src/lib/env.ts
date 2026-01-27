import dotenv from 'dotenv';
import { FastifyInstance } from 'fastify';

const REQUIRED_ENV_VARS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'FRONTEND_ORIGIN',
  'USE_CHECKOUT',
  'DATABASE_URL',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'JWT_SECRET',
];

// These vars are required UNLESS ALLOW_ADMIN_SETUP=true (for initial setup flow)
const CONDITIONALLY_REQUIRED_VARS = [
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
];

const MASK_KEEP = 6;

const OPTIONAL_ENV_VARS = ['API_BASE_URL', 'DEFAULT_PROCESS_FEE_CENTS', 'SMTP_FROM', 'ADMIN_API_KEY', 'ALLOW_ADMIN_SETUP', 'ADMIN_SETUP_TOKEN'];

export function validateEnv(): Record<string, string> {
  // Load dotenv only when validation is called
  if (process.env.NODE_ENV !== 'production') {
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

  // Check conditionally required vars (required unless setup is allowed AND no admin creds exist)
  const allowAdminSetup = process.env.ALLOW_ADMIN_SETUP === 'true';
  const adminUsername = process.env.ADMIN_USERNAME;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const mustRequireAdminCreds = !allowAdminSetup || !!adminUsername || !!adminPassword;
  for (const key of CONDITIONALLY_REQUIRED_VARS) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    } else if (mustRequireAdminCreds) {
      // Require both creds when setup is off or either cred is present
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. Please update your environment before starting the server.`,
    );
  }

  const useCheckout = env['USE_CHECKOUT'];
  if (useCheckout && !['true', 'false'].includes(useCheckout.toLowerCase())) {
    throw new Error('USE_CHECKOUT must be either "true" or "false".');
  }

  // Set default for optional env vars
  env['JWT_EXPIRY'] = process.env['JWT_EXPIRY'] ?? '1h';

  return env;
}

function maskValue(value: string): string {
  if (!value) {
    return 'undefined';
  }
  if (value.length <= MASK_KEEP) {
    return '*'.repeat(value.length);
  }
  const visible = value.slice(0, MASK_KEEP);
  return `${visible}${'*'.repeat(Math.max(value.length - MASK_KEEP, 4))}`;
}

export function logMaskedEnvSummary(server: FastifyInstance, env: Record<string, string>): void {
  const summary = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, maskValue(value)]),
  );

  server.log.info({ env: summary }, 'Environment configuration loaded (masked).');
}
