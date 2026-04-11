# Stripe Connect & Payments

This document explains the Stripe integration, Connect onboarding, and payment processing logic.

## 1. Overview
The platform uses **Stripe Connect** with **Express Accounts**.
- **Platform Account**: DFWSC's main account.
- **Express Accounts**: Connected accounts for each client/consultant.

## 2. Onboarding Flow
The platform facilitates a self-service onboarding flow:
1. **Initiate**: Admin generates an onboarding token (`onboarding_tokens` table).
2. **Email**: Client receives an email with a unique link (`/onboard?token=...`).
3. **Stripe Redirect**: Client is directed to Stripe to create an Express Account.
4. **Callback**: Stripe redirects back to the platform (`/api/v1/connect/callback`).
5. **Success**: `stripeAccountId` is permanently linked to the client record.

## 3. Payments Strategy (`USE_CHECKOUT`)
Controlled via the `USE_CHECKOUT` environment variable.

### Stripe Checkout (`USE_CHECKOUT=true`)
- Platform creates a **Checkout Session**.
- Client is redirected to a Stripe-hosted payment page.
- Best for simple, one-off payments and minimal frontend code.

### Stripe Elements (`USE_CHECKOUT=false`)
- Platform creates a **PaymentIntent**.
- Frontend uses `react-stripe-js` to render PCI-compliant elements.
- Best for high-customization and seamless UX.

## 4. Webhook Handling
The platform listens for `POST /api/v1/webhooks/stripe`.
- **Security**: Validates Stripe signatures via `STRIPE_WEBHOOK_SECRET`.
- **Idempotency**: Uses the `webhook_events` table to de-duplicate notifications.
- **Actions**: Updates invoice statuses, marks payments as `paid`, and handles subscription lifecycle.

## 5. Fee Resolution
The platform collects an `application_fee_amount` on every transaction based on a 5-level priority chain defined in `BACKEND.md`.
