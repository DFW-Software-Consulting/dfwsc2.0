# Deep Review Report: Backend Full Codebase Audit

**Date:** 2026-03-15
**Scope:** All backend source files (`backend/src/**/*.ts`, excluding `node_modules`)
**Branch:** `fix/deep-review-20260315`
**Status:** Partially Fixed (4 fixed, 3 deferred)

---

## Executive Summary

Issues found: **7 total** (4 fixed, 3 deferred)

| Priority | Category | Finding | Status | Location |
|----------|----------|---------|--------|----------|
| P0 | Security | Rate limiter sweep cutoff shorter than max window → auth bypass | **FIXED** | `lib/rate-limit.ts` |
| P1 | Bug | Connect callback completes with no client record → orphaned token | **FIXED** | `routes/connect.ts:536` |
| P1 | Bug | Resend revokes oldest token (ASC), not most-recent (DESC) | **FIXED** | `routes/connect.ts:289` |
| P1 | Quality | `console.error` in `requireApiKey` bypasses structured logging | **FIXED** | `lib/auth.ts:56` |
| P2 | Security | Stripe error message leaked to client in `/connect/refresh` | DEFERRED | `routes/connect.ts:432` |
| P2 | Smell | `isValidHttpsUrl` duplicated in `clients.ts` and `groups.ts` | DEFERRED | both route files |
| P2 | Smell | `formatStripeInvoice` duplicated in `invoices.ts` and `subscriptions.ts` | DEFERRED | both route files |

---

## Fixes Applied

### [S-01] Rate limiter sweep cutoff shorter than max window — FIXED

- **Severity:** Critical (P0)
- **Location:** `backend/src/lib/rate-limit.ts`
- **Commit:** `3cf1b76`
- **Issue:** `SWEEP_INTERVAL_MS = 10 min` was used as both the sweep cadence and the bucket age threshold. The auth login endpoint uses a 15-minute window. An attacker could exhaust the 5-attempt limit at T=0, wait 10 minutes for the sweep to clear their bucket, and make more attempts even though the 15-minute window was still active. The `<=` comparison also incorrectly swept hits that landed exactly on the boundary.
- **Fix:** Separated the sweep interval (10 min) from the bucket max age (20 min, larger than the max 15-min window). Changed `<=` to `<` to prevent boundary-case eviction.

### [B-01] Connect callback proceeds with no client record — FIXED

- **Severity:** Major (P1)
- **Location:** `backend/src/routes/connect.ts:536–541`
- **Commit:** `3f01ae7`
- **Issue:** When the DB lookup for `clientRecord` returned nothing, the code logged a warning and fell through to the transaction. The transaction then updated 0 client rows (no-op) but still marked the onboarding token `completed`, leaving an orphaned completed token with no actual client linked. The caller received a redirect as if everything succeeded.
- **Fix:** Added an early `return reply.code(400).send({ error: "Client not found." })` when `clientRecord` is null, consistent with how other invalid-parameter cases are handled in the same handler.

### [B-02] Resend revokes oldest token instead of most-recent — FIXED

- **Severity:** Major (P1)
- **Location:** `backend/src/routes/connect.ts:285–290`
- **Commit:** `993109f`
- **Issue:** `.orderBy(onboardingTokens.createdAt)` defaults to ascending, so `limit(1)` returned the oldest token. If somehow multiple active tokens existed for a client (e.g., due to prior failed resend), the newest active link would survive revocation while an old, likely-expired one was marked revoked. The client would still possess a valid, un-revoked token.
- **Fix:** Changed to `.orderBy(desc(onboardingTokens.createdAt))` and added `desc` to the drizzle import.

### [Q-01] `console.error` in `requireApiKey` bypasses structured logging — FIXED

- **Severity:** Major (P1)
- **Location:** `backend/src/lib/auth.ts:56`
- **Commit:** `df271ae`
- **Issue:** `requireApiKey` is a Fastify `preHandler` with access to `request.log`. Using `console.error` bypasses the structured logging pipeline (no request ID, no JSON fields, no log level routing), making API key validation errors harder to correlate in production log aggregation.
- **Fix:** Replaced `console.error("Error in requireApiKey:", error)` with `request.log.error({ error }, "Error in requireApiKey")`.

---

## Deferred Issues

### [S-02] Stripe error message leaked in `/connect/refresh` — DEFERRED

- **Severity:** Low (P2)
- **Location:** `backend/src/routes/connect.ts:432`
- **Issue:** The error handler returns `{ error: errorMessage }` directly, where `errorMessage` comes from a Stripe API exception. Stripe errors can contain internal IDs or implementation details.
- **Reason deferred:** The endpoint is protected by rate limiting (10/min per IP) and the token is required, reducing practical exploit surface. The `statusCode === 404` path already shows the raw message intentionally.
- **Recommendation:** Replace non-404 error messages with a generic "Failed to generate account link. Please try again." message for non-404 error paths.

### [SM-01] `isValidHttpsUrl` duplicated — DEFERRED

- **Severity:** Low (P2)
- **Location:** `backend/src/routes/clients.ts:20` and `backend/src/routes/groups.ts:25`
- **Issue:** Identical function defined in both files. Any change to validation logic must be applied twice.
- **Reason deferred:** Requires creating a shared `lib/validation.ts` utility — minor architectural refactor with no runtime impact.
- **Recommendation:** Extract to `backend/src/lib/validation.ts` and import in both routes.

### [SM-02] `formatStripeInvoice` duplicated — DEFERRED

- **Severity:** Low (P2)
- **Location:** `backend/src/routes/invoices.ts:27` and `backend/src/routes/subscriptions.ts:56`
- **Issue:** Similar but diverged — the invoices version includes `clientName`, the subscriptions version omits it. Copy-paste divergence creates maintenance risk.
- **Reason deferred:** The two versions have legitimately different shapes. A merge requires careful API surface review.
- **Recommendation:** Extract common fields to a shared formatter and extend per-route.

---

## Quality Control Results

- **Type check** (`tsconfig.build.json`): PASSED (pre-existing errors in `node_modules` and test files excluded by build config)
- **Linter** (Biome on changed files): PASSED — no issues
- **Frontend tests**: PASSED — 6/6
- **Pre-commit hooks**: PASSED — all 4 commits cleared all 14 guards

---

## Additional Observations (No Fix Required)

- **Token storage (frontend):** JWT stored in `sessionStorage` rather than `localStorage`. Acceptable trade-off — survives page refresh within tab but cleared on tab close, reducing XSS persistence window.
- **Rate limiter is in-memory:** Documented in CLAUDE.md. Unsuitable for multi-instance deployments, but appropriate for current single-instance setup.
- **`resolveServerBaseUrl` trusts forwarded headers:** Only triggered when `API_BASE_URL` is not set. Production should always set `API_BASE_URL`; the header fallback is a dev convenience only.
- **Legacy API key fallback:** Iterates all clients with `null` apiKeyLookup for bcrypt comparison (O(n·bcrypt)). Acceptable as a transitional measure, but should be removed once all clients are migrated.
