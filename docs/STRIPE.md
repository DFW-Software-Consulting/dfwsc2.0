# Stripe Connect & Payments

This document explains the Stripe integration, Connect onboarding, and payment processing logic.

## 1. Overview
The platform uses **Stripe Connect** with **Express Accounts**.
- **Platform Account**: DFWSC's main Stripe account.
- **Express Accounts**: One per connected client. Created when the client is created (`/accounts` or `/onboard-client/initiate`).

## 2. Onboarding Flow
1. **Initiate**: Admin calls `POST /api/v1/onboard-client/initiate` (or `POST /api/v1/accounts`). The API prepares a stable client ID and credentials, creates the Stripe Express account with that client ID as metadata and the Stripe idempotency key, then atomically stores the client, Stripe account/readiness state, and tokens. No database transaction is held open during the Stripe call. `/accounts` returns the plaintext `apiKey` to the admin; `/onboard-client/initiate` does **not** — it delivers the API key via an emailed link instead.
2. **Email**: Client receives an email containing two links: `/onboard#token=...` (Stripe onboarding) and `/regenerate-key#token=...` (reveals the API key once, expires in 15 minutes).
3. **Account Link**: `POST /api/v1/onboard-client` with body `{ "token": "..." }` uses the persisted Stripe account and returns an Account Link URL. A race-safe, idempotent lazy account-creation fallback remains for legacy clients whose `stripeAccountId` is null; the API does not create an Account Link until an account ID is confirmed in Postgres. Token moves to `in_progress`.
4. **Stripe Redirect**: Client completes onboarding on Stripe-hosted pages.
5. **Callback**: Stripe redirects to the platform-registered return URL, `GET /api/v1/connect/callback?client_id=...&state=...` — Stripe does **not** append `account`. `state` is CSRF-validated (32-byte, 24-hour expiry) and is the actual security binding; the client's `stripeAccountId` is looked up from the DB (source of truth). An `account` query param is accepted only as an optional legacy/manual cross-check when present. Token is marked `completed`. Browser is redirected to `/onboarding-success`. An expired state redirects to `/onboarding-success?status=expired` instead of returning an error.
6. **Refresh**: If the account link expires before the client completes it, `GET /api/v1/connect/refresh?client_id=...&state=...` generates a new link and redirects.
7. **Resend**: `POST /api/v1/onboard-client/resend` revokes all active tokens for the client and issues a new one (in one transaction) with a fresh email.

**Failure and recovery behavior.** A Stripe account-creation failure does not commit the client or expose credentials. If Stripe returned an account but the database write fails, the API attempts to delete that account; a failed deletion is logged with the client and Stripe account IDs for reconciliation. If the initiate email fails after persistence, the client and Stripe account remain, but exactly the new onboarding and API-key retrieval tokens are revoked; the admin receives `502 EMAIL_DELIVERY_FAILED` and recovers with the authenticated resend route (onboarding link) and admin API-key regeneration (API key) rather than retrying initiate. Resend returns 200 only after email delivery succeeds; a failed send revokes its newly issued token and returns the same 502 class. A token-cleanup failure returns a support-oriented error because an undelivered credential may still be active.

## 3. Payment Strategy (Stripe Checkout)
All payments go through **Stripe Checkout** — the former Stripe Elements / PaymentIntent mode and its `USE_CHECKOUT` toggle have been removed.

