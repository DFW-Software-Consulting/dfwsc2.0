export const RATE_LIMIT_MAX = 120;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const MAX_FEE_PERCENT = 100;
export const MAX_COMPANY_NAME_LENGTH = 120;
export const REPORT_MAX_CONCURRENCY = 3;
export const MIN_JWT_SECRET_LENGTH = 32;
// Matches the onboarding link lifetime (ONBOARDING_TOKEN_TTL_MS in routes/connect.ts):
// clients often need longer than one short sitting for Stripe's identity form.
export const OAUTH_STATE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
export const STRICT_RATE_LIMIT_MAX = 10;
export const AUTH_RATE_LIMIT_MAX = 5;
// POST /auth/login is also limited per submitted username (case-insensitive), across all client
// IPs: Nextcloud throttles failed logins by source IP, which for these checks is always this API.
export const AUTH_USER_RATE_LIMIT_MAX = 10;
export const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const DEFAULT_DB_POOL_MAX = 10;

// POST /payments/create is limited per connected account (building) with a token bucket:
// a burst of up to CAPACITY checkouts is admitted at once, then REFILL_PER_MINUTE on average.
// Sized for rent day (many tenants clicking "Pay rent" together) while still stopping a
// runaway loop or a leaked key. Retune here; there are deliberately no environment variables.
// The bucket only admits the burst: Stripe calls still run MAX_CONCURRENT at a time (below), so
// when Stripe is slow the tail of a burst can wait out QUEUE_MAX_WAIT_MS and get STRIPE_BUSY.
export const PAYMENT_CREATE_BUCKET_CAPACITY = 200;
export const PAYMENT_CREATE_REFILL_PER_MINUTE = 120;

// Connected-account invoicing writes (customers, and later invoices) use a token bucket of the same
// shape as the payment bucket above, one per route and connected account (the limiter namespaces
// by route, so the routes do not share tokens). Reads use a 600/min sliding window.
export const INVOICE_WRITE_BUCKET_CAPACITY = 300;
export const INVOICE_WRITE_REFILL_PER_MINUTE = 120;
export const INVOICE_READ_RATE_LIMIT_MAX = 600;

// Connected-account invoice creation limits. The 2,500,000 cent ceiling (USD 25,000) applies to
// base + processing fee. The daily ceiling counts rows created in connect_invoices in a rolling
// 24 hours, whatever their state, and is the guard against a leaked key spamming a client's
// customers with invoices.
export const INVOICE_MAX_AMOUNT_CENTS = 2_500_000;
export const INVOICE_MAX_LINES = 50;
export const INVOICE_DAILY_CREATE_LIMIT = 1000;
// A create that is mid-flight holds a claim on its row for this long; after it, another request
// with the same Idempotency-Key takes over and resumes from the saved Stripe ids.
export const INVOICE_CLAIM_LEASE_MS = 60_000;
// Stripe forgets an idempotency key after 24 hours. Past this age (a margin under 24h) a resumed
// create no longer trusts the key and looks the objects up by metadata before creating them.
export const INVOICE_STRIPE_KEY_WINDOW_MS = 23 * 60 * 60 * 1000;
// The metadata search that adopts an invoice a resumed create may already have made (past Stripe's
// key window) reads at most this many pages of 100. If it still has more, the create is refused
// (503) rather than risk a duplicate.
export const INVOICE_ADOPTION_MAX_PAGES = 50;
// A non-terminal invoice not synced for this long is re-checked against Stripe on GET /invoices/:id.
export const INVOICE_RECONCILE_MIN_AGE_MS = 30_000;

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

