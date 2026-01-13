# src/routes/payments.ts

## Purpose
Handles creation of payments on behalf of connected accounts. Depending on `USE_CHECKOUT`, it either issues PaymentIntents with automatic payment methods or Stripe Checkout Sessions that include platform fees.

## Dependencies
- `x-api-role` header must be `admin` or `client` as enforced by `requireRole(['admin', 'client'])`.
- `Idempotency-Key` header is required to deduplicate payment requests.
- `USE_CHECKOUT` — toggles between direct PaymentIntent creation (`false`) and Checkout Sessions (`true`).
- `FRONTEND_ORIGIN` — required when `USE_CHECKOUT=true` to build success/cancel URLs.
- Database: queries `clients` to locate Stripe account IDs.
- Stripe SDK: `paymentIntents.create` and `checkout.sessions.create` APIs.

## Key Endpoint
- `POST /payments/create`
  - Body parameters vary with `USE_CHECKOUT`:
    - PaymentIntents: `{ clientId, amount, currency, description?, metadata?, applicationFeeAmount? }`.
    - Checkout: `{ clientId, lineItems, description?, metadata?, applicationFeeAmount?, amount? }` (`amount` optional for validation only).
  - Returns `{ clientSecret, paymentIntentId }` for PaymentIntents or `{ url }` for Checkout Sessions.
  - Validates connected account presence and fee boundaries.

## Example Usage
```bash
curl -X POST http://localhost:4242/payments/create \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: payment-456' \
  -H 'x-api-role: admin' \
  -d '{
    "clientId": "client_123",
    "amount": 7500,
    "currency": "usd",
    "description": "Consulting invoice",
    "applicationFeeAmount": 750
  }'
```

When `USE_CHECKOUT=true` in `.env`, send Checkout line items:
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
- For idempotency issues, verify that the header value changes between retries or clear prior PaymentIntents in the Stripe Dashboard.
