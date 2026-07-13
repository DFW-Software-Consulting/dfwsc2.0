# Stripe Connect & Payments

This document explains the Stripe integration, Connect onboarding, and payment processing logic.

## 1. Overview
The platform uses **Stripe Connect** with **Express Accounts**.
- **Platform Account**: DFWSC's main Stripe account.
- **Express Accounts**: One per connected client. Created during onboarding.

## 2. Onboarding Flow
1. **Initiate**: Admin calls `POST /api/v1/onboard-client/initiate` (or `POST /api/v1/accounts`). Creates a client record + `pending` onboarding token. `/accounts` returns the plaintext `apiKey` to the admin; `/onboard-client/initiate` does **not** — it delivers the API key via an emailed link instead.
2. **Email**: Client receives an email containing two links: `/onboard#token=...` (Stripe onboarding) and `/regenerate-key#token=...` (reveals the API key once, expires in 15 minutes).
3. **Account Link**: `POST /api/v1/onboard-client` with body `{ "token": "..." }` creates a Stripe Express Account (if not yet created) and returns an Account Link URL. Token moves to `in_progress`.
4. **Stripe Redirect**: Client completes onboarding on Stripe-hosted pages.
5. **Callback**: Stripe redirects to the platform-registered return URL, `GET /api/v1/connect/callback?client_id=...&state=...` — Stripe does **not** append `account`. `state` is CSRF-validated (32-byte, 30-min expiry) and is the actual security binding; the client's `stripeAccountId` is looked up from the DB (source of truth). An `account` query param is accepted only as an optional legacy/manual cross-check when present. Token is marked `completed`. Browser is redirected to `/onboarding-success`.
6. **Refresh**: If the account link expires before the client completes it, `GET /api/v1/connect/refresh?client_id=...&state=...` generates a new link and redirects.
7. **Resend**: `POST /api/v1/onboard-client/resend` revokes all active tokens for the client and issues a new one with a fresh email.

## 3. Payment Strategy (Stripe Checkout)
All payments go through **Stripe Checkout** — the former Stripe Elements / PaymentIntent mode and its `USE_CHECKOUT` toggle have been removed.

- Creates a **Checkout Session** with `lineItems` on behalf of the client's Express Account (direct charge).
- Returns a `url` for browser redirect to Stripe-hosted checkout.
- Success/cancel URLs resolve from: client config → group config → `FRONTEND_ORIGIN` default.
- `Idempotency-Key` header is required for API key calls.

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
- Deduplicates events using the `webhook_events` table (`stripeEventId` unique constraint).
- Handles subscription lifecycle and invoice status updates.

### Nextcloud ledger sync (optional)
When `NEXTCLOUD_URL`, `NEXTCLOUD_LEDGER_USER`, and `NEXTCLOUD_APP_PASSWORD` are all set,
invoice events on the **platform account** are mirrored into the Nextcloud bookkeeping
systems (`backend/src/lib/ledger-sync.ts`); connected-account events are skipped.

- `invoice.paid` → income entry (gross) + expense entry (exact Stripe fee from the
  charge's balance transaction) in the NextLedger fiscal year matching the payment
  date (auto-created on rollover), plus an upsert of the Pipelinq OpenRegister
  "Ledger Invoice" object keyed by `stripe_invoice_id`.
- `invoice.finalized` / `invoice.payment_failed` / `invoice.voided` /
  `invoice.marked_uncollectible` → register upsert only (no money moved).

Handlers are idempotent (safe under Stripe redelivery); a Nextcloud outage returns a
non-2xx so Stripe retries. Remember to subscribe the webhook endpoint to the invoice
events in the Stripe Dashboard.

## 6. Environment Variables
| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Stripe secret key (platform account) |
| `STRIPE_WEBHOOK_SECRET` | Webhook endpoint signing secret |
| `DEFAULT_PROCESS_FEE_CENTS` | (optional) Last-resort fallback fee (cents) when no client/group/DB default is configured |
| `NEXTCLOUD_URL` | (optional) Nextcloud base URL for ledger sync |
| `NEXTCLOUD_LEDGER_USER` | (optional) Nextcloud username for ledger sync |
| `NEXTCLOUD_APP_PASSWORD` | (optional) Nextcloud app password for ledger sync |
| `OPENREGISTER_REGISTER_ID` | (optional) OpenRegister register id (default `1`) |
| `OPENREGISTER_INVOICE_SCHEMA_ID` | (optional) OpenRegister Ledger Invoice schema id (default `9`) |
