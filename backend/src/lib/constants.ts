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
// The bucket only admits the burst: Stripe calls still run MAX_CONCURRENT at a time (below), so
// when Stripe is slow the tail of a burst can wait out QUEUE_MAX_WAIT_MS and get STRIPE_BUSY.
export const PAYMENT_CREATE_BUCKET_CAPACITY = 200;
export const PAYMENT_CREATE_REFILL_PER_MINUTE = 120;

// Stripe calls made through withStripeCircuit share one in-process concurrency limit so a burst
// queues for a slot instead of fanning out to Stripe all at once. Calls beyond MAX_CONCURRENT
// wait FIFO; one that waits longer than QUEUE_MAX_WAIT_MS, or arrives with QUEUE_MAX_WAITING
// already waiting, fails with a retryable STRIPE_BUSY (503, Retry-After BUSY_RETRY_AFTER_SECONDS).
export const STRIPE_MAX_CONCURRENT_CALLS = 25;
export const STRIPE_QUEUE_MAX_WAITING = 500;
export const STRIPE_QUEUE_MAX_WAIT_MS = 10_000;
export const STRIPE_BUSY_RETRY_AFTER_SECONDS = 5;
// Stripe's own 429 carries no Retry-After; this is what we tell the caller instead.
export const STRIPE_RATE_LIMITED_RETRY_AFTER_SECONDS = 2;

// GET /payments/session/:sessionId is public (the payment-success page polls it), limited per
// client IP. A caller that sends its X-Api-Key instead gets a separate, higher limit per client,
// so an integrator confirming many payments from one server is not throttled by the shared IP limit.
export const SESSION_STATUS_ANONYMOUS_RATE_LIMIT_MAX = 30;
export const SESSION_STATUS_API_KEY_RATE_LIMIT_MAX = 600;
// Failed X-Api-Key authentications per client IP per minute on that endpoint. Successful ones
// are not counted. Over this, a request with an unrecognised key is refused before any database
// lookup, so junk keys cannot be used to drive lookups.
export const SESSION_STATUS_FAILED_AUTH_RATE_LIMIT_MAX = 30;

// webhook_events retention: how long to keep processed rows before pruning,
// and how often the prune sweep runs.
export const WEBHOOK_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const WEBHOOK_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// SMTP transport timeouts (ms) so a black-holed connection can't hang a request.
export const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
export const SMTP_GREETING_TIMEOUT_MS = 10_000;
export const SMTP_SOCKET_TIMEOUT_MS = 10_000;
