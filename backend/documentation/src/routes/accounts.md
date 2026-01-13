# src/routes/connect.ts

## Purpose
Implements Stripe Connect onboarding flows. Admins can register or update client records, provision Express accounts, and generate onboarding links. Stripe redirects back to the callback route once onboarding is complete.

## Dependencies
- `x-api-role` header must be `admin` for protected handlers via `requireRole(['admin'])`.
- `Idempotency-Key` header enforces safe retries on `POST /connect/onboard`.
- `API_BASE_URL` (optional) — overrides base URL when computing onboarding callbacks.
- `FRONTEND_ORIGIN` (optional) — used to redirect from `/connect/callback` to a success page when available.
- Database: reads/writes the `clients` table via Drizzle.
- Stripe SDK: `stripe.accounts.create` and `stripe.accountLinks.create`.

## Key Endpoints
- `POST /connect/onboard`
  - Body: `{ clientId, name, email }`.
  - Ensures the client record exists, creates or reuses a Stripe Express account, and returns `{ clientId, stripeAccountId, url }`.
  - Guards: rate limited to 5 requests per minute per IP and requires the admin role.
- `GET /connect/callback`
  - Query parameters: `client_id`, `account`.
  - Persists the Stripe account ID to the client record and optionally redirects to `${FRONTEND_ORIGIN}/connect/success` with query params.

## Example Usage
```bash
curl -X POST http://localhost:4242/connect/onboard \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: onboarding-123' \
  -H 'x-api-role: admin' \
  -d '{
    "clientId": "client_123",
    "name": "Acme Corp",
    "email": "owner@acme.test"
  }'

# Stripe redirects back with GET /connect/callback?client_id=client_123&account=acct_456
```

## Testing & Debugging Notes
- Use the static admin helper at `public/admin-token-generator.html` to exercise onboarding flows manually.
- The Vitest suite (`src/__tests__/app.test.ts`) covers onboarding flows; run `npm test` to validate changes.
- For callback debugging, inspect server logs—Fastify logs 302 redirects and any validation errors.
- When running behind a reverse proxy, set `API_BASE_URL` so onboarding links use the public hostname.
