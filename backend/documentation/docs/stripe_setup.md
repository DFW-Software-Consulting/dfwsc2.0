# Stripe Setup Guide

Configure your Stripe account and developer tooling so the portal can create connected accounts, accept payments, and process webhooks.

## Prerequisites
- Stripe account with **Connect (Express)** enabled.
- Stripe CLI installed locally (`npm install -g stripe` or via package manager).

## Steps
1. **Create API keys**
   - Navigate to Stripe Dashboard → Developers → API keys.
   - Copy the **Secret key** (test mode for development) into `STRIPE_SECRET_KEY`.
2. **Enable Connect**
   - Under Connect settings, ensure **Express** accounts are enabled.
   - Configure the platform name and support email shown during onboarding.
   - Enable required capabilities for connected accounts (e.g., card payments, transfers).
3. **Webhook secret**
   - Use Stripe CLI: `stripe listen --forward-to localhost:4242/webhooks/stripe`.
   - Copy the printed `whsec_...` into `STRIPE_WEBHOOK_SECRET`.
4. **Test data mode**
   - Keep the dashboard in Test mode while validating flows; the API automatically uses test data when the secret key begins with `sk_test_`.
5. **Client onboarding settings**
   - Optional: configure email templates or verification options in Stripe → Connect → Settings to match your brand.
6. **Checkout settings (if `USE_CHECKOUT=true`)**
   - Enable the relevant payment methods in Stripe Dashboard → Settings → Payment methods.
   - Configure success/cancel URLs to match `FRONTEND_ORIGIN` if you later use hosted Checkout links directly.

## Sandbox Testing Checklist
- Create a new connected account via the admin flow and complete onboarding using Stripe’s test identity data.
- Generate a PaymentIntent (`USE_CHECKOUT=false`) and confirm it appears under the connected account in the dashboard.
- Trigger payouts or refund events using `stripe trigger` commands to verify webhook handling.

## Production Cutover
- Rotate `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` to live values.
- Update `.env` and redeploy.
- Recreate webhook endpoints (or update existing ones) in the Stripe Dashboard pointing to your production URL.
- Disable test helper pages if they are not meant for public access.
