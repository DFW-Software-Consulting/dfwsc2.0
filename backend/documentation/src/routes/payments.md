# src/routes/payments.ts

## Purpose
Handles creation of payments on behalf of connected accounts. Every payment creates a Stripe Checkout Session that includes platform fees and returns the hosted checkout URL.

## Dependencies
- `x-api-role` header must be `admin` or `client` as enforced by `requireRole(['admin', 'client'])`.
- `Idempotency-Key` header is required to deduplicate payment requests.
- `FRONTEND_ORIGIN` — required to build the default success/cancel URLs.
- Database: queries `clients` to locate Stripe account IDs.
- Stripe SDK: `checkout.sessions.create` API (`paymentIntents.list` for reports).

## Key Endpoint
- `POST /payments/create`
  - Body: `{ clientId, lineItems, description?, metadata?, applicationFeeAmount?, amount? }` (`amount` optional for validation only).
  - Returns `{ url }` for the hosted Checkout Session.
  - Validates connected account presence and fee boundaries.

## Example Usage
```bash
curl -X POST http://localhost:4242/payments/create \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: checkout-123' \
  -H 'x-api-role: admin' \
  -d '{
    "clientId": "client_123",
    "lineItems": [
      { "price_data": { "currency": "usd", "unit_amount": 5000, "product_data": { "name": "Retainer" } }, "quantity": 1 }
    ],
    "applicationFeeAmount": 500
  }'
```

## Testing & Debugging Notes
- Ensure the target client has a `stripeAccountId`; otherwise the route returns `400/404`.
- Use Stripe Dashboard logs to confirm Connect destination charges show the expected application fee.
- Automated coverage lives in `src/__tests__/app.test.ts` under the payments suite—run `npm test` after modifications.
- For idempotency issues, verify that the header value changes between retries or clear prior Checkout Sessions in the Stripe Dashboard.
