export const RATE_LIMIT_MAX = 120;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const MAX_FEE_PERCENT = 100;
export const MAX_COMPANY_NAME_LENGTH = 120;
export const REPORT_MAX_CONCURRENCY = 3;
export const BCRYPT_SALT_ROUNDS = 10;
export const MIN_JWT_SECRET_LENGTH = 32;
// Matches the onboarding link lifetime (ONBOARDING_TOKEN_TTL_MS in routes/connect.ts):
// clients often need longer than one short sitting for Stripe's identity form.
export const OAUTH_STATE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
export const STRICT_RATE_LIMIT_MAX = 10;
export const AUTH_RATE_LIMIT_MAX = 5;
export const DEFAULT_DB_POOL_MAX = 10;

// POST /payments/create is limited per connected account (building) with a token bucket:
// a burst of up to CAPACITY checkouts is admitted at once, then REFILL_PER_MINUTE on average.
// Sized for rent day (many tenants clicking "Pay rent" together) while still stopping a
// runaway loop or a leaked key. Retune here; there are deliberately no environment variables.
export const PAYMENT_CREATE_BUCKET_CAPACITY = 200;
export const PAYMENT_CREATE_REFILL_PER_MINUTE = 120;

// webhook_events retention: how long to keep processed rows before pruning,
// and how often the prune sweep runs.
export const WEBHOOK_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const WEBHOOK_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// SMTP transport timeouts (ms) so a black-holed connection can't hang a request.
export const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
export const SMTP_GREETING_TIMEOUT_MS = 10_000;
export const SMTP_SOCKET_TIMEOUT_MS = 10_000;
