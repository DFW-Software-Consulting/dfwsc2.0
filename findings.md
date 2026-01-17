# Findings

## High
- `backend/src/lib/auth.ts:7` + `backend/src/routes/payments.ts:19`: `/payments/create` is authorized only by the `x-api-role` header, which is trivially spoofed by any caller. This effectively bypasses authentication for payment creation.
- `backend/src/routes/connect.ts:173`: `/connect/callback` is unauthenticated and accepts `client_id` + `account` query params, allowing anyone with a client ID to overwrite the linked Stripe account.

## Medium
- `backend/src/routes/connect.ts:164`: Onboarding token is marked `completed` before the Stripe onboarding flow finishes; abandoned onboarding leaves tokens unusable.
- `backend/src/routes/connect.ts:52` + `backend/src/routes/connect.ts:84`: Onboarding URLs are hard-coded to `https://dfwsc.com/onboard` instead of `FRONTEND_ORIGIN`, breaking non-prod environments.
- `backend/src/routes/payments.ts:10` + `backend/src/routes/webhooks.ts:9` + `backend/src/server.ts:1`: `USE_CHECKOUT`/`STRIPE_WEBHOOK_SECRET` are read at module load, but dotenv loads later; in dev this can force `USE_CHECKOUT=false` and/or throw before envs are loaded.
- `backend/src/routes/config.ts:3` + `backend/src/routes/config.ts:17`: `/app-config.js` builds JS directly from Host/X-Forwarded headers without sanitization, enabling host-header based script injection.
- `docker-compose.yml:8` + `backend/src/server.ts:15`: Compose sets `NODE_ENV=production`, so migrations never run on startup; local environments can drift from expected schema.

## Low
- `front/src/components/admin/CreateClientForm.jsx:73` + `backend/src/routes/connect.ts:54`: Create-client success toast expects `data.name`, but `/accounts` does not return `name`, resulting in "Client undefined created successfully!".
- `backend/src/routes/payments.ts:29` + `backend/src/routes/payments.ts:65`: `applicationFeeAmount` is accepted but ignored, and error messages reference it while `DEFAULT_PROCESS_FEE_CENTS` is always used.

## Testing Gaps
- No coverage for payment authorization (spoofed `x-api-role`) or `/connect/callback` tampering.
- No tests for onboarding token lifecycle (pending -> completed) or abandoned flows.
- No tests for env-loading order (`USE_CHECKOUT`, `STRIPE_WEBHOOK_SECRET`) in dev.
- No tests for host-header handling in `/app-config.js`.

## Follow-ups / Decisions
- Confirmed direction: external systems will call `/payments/create`; use API keys per client stored as plaintext strings in the database. Update auth to validate API key and bind requests to the associated client.
- Additional decision: generate API keys at client creation (`/accounts`), store one active key per client, send via `x-api-key` header, and bind payments to the API-key client (ignore or validate `clientId`).
