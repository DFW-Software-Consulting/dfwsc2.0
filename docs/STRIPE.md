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
- Line items must use inline `price_data` (no platform price IDs — those are incompatible with connected-account Checkout).
- The base amount is derived server-side from line items; a caller-supplied `amount` is ignored.
- All line items must use the same 3-letter ISO currency.
- `Idempotency-Key` header is required for all payment creation calls (both API-key and admin).
- Success/cancel URLs resolve from: client config → group config → `DEFAULT_PAYMENT_SUCCESS_URL`/`DEFAULT_PAYMENT_CANCEL_URL` if valid HTTP(S) URLs → `FRONTEND_ORIGIN` default.
- The built-in success fallback always includes `session_id={CHECKOUT_SESSION_ID}`. A default success URL also gets that placeholder appended unless it already has a `session_id` query parameter.

### Payment Ledger
Every payment creation inserts a row into the `payment_ledger` table synchronously after Stripe Checkout Session creation. The ledger tracks:
- Connected account, Stripe session ID, client, source
- Status (created → paid/expired/failed/canceled/refunded/disputed)
- Base/total/fee amounts, currency, metadata
- `last_stripe_event_created_at` for ordering protection (stale events are ignored)

`GET /api/v1/payments/session/:sessionId` returns payer-safe fields from the ledger (no internal IDs or metadata leaked).

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
- Updates the `payment_ledger` table for: `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded/failed`, `payment_intent.succeeded/failed/canceled`, `charge.refunded`, `charge.dispute.created`.
- **account.updated ordering protection**: Retrieves current account state from Stripe rather than trusting the event payload, handling out-of-order delivery.
- Ledger updates use `last_stripe_event_created_at` to ignore stale events.

## 6. Products
Products and prices are created on the **connected account** (not the platform account) by passing `stripeAccount` to Stripe API calls. Both `GET /products` and `POST /products` require a `clientId` parameter to resolve the connected account.

## 7. Environment Variables
| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Stripe secret key (platform account) |
| `STRIPE_WEBHOOK_SECRET` | Webhook endpoint signing secret |
| `DEFAULT_PROCESS_FEE_CENTS` | (optional) Last-resort fallback fee (cents) when no client/group/DB default is configured |
| `DEFAULT_PAYMENT_SUCCESS_URL` | (optional) Default Checkout success redirect URL used after client/group config |
| `DEFAULT_PAYMENT_CANCEL_URL` | (optional) Default Checkout cancel redirect URL used after client/group config |
