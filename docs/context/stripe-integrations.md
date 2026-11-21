# Stripe and external integrations

Authoritative detail: [docs/STRIPE.md](../STRIPE.md), [docs/BACKEND.md](../BACKEND.md), integrator guide [CLIENT_INTEGRATION.md](../../CLIENT_INTEGRATION.md), route reference [API_DOCS.md](../../API_DOCS.md).

## Stripe Connect
- Clients are Stripe Express accounts. Requested capabilities: `card_payments`, `transfers`, `us_bank_account_ach_payments`. ACH is tracked (`clients.ach_payments_status`) but nothing offers or gates on it yet.
- Onboarding: admin creates the client, the client gets an emailed link (24 h token) and a separate API-key link (15 min). Callback binds on `(client_id, state)`; Stripe does not append the account id. Code: `backend/src/routes/connect.ts`, `lib/stripe-connect-account.ts`, `lib/api-key-regeneration.ts`.
- Payments are Checkout Sessions only (direct charge on the connected account). `POST /payments/create` needs `lineItems` (inline `price_data`, no Stripe price ids) and an `Idempotency-Key` header. Code: `routes/payments.ts`, `lib/checkout-session.ts`. The old Elements/PaymentIntent mode and `USE_CHECKOUT` are gone.
- Guards return 409 `ACCOUNT_NOT_CONNECTED` or `CARD_PAYMENTS_NOT_ACTIVE`. Idempotency conflicts are 409 `IDEMPOTENCY_KEY_REUSED` (permanent, use a new key) or `IDEMPOTENCY_KEY_IN_USE` (transient, retry).
- Connected-account invoicing (`routes/connect-invoicing/`) is behind `CONNECT_INVOICING=true` plus a per-client `invoicingEnabled` opt-in.
- Webhooks: connected-account events (`webhooks` route) and a separate account-level billing endpoint (`routes/webhooks-billing.ts`, own secret). Events are deduped in `webhook_events` and pruned after a retention window (`lib/webhook-retention.ts`). Raw body is required for signature checks (`app.ts`).
- Stripe calls go through circuit breakers and a concurrency limiter (`lib/circuit-breakers.ts`, `lib/concurrency-limiter.ts`); open breaker means 503, busy means 429/503, not a generic 500.

## Nextcloud
The self-hosted Nextcloud (contacts, tables, collectives, identity) drives several optional automations: sales lead intake, client onboarding, billing requests, contact-to-Stripe sync, portal and billing mirrors, Stripe-id write-back. Each is off by default behind its own flag, has a `lib/*-sync.ts` reconciler plus `*-render.ts` pure mapping code, uses an advisory lock, and DB state wins. Rollout and disable steps: [docs/BACKEND.md](../BACKEND.md). Tests use fakes.

## Other
- SMTP mail (`lib/mailer.ts`); MailHog in dev.
- Optional Redis for rate limiting and breaker state.
- Metrics endpoint guarded by `METRICS_TOKEN` (`routes/metrics.ts`).
- Optional Plausible-compatible analytics in the frontend via `VITE_ANALYTICS_SRC`; never loaded on admin routes.
- The integrator guide is published to an external wiki by hand; updating `CLIENT_INTEGRATION.md` needs a manual copy there (CI does not do it).
