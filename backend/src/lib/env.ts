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
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
  'JWT_SECRET',
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