// "DFWSC — New Lead" automation (lib/sales-lead-sync.ts).
export const SALES_LEAD_DEFAULT_POLL_INTERVAL_MS = 2 * 60 * 1000;
export const SALES_LEAD_MIN_POLL_INTERVAL_MS = 30 * 1000;
// Retryable failures back off from 1 minute, doubling, capped at 1 hour; after this
// many attempts the submission is marked failed and needs an operator.
export const SALES_LEAD_MAX_ATTEMPTS = 10;
export const SALES_LEAD_RETRY_BASE_MS = 60 * 1000;
export const SALES_LEAD_RETRY_MAX_MS = 60 * 60 * 1000;
// A claim older than this is treated as abandoned by a crashed process.
export const SALES_LEAD_CLAIM_LEASE_MS = 10 * 60 * 1000;
// Per cycle: submissions processed, and submission pages read while discovering.
export const SALES_LEAD_MAX_PER_CYCLE = 20;
export const SALES_LEAD_MAX_DISCOVERY_PAGES = 20;
// "Acme (2)" ... "Acme (50)": beyond this the folder step fails rather than guess.
export const SALES_LEAD_MAX_FOLDER_SUFFIX = 50;

// Global ceiling on website contacts turned into CRM leads (the email channel is not
// capped): bounds what a spam run can push into the sales pipeline.
export const WEBSITE_LEAD_CAP_MAX = 20;
export const WEBSITE_LEAD_CAP_WINDOW_MS = 60 * 60 * 1000;

// "Convert Won Lead to Client" onboarding (lib/client-onboarding-sync.ts). The webhook
// is the fast path; the poll is the safety net, so its default is slower than sales.
export const CLIENT_ONBOARDING_DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
export const CLIENT_ONBOARDING_MIN_POLL_INTERVAL_MS = 30 * 1000;
export const CLIENT_ONBOARDING_MAX_ATTEMPTS = 10;
export const CLIENT_ONBOARDING_RETRY_BASE_MS = 60 * 1000;
export const CLIENT_ONBOARDING_RETRY_MAX_MS = 60 * 60 * 1000;
export const CLIENT_ONBOARDING_CLAIM_LEASE_MS = 10 * 60 * 1000;
export const CLIENT_ONBOARDING_MAX_PER_CYCLE = 20;
export const CLIENT_ONBOARDING_MAX_DISCOVERY_PAGES = 20;

// Nextcloud contact card -> billing Stripe Customer sync (lib/contact-stripe-sync.ts).
export const CONTACT_STRIPE_SYNC_DEFAULT_INTERVAL_MS = 2 * 60 * 1000;
export const CONTACT_STRIPE_SYNC_MIN_INTERVAL_MS = 10 * 1000;
// The webhook secret is compared in constant time; short secrets are refused at startup.
export const CLIENT_ONBOARDING_MIN_WEBHOOK_SECRET_LENGTH = 32;
// Webhook calls per minute per IP (Nextcloud sends one per submission).
export const CLIENT_ONBOARDING_WEBHOOK_RATE_LIMIT_MAX = 60;

// "New invoice" form (lib/billing-request-sync.ts). The webhook is the fast path; the poll is the
// safety net. Retries back off like the onboarding's.
export const BILLING_REQUESTS_DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
export const BILLING_REQUESTS_MIN_POLL_INTERVAL_MS = 30 * 1000;
export const BILLING_REQUESTS_MAX_ATTEMPTS = 10;
export const BILLING_REQUESTS_RETRY_BASE_MS = 60 * 1000;
export const BILLING_REQUESTS_RETRY_MAX_MS = 60 * 60 * 1000;
export const BILLING_REQUESTS_CLAIM_LEASE_MS = 10 * 60 * 1000;
export const BILLING_REQUESTS_MAX_PER_CYCLE = 20;
export const BILLING_REQUESTS_MAX_DISCOVERY_PAGES = 20;
export const BILLING_REQUESTS_MIN_WEBHOOK_SECRET_LENGTH = 32;
export const BILLING_REQUESTS_WEBHOOK_RATE_LIMIT_MAX = 60;
// A submission older than this (by its Forms timestamp) is not billed unless an object of its own
// already exists in Stripe; then it is resumed whatever its age.
export const BILLING_REQUESTS_DEFAULT_MAX_AGE_HOURS = 72;
// Per invoice, or per payment of a recurring plan: $25,000.
export const BILLING_DEFAULT_MAX_AMOUNT_CENTS = 2_500_000;
export const BILLING_DEFAULT_DAYS_UNTIL_DUE = 7;
