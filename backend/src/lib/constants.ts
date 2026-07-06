export const RATE_LIMIT_MAX = 120;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const MAX_FEE_PERCENT = 100;
export const MAX_COMPANY_NAME_LENGTH = 120;
export const REPORT_MAX_CONCURRENCY = 3;
export const BCRYPT_SALT_ROUNDS = 10;
export const MIN_JWT_SECRET_LENGTH = 32;
export const OAUTH_STATE_EXPIRY_MS = 1_800_000;
export const STRICT_RATE_LIMIT_MAX = 10;
export const AUTH_RATE_LIMIT_MAX = 5;
export const DEFAULT_DB_POOL_MAX = 10;

// webhook_events retention: how long to keep processed rows before pruning,
// and how often the prune sweep runs.
export const WEBHOOK_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const WEBHOOK_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// SMTP transport timeouts (ms) so a black-holed connection can't hang a request.
export const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
export const SMTP_GREETING_TIMEOUT_MS = 10_000;
export const SMTP_SOCKET_TIMEOUT_MS = 10_000;
