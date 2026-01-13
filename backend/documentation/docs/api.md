# API Reference

This reference aggregates the Fastify routes exposed by the Stripe Payment Portal. Each section links back to the deeper module documentation under `documentation/src/routes/`.

## Authentication & Headers
- `x-api-role`: required for protected routes. Accepts `admin` or `client` depending on endpoint.
- `Idempotency-Key`: recommended/required on all POST routes that mutate Stripe state.

## Endpoints

### Connect Onboarding (`src/routes/connect.ts`)
- `POST /connect/onboard`
  - Body: `{ clientId, name, email }`.
  - Headers: `x-api-role: admin`, `Idempotency-Key`.
  - Response: `{ clientId, stripeAccountId, url }` (Stripe onboarding link).
- `GET /connect/callback`
  - Query: `client_id`, `account`.
  - Response: Redirect to `${FRONTEND_ORIGIN}/connect/success` when configured, otherwise JSON `{ clientId, stripeAccountId, status }`.

### Payments (`src/routes/payments.ts`)
- `POST /payments/create`
  - PaymentIntent mode: `{ clientId, amount, currency, description?, metadata?, applicationFeeAmount? }`.
  - Checkout mode: `{ clientId, lineItems, description?, metadata?, applicationFeeAmount?, amount? }`.
  - Headers: `x-api-role: admin|client`, `Idempotency-Key`.
  - Response: PaymentIntent `{ clientSecret, paymentIntentId }` or Checkout `{ url }`.

### Reports (`src/routes/payments.ts`)
- `GET /reports/payments`
  - Query: `clientId` (required), `limit?`, `starting_after?`, `ending_before?`.
  - Headers: `x-api-role: admin`.
  - Response: `{ clientId, data, hasMore }` with Stripe pagination metadata.

### Webhooks (`src/routes/webhooks.ts`)
- `POST /webhooks/stripe`
  - Headers: `Stripe-Signature` from Stripe.
  - Body: raw JSON webhook payload.
  - Response: `{ received: true }` after storing the event.

## Swagger UI
- Available at `/docs` when the server is running. Mirrors the same routes above for quick exploration.

## Testing Shortcuts
- Run `npm test` to execute Vitest suites that exercise all endpoints with mocked Stripe calls.
- Use `curl` examples in the route-specific docs and pair them with `stripe listen --forward-to localhost:4242/webhooks/stripe` for full flow validation.
