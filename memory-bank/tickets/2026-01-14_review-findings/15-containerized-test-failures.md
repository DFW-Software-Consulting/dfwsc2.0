# Test Follow-up: Containerized Test Failures (DB/MailHog OK)

**Created:** 2026-01-18
**Priority:** Medium

## Summary

After running tests inside the dev containers (DB/MailHog reachable), several tests still fail due to state/expectation issues.

## Failing Areas

- `backend/src/routes/clients.test.ts`
  - `GET /api/v1/clients` expected specific clients but they were missing.
  - `GET /api/v1/clients` expected empty array but received a seeded client.
- `backend/src/__tests__/integration/connect-callback-state.test.ts`
  - `stripeAccountId` read from `undefined` client (likely missing or cleanup issue).
  - Missing `state` parameter returns 302 instead of 400.
- `backend/src/__tests__/integration/payments-api-key.test.ts`
  - Expected 400, received 401 (auth expectations or test setup mismatch).

## Tasks

- [ ] Audit test setup/teardown to ensure DB state isolation between tests.
- [ ] Verify `/api/v1/connect/callback` behavior for missing `state` and align tests/handler.
- [ ] Align payments API key tests with current auth/validation behavior.

## References
- Test run via `make test` inside dev containers (DB/MailHog reachable).