- Creates a **Checkout Session** with `lineItems` on behalf of the client's Express Account (direct charge).
- Returns a `url` for browser redirect to Stripe-hosted checkout.
- Line items must use inline `price_data` (no platform price IDs — those are incompatible with connected-account Checkout).
- The base amount is derived server-side from line items; a caller-supplied `amount` is ignored.
- All line items must use the same 3-letter ISO currency.
- `Idempotency-Key` header is required for all payment creation calls (both API-key and admin).
- Idempotency conflicts return 409 with one of two codes. `IDEMPOTENCY_KEY_REUSED` means the key was already used with different parameters; it is permanent, so send a new key. `IDEMPOTENCY_KEY_IN_USE` means a request with the same key is still in progress; it is transient, so retry shortly with the same key. Neither counts toward the Stripe circuit breaker.
- Other permanent Stripe errors on `POST /payments/create` are returned as 4xx instead of a retryable 502: `400 INVALID_REQUEST` (Stripe rejected a parameter; `param` names it when known) and `409 ACCOUNT_NOT_CONNECTED` (the client's Stripe account is not connected or cannot accept charges; retrying will not help). After a `400 INVALID_REQUEST`, send the corrected request with a new `Idempotency-Key`: Stripe keeps the first response for a key for 24 hours, errors included, so the old key can replay the stored error or come back as `IDEMPOTENCY_KEY_REUSED` once the body changes. These 4xx responses do not count toward the Stripe circuit breaker.
- Success/cancel URLs resolve from: client config → group config → `DEFAULT_PAYMENT_SUCCESS_URL`/`DEFAULT_PAYMENT_CANCEL_URL` if valid HTTP(S) URLs → `FRONTEND_ORIGIN` default.
- Every success URL (client, group, default or built-in fallback) carries `session_id={CHECKOUT_SESSION_ID}`: it is appended (`?` or `&`, before any `#fragment`) unless the URL already contains the literal `{CHECKOUT_SESSION_ID}` placeholder. Stripe substitutes the placeholder when it redirects the customer back. The cancel URL is unchanged.
- The 201 response is `{ url, sessionId }`. Integrators store `sessionId` against their order and confirm the result via `GET /api/v1/payments/session/:sessionId` (see below).

### Payment Ledger
Every payment creation inserts a row into the `payment_ledger` table synchronously after Stripe Checkout Session creation. The ledger tracks:
- Connected account, Stripe session ID, client, source
- Status (created → paid/expired/failed/canceled/refunded/disputed)
- Base/total/fee amounts, currency, metadata
- `last_stripe_event_created_at` for ordering protection (stale events are ignored)

`GET /api/v1/payments/session/:sessionId` returns payer-safe fields from the ledger (`status`, `baseAmountCents`, `totalAmountCents`, `feeAmountCents`, `currency`, `createdAt`; no internal IDs or metadata leaked). It is public and rate-limited to 30 requests/minute per IP. Sending the client's `X-Api-Key` authenticates the call instead: the limit becomes 600 requests/minute per client, only that client's sessions are visible (another client's session is a `404`, like an unknown one), and an invalid or inactive key is a `401`. Rejected keys are counted per client IP, once for each distinct key (30 distinct keys a minute): the same bad key repeated uses one unit. Over that budget a request with a key gets a `429` before any database lookup, except for a key that passed verification within the last minute. A rejected key keeps getting `401` for up to a minute without a lookup, so a client that was reactivated works again within a minute (at once when an admin changes its status). Integrators should fulfil only on `paid` and compare `baseAmountCents`/`currency` to their order; the public guide is the `/docs` page (Step 3).

**Stripe fallback for missed webhooks.** If the row is still `created` and older than 30 seconds, the endpoint retrieves the Checkout Session from Stripe on the row's connected account (skipped while the Stripe circuit breaker is open, but its own failures are not counted towards the breaker) and applies the same transition the webhook would: a `complete` session that is `paid` or `no_payment_required` becomes `paid`, an `expired` session becomes `expired`, and an open or unsettled session leaves the row `created`. Stripe is asked at most once per session per 30 seconds per API process. A Stripe failure or open breaker never fails the request; the stored row is returned. Reconciliation does not advance `last_stripe_event_created_at` beyond the newest event already recorded, so later webhooks still apply. The fallback cannot recover a failed delayed payment: that still needs the `checkout.session.async_payment_failed` webhook.

## 4. Fee Resolution
`application_fee_amount` is collected on every transaction via a 6-level priority chain (first non-null wins):
1. Client `processingFeePercent`
2. Client `processingFeeCents`
3. Group `processingFeePercent`
4. Group `processingFeeCents`
5. DB setting `default_fee_percent`
6. DB setting `default_fee_cents`

If none of the six levels are configured, the flat `DEFAULT_PROCESS_FEE_CENTS` environment variable is used as a last-resort fallback; if that is also unset, no fee is applied.

Pass `waiveFee: true` in the payment request body to skip the platform fee for a specific transaction. This is honored **only** for admin (JWT) payments — for API-key (client-initiated) payments, `waiveFee` is ignored and the fee is always applied.

## 5. Webhook Handling
`POST /api/v1/webhooks/stripe`
- Validates Stripe signature via `STRIPE_WEBHOOK_SECRET`.
- Deduplicates events using the `webhook_events` table (`stripeEventId` unique constraint) with a reclaimable lease mechanism.
- **Required endpoint and events**: payments are direct charges on connected accounts, so Stripe delivers these events only to a webhook endpoint registered with "Listen to events on Connected accounts" (a Connect endpoint). It must be subscribed to `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded`, `charge.dispute.created` and `account.updated`, and `STRIPE_WEBHOOK_SECRET` must be that endpoint's signing secret. Without it rows stay `created` (the status endpoint's Stripe fallback only covers completed and expired sessions).
- `checkout.session.completed` marks the row `paid` only when `payment_status` is `paid` or `no_payment_required`. For delayed-notification methods (e.g. bank debits) it arrives `unpaid`: the row stays `created` (the PaymentIntent id is still recorded) and `async_payment_succeeded` / `async_payment_failed` move it to `paid` / `failed`.
- Updates the `payment_ledger` table for: `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded/failed`, `payment_intent.succeeded/failed/canceled`, `charge.refunded`, `charge.dispute.created`.
- **account.updated ordering protection**: Retrieves current account state from Stripe rather than trusting the event payload, handling out-of-order delivery.
- Ledger updates use `last_stripe_event_created_at` to ignore stale events.

The Connect endpoint has no subscription or invoice handling beyond logging: it never calls `subscriptions.*` or `subscriptionSchedules.*`, and it no longer writes `paymentsMade` metadata (removed with the dead subscription scaffolding).

### Billing endpoint (DFWSC's own clients, account level)
`POST /api/v1/webhooks/stripe-billing` (production: `https://api.dfwsc.com/api/v1/webhooks/stripe-billing`)

DFWSC bills its own clients through Stripe Customers on the **platform account** (`billing_customers`; docs/BACKEND.md sections 10 and 13). That is a different Stripe scope from Connect. A Connect endpoint ("Listen to events on Connected accounts") never receives events of the platform account, and `STRIPE_WEBHOOK_SECRET` is the signing secret of that Connect endpoint, so billing events need a **second, account-level endpoint with its own secret**, `STRIPE_BILLING_WEBHOOK_SECRET`.

- Add it in the Stripe dashboard (Developers > Webhooks > Add endpoint) with "Listen to events on **Your account**", the URL above, and exactly these events: `invoice.created`, `invoice.finalized`, `invoice.updated`, `invoice.paid`, `invoice.payment_failed`, `invoice.voided`, `invoice.marked_uncollectible`, `invoice.overdue`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `subscription_schedule.created`, `subscription_schedule.updated`, `subscription_schedule.canceled`, `subscription_schedule.completed`, `subscription_schedule.released`, `subscription_schedule.aborted`, `invoice.deleted`, `customer.deleted`. Put its signing secret in `STRIPE_BILLING_WEBHOOK_SECRET`.
- Unset secret: the route answers 404. The Client Billing mirror still works: the sweep re-reads every Customer at boot and every `BILLING_SWEEP_INTERVAL_MS` (default 1 hour).
- **Hard guard**: an event with `account` set (a connected account) answers 200 and is ignored before anything is claimed or looked up.
- Same `webhook_events` lease and dedupe as the Connect endpoint. The Customer is resolved through `billing_customers`; an unknown Customer is ignored; a known one only gets `billing_snapshots.dirty_at = now()`. The event payload is never used for data: the refresh re-reads `subscriptions.list` (`status: all`, `expand: data.schedule`), `subscriptionSchedules.list` (`scheduled: true`) and `invoices.list` for the Customer. These are the only Stripe calls of the billing mirror and all are reads; a test asserts that no Stripe write method is ever called.

## 6. Products
Products and prices are created on the **connected account** (not the platform account) by passing `stripeAccount` to Stripe API calls. Both `GET /products` and `POST /products` require a `clientId` parameter to resolve the connected account.

## 7. Environment Variables
| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Stripe secret key (platform account) |
| `STRIPE_WEBHOOK_SECRET` | Webhook endpoint signing secret (the Connect endpoint) |
| `STRIPE_BILLING_WEBHOOK_SECRET` | (optional) Signing secret of the account-level billing endpoint; unset = `/webhooks/stripe-billing` answers 404 |
| `DEFAULT_PROCESS_FEE_CENTS` | (optional) Last-resort fallback fee (cents) when no client/group/DB default is configured |
| `DEFAULT_PAYMENT_SUCCESS_URL` | (optional) Default Checkout success redirect URL used after client/group config |
| `DEFAULT_PAYMENT_CANCEL_URL` | (optional) Default Checkout cancel redirect URL used after client/group config |
