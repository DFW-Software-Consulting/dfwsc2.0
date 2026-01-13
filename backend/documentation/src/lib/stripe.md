# src/lib/stripe.ts

## Purpose
Creates a pre-configured Stripe SDK client that the rest of the application uses for Connect onboarding, payment creation, Checkout Sessions, and webhook verification.

## Dependencies
- `STRIPE_SECRET_KEY` — **required**. Throws during module load if missing.
- `dotenv/config` — automatically loads variables from `.env` when the module is imported.

## Key Exports
- `stripe` — an instance of `new Stripe(STRIPE_SECRET_KEY, { typescript: true })`.

## Example Usage
```ts
import { stripe } from '../lib/stripe';

// Create a PaymentIntent for a connected account
await stripe.paymentIntents.create(
  {
    amount: 5000,
    currency: 'usd',
    automatic_payment_methods: { enabled: true },
  },
  { stripeAccount: 'acct_1234' }
);
```

## Testing & Debugging Notes
- When writing unit tests, mock this module (e.g., with Vitest `vi.mock('../lib/stripe')`) to avoid real API calls.
- Verify credentials by running `stripe login` or `stripe balance` with the same key; mismatches cause 401 errors across the app.
- Enable Stripe CLI forwarding to test webhooks end-to-end: `stripe listen --forward-to localhost:4242/webhooks/stripe`.
