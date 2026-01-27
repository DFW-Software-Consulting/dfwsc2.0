# src/routes/payments.ts (Reports)

## Purpose
Exposes read-only reporting endpoints for connected accounts. Currently supports listing PaymentIntents for a client to provide lightweight reporting in admin tooling.

## Dependencies
- `x-api-role` header must be `admin`; enforced by `requireRole(['admin'])` on the reporting handler.
- Query parameters: `clientId` is required; Stripe pagination params (`limit`, `starting_after`, `ending_before`) are optional.
- Database: fetches the `clients` record to obtain the associated `stripeAccountId`.
- Stripe SDK: `stripe.paymentIntents.list`.

## Key Endpoint
- `GET /reports/payments`
  - Query: `clientId` (required), `limit?`, `starting_after?`, `ending_before?`.
  - Returns `{ clientId, data, hasMore }` mirroring Stripe’s list response.
  - Validates `limit` to be an integer between 1 and 100.

## Example Usage
```bash
curl "http://localhost:4242/reports/payments?clientId=client_123&limit=10" \
  -H 'x-api-role: admin'
```

## Testing & Debugging Notes
- Useful for quickly verifying payments after running `curl` requests from `documentation/src/routes/payments.md`.
- Stripe enforces pagination—use `starting_after` with the last PaymentIntent ID from the previous response to iterate.
- The same Vitest suite that covers payments also hits the reporting handler. Run `npm test` to ensure the list contract remains stable.
- For large datasets, prefer hitting Stripe’s dashboard exports; this endpoint is optimized for quick admin UIs rather than analytics dumps.
