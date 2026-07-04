# Stripe Connect & Payments

This document explains the Stripe integration, Connect onboarding, and payment processing logic.

## 1. Overview
The platform uses **Stripe Connect** with **Express Accounts**.
- **Platform Account**: DFWSC's main Stripe account.
- **Express Accounts**: One per connected client. Created during onboarding.

## 2. Onboarding Flow
1. **Initiate**: Admin calls `POST /api/v1/onboard-client/initiate` (or `POST /api/v1/accounts`). Creates a client record + `pending` onboarding token.
2. **Email**: Client receives a link to `/onboard?token=...`.
3. **Account Link**: `GET /api/v1/onboard-client?token=...` creates a Stripe Express Account (if not yet created) and returns an Account Link URL. Token moves to `in_progress`.
4. **Stripe Redirect**: Client completes onboarding on Stripe-hosted pages.
5. **Callback**: Stripe redirects to the platform-registered return URL, `GET /api/v1/connect/callback?client_id=...&state=...` — Stripe does **not** append `account`. `state` is CSRF-validated (32-byte, 30-min expiry) and is the actual security binding; the client's `stripeAccountId` is looked up from the DB (source of truth). An `account` query param is accepted only as an optional legacy/manual cross-check when present. Token is marked `completed`. Browser is redirected to `/onboarding-success`.
6. **Refresh**: If the account link expires before the client completes it, `GET /api/v1/connect/refresh?token=...` generates a new link and redirects.
7. **Resend**: `POST /api/v1/onboard-client/resend` revokes all active tokens for the client and issues a new one with a fresh email.

## 3. Payment Strategy (`USE_CHECKOUT`)
Controlled by the `USE_CHECKOUT` environment variable.

### Stripe Elements (`USE_CHECKOUT=false`)
- Creates a **PaymentIntent** on behalf of the client's Express Account.
- Returns `clientSecret`, `paymentIntentId`, and `stripeAccountId` for the frontend to render `@stripe/react-stripe-js` Elements.
- Integrators must initialize Stripe.js with `{ stripeAccount: stripeAccountId }` (direct-charge Elements requires the connected account context).
- Requires `amount` (cents) and `currency` in the request body.
- `Idempotency-Key` header is required for API key calls.

### Stripe Checkout (`USE_CHECKOUT=true`)
- Creates a **Checkout Session** with `lineItems`.
- Returns a `url` for browser redirect to Stripe-hosted checkout.
- Success/cancel URLs resolve from: client config → group config → `FRONTEND_ORIGIN` default.

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

## 6. Environment Variables
| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Stripe secret key (platform account) |
| `STRIPE_WEBHOOK_SECRET` | Webhook endpoint signing secret |
| `USE_CHECKOUT` | `"true"` for Checkout Sessions, `"false"` for PaymentIntents |
| `DEFAULT_PROCESS_FEE_CENTS` | (optional) Last-resort fallback fee (cents) when no client/group/DB default is configured |
