# Code Review Follow-up: API Key Auth for Payments

**Created:** 2026-01-14
**Priority:** High

## Summary

Implement per-client API keys (plaintext stored in DB) for `/payments/create`, replacing the spoofable `x-api-role` header. Bind payment creation to the API-key client.

## Tasks

- [ ] Add `apiKey` column to `clients` schema and create migration.
- [ ] Generate a single API key when a client is created via `/accounts` and return it once in the response.
- [ ] Require `x-api-key` for `/payments/create`, look up the client by key, and reject missing/invalid keys.
- [ ] Bind payment creation to the API-key client (ignore `clientId` from the body or enforce it matches the key).
- [ ] Remove `requireRole` usage on `/payments/create` (or keep only if it adds value after API-key auth).
- [ ] Document the header and flow in API docs.

## References
- `backend/src/lib/auth.ts:7`
- `backend/src/routes/payments.ts:19`
- `backend/src/routes/connect.ts:29`
- `backend/src/db/schema.ts:1`
