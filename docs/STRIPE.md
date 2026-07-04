# Stripe Connect & Payments

This document explains the Stripe integration, Connect onboarding, and payment processing logic.

## 1. Overview
The platform uses **Stripe Connect** with **Express Accounts**.
- **Platform Account**: DFWSC's main Stripe account.
- **Express Accounts**: One per connected client. Created during onboarding.

## 2. Onboarding Flow
1. **Initiate**: Admin calls `POST /api/v1/onboard-client/initiate` (or `POST /api/v1/accounts`). Creates a client record + `pending` onboarding token.
2. **Email**: Client receives a link to `/onboard?token=...` (sent by `/onboard-client/initiate`; `POST /api/v1/accounts` does not send email — it returns an `onboardingUrlHint` for the admin to deliver).
3. **Account Link**: `GET /api/v1/onboard-client?token=...` creates a Stripe Express Account (if not yet created) and returns an Account Link URL. Token moves to `in_progress`.
4. **Stripe Redirect**: Client completes onboarding on Stripe-hosted pages.
5. **Callback**: Stripe redirects to `GET /api/v1/connect/callback?client_id=...&state=...` (an optional `account` param is validated if present). State is CSRF-validated (32-byte, 30-min expiry, single-use). The account is verified with Stripe; `stripeAccountId` and readiness flags are written to the client record, and the token is marked `completed` when `details_submitted` is true (otherwise it stays `in_progress`). Browser is redirected to `/onboarding-success?status=...`.
6. **Refresh**: If the account link expires before the client completes it, `GET /api/v1/connect/refresh?token=...` generates a new link and redirects.
7. **Resend**: `POST /api/v1/onboard-client/resend` revokes all active tokens for the client and issues a new one with a fresh email.

## 3. Payment Strategy (`USE_CHECKOUT`)
Controlled by the `USE_CHECKOUT` environment variable.

### Stripe Elements (`USE_CHECKOUT=false`)
- Creates a **PaymentIntent** on behalf of the client's Express Account.
- Returns `clientSecret` for the caller's own site to render Stripe Elements (see the client integration docs). This repo's frontend does not render a payment form.
- Requires `amount` (cents) and `currency` in the request body.
- `Idempotency-Key` header is required for API key calls.

### Stripe Checkout (`USE_CHECKOUT=true`)
- Creates a **Checkout Session** with `lineItems`.
- Returns a `url` for browser redirect to Stripe-hosted checkout.
- Success/cancel URLs resolve from: client config → group config → `FRONTEND_ORIGIN` default.

## 4. Fee Resolution
`application_fee_amount` is collected on every transaction via a 4-level priority chain (first non-null wins), with DB-default and env fallbacks below it:
1. Client `processingFeePercent`
2. Client `processingFeeCents`
3. Group `processingFeePercent`
4. Group `processingFeeCents`

Admin-JWT requests may pass `waiveFee: true` in the payment request body to skip the platform fee for a specific transaction. The flag is ignored (forced to `false`) on API-key requests.

If none of the four levels are configured, the fee falls back to the DB settings `default_fee_percent` / `default_fee_cents`, then to the `DEFAULT_PROCESS_FEE_CENTS` env var; if all are unset the fee is 0.

## 5. Webhook Handling
`POST /api/v1/webhooks/stripe`
- Validates Stripe signature via `STRIPE_WEBHOOK_SECRET`.
- Deduplicates events using the `webhook_events` table (`stripeEventId` unique constraint).
- Handles subscription lifecycle and invoice status updates.

## 6. Environment Variables
| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Stripe secret key (platform account) |
| `STRIPE_WEBHOOK_SECRET` | Webhook endpoint signing secret |
| `USE_CHECKOUT` | `"true"` for Checkout Sessions, `"false"` for PaymentIntents |
| `DEFAULT_PROCESS_FEE_CENTS` | (optional) Last-resort fallback fee (cents) when no client/group/DB default is configured |
