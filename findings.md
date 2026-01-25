# Findings

## Code Review: `monorepo` Branch (2026-01-17)

### Overview

Major feature branch that builds out a complete Stripe payment portal with:
- Admin authentication (JWT-based)
- Client management (CRUD, status toggling)
- Stripe Connect onboarding with secure state validation
- Payment processing (PaymentIntent and Checkout modes)
- Webhook handling
- Full admin dashboard UI

**100+ commits, 171 files changed, ~23,000 lines added**

---

## Previously Identified Issues (Status)

### Resolved

| Issue | Status | Resolution |
|-------|--------|------------|
| `/payments/create` authorized only by spoofable `x-api-role` header | **FIXED** | Now uses `requireApiKey` middleware with DB-backed API key validation |
| `/connect/callback` unauthenticated, allows overwriting Stripe account | **FIXED** | Added cryptographic state parameter with expiration, validates client_id + state together |
| Onboarding token marked `completed` before Stripe flow finishes | **FIXED** | Status now deferred until after `stripe.accountLinks.create()` succeeds |
| Onboarding URLs hard-coded to `https://dfwsc.com/onboard` | **FIXED** | Now uses `FRONTEND_ORIGIN` env var |
| Env vars read at module load before dotenv loads | **FIXED** | Moved dotenv to synchronous load in `index.ts` entry point |
| `/app-config.js` host-header injection vulnerability | **FIXED** | Now uses `API_BASE_URL` env var, `JSON.stringify()` for safe embedding |
| `NODE_ENV=production` in compose prevents migrations | **FIXED** | Changed to `NODE_ENV=development` in docker-compose.yml |
| `/accounts` doesn't return `name` causing "Client undefined created" | **FIXED** | Endpoint now returns `name` in response |

---

## Current Issues

### High Priority

1. **Dead code in connect callback** (`backend/src/routes/connect.ts:1315-1335`)
   - The `else` branch is unreachable because of the explicit `!state` check at line 1251-1254 that returns 400
   - Should be removed

2. **Duplicate code in `/accounts` and `/onboard-client/initiate`** (`connect.ts:1048-1088` and `1092-1150`)
   - Both endpoints create clients and onboarding tokens with nearly identical logic
   - Consider extracting to a shared helper function

### Medium Priority

3. **Inconsistent API path usage** (Frontend)
   - Some calls use `/v1/` prefix, others don't (see `OnboardClient.jsx:22` vs `CreateClientForm.jsx:755`)
   - Backend registers routes with `/api/v1` prefix, so all frontend calls should use `/api/v1/`

4. **Missing dependency in useCallback** (`AdminDashboard.jsx:96`)
   - `fetchClients` calls `showToast` but it's not in the dependency array
   - Consider adding for clarity (though it's stable via useCallback)

5. **API key stored in plaintext** (`connect.ts:1043`)
   - Comment at `auth.ts:199` acknowledges this
   - Should hash API keys for production use

6. **Redundant check** (`connect.ts:1257`)
   - `if (state)` is redundant since we already returned 400 if `!state` at line 1251-1254

### Low Priority

7. **Missing `onSessionExpired` in dependency array** (`ClientList.jsx:425`)
   - The `updateClientStatus` callback uses `onSessionExpired` but doesn't list it

8. **Console.error statements** scattered in frontend components
   - Consider using a logging utility for production

9. **Token in sessionStorage** (`AdminLogin.jsx:258`)
   - sessionStorage is fine for SPA, but document the security trade-off vs httpOnly cookies

10. **Outdated onboarding testing docs** (`backend/documentation/docs/testing.md:24-31`)
    - Docs reference `/connect/onboard` and `x-api-role` header, but onboarding now uses `/api/v1/accounts` or `/api/v1/onboard-client/initiate` with JWT auth
    - As written, the documented curl example will fail

11. **Webhook test script uses wrong path** (`backend/test-stripe-webhooks.sh:22`)
    - Script forwards to `/webhooks/stripe`, but the server registers `/api/v1/webhooks/stripe`
    - Local webhook replay will miss the route unless the path is corrected

---

## Security Assessment

### Positive Security Practices

- **CSRF protection**: State parameter for connect callback is cryptographically secure, time-limited (30 min)
- **Rate limiting**: Applied to sensitive endpoints (auth: 5/15min, payments: 20/min, onboarding: 10/min)
- **JWT authentication**: Proper token validation with role checking and expiry handling
- **API key validation**: Checks client status (`inactive` clients rejected)
- **XSS prevention**: `JSON.stringify()` used for safe JavaScript embedding in config
- **No user enumeration**: Consistent error messages for invalid API keys

### Security Recommendations

- Hash API keys before storing in database
- Consider Redis-backed rate limiting for multi-instance deployments
- Consider httpOnly cookies for admin JWT (trade-off: requires CSRF tokens)

---

## Test Coverage

### Well Covered

- Client CRUD operations (`clients.test.ts`)
- Connect callback state validation (`connect-callback-state.test.ts`)
- Token lifecycle (`connect-token-lifecycle.test.ts`)
- API key auth (`payments-api-key.test.ts`)
- Environment loading order (`env-loading-order.test.ts`)
- Host header handling (`app-config-host.test.ts`)

### Gaps

- Auth rate limiting behavior (edge cases)
- Webhook signature validation edge cases
- Frontend component tests (no React testing files)
- E2E tests for full user flows

---

## Performance Considerations

- **Rate limit storage is in-memory** (`rate-limit.ts`) - won't scale across multiple instances
- **No visible database connection pooling** - verify Drizzle/pg handles this appropriately

---

## Architecture Notes

### Good Patterns

- Clean separation: routes, lib utilities, DB schema
- Drizzle ORM for type-safe database operations
- Environment validation at startup (`lib/env.ts`)
- Schema verification before server start (`lib/schema-check.ts`)
- Proper async dotenv loading to avoid race conditions
- Well-organized React components with proper hooks usage

### Recommendations

1. Remove dead code in connect callback else branch
2. Extract duplicate client creation logic into shared function
3. Add frontend E2E or component tests
4. Consider Redis for rate limiting in multi-instance deployments
5. Standardize API path prefixes in frontend

---

## Verdict

**Solid, well-structured code** with good security practices. The previously identified security vulnerabilities have been addressed. Remaining issues are mostly cleanup items rather than blockers. The branch is ready for merge after addressing the dead code and path consistency issues.

---

## Historical Context

### Original Findings (Pre-monorepo fixes)

These issues were identified in an earlier review and have since been resolved:

- `backend/src/lib/auth.ts:7` + `backend/src/routes/payments.ts:19`: `/payments/create` authorized only by spoofable `x-api-role` header
- `backend/src/routes/connect.ts:173`: `/connect/callback` unauthenticated, allowed Stripe account overwrite
- `backend/src/routes/connect.ts:164`: Onboarding token marked completed prematurely
- `backend/src/routes/connect.ts:52,84`: Hard-coded onboarding URLs
- Env loading race condition with `USE_CHECKOUT`/`STRIPE_WEBHOOK_SECRET`
- Host-header injection in `/app-config.js`
- `NODE_ENV=production` in compose preventing migrations

### Follow-ups Completed

- API keys per client stored in database (implemented)
- API key generation at client creation (implemented)
- `x-api-key` header validation (implemented)
- Payments bound to API-key client (implemented)
