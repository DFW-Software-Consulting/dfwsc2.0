---
title: "app-config Host Validation – Plan"
phase: Plan
date: "2026-01-16T20:15:00Z"
owner: "agent"
parent_research: "memory-bank/tickets/2026-01-14_review-findings/06-app-config-host-validation.md"
git_commit_at_plan: "135a550"
tags: [plan, security, host-validation, xss-prevention]
---

## Goal

**Eliminate host-header injection vulnerability in `/app-config.js` by making `API_BASE_URL` the sole source of truth for the API URL, removing untrusted header fallback logic.**

Non-goals:
- Refactoring unrelated routes
- Adding new features to the config endpoint
- Changing CORS or other security mechanisms

## Scope & Assumptions

### In Scope
- `backend/src/routes/config.ts` - Remove host header fallback, require `API_BASE_URL`
- `backend/src/lib/env.ts` - Add `API_BASE_URL` to required environment variables
- Return clear 500 error if `API_BASE_URL` is not configured
- Add JavaScript string escaping as defense-in-depth

### Out of Scope
- `backend/src/routes/connect.ts` (has same pattern but separate ticket)
- Allowlist-based validation (over-engineering for this use case)
- Protocol validation (unnecessary if using env var)

### Assumptions
- `API_BASE_URL` will be set in all deployment environments
- Existing `.env.example` already documents `API_BASE_URL`
- No downstream consumers depend on dynamic host detection

### Constraints
- Must not break existing functionality when `API_BASE_URL` is properly configured
- Must provide clear error message if misconfigured
- Follow existing codebase patterns (no new dependencies)

## Deliverables (DoD)

| Artifact | Acceptance Criteria |
|----------|---------------------|
| `config.ts` modification | Host header fallback removed; uses only `API_BASE_URL`; returns 500 if not set |
| `env.ts` modification | `API_BASE_URL` added to `REQUIRED_ENV_VARS` array |
| JavaScript escaping | `JSON.stringify()` used for safe string embedding |
| Integration test | One test validates malicious host header is ignored |

## Readiness (DoR)

- [x] Research document reviewed: `memory-bank/tickets/2026-01-14_review-findings/06-app-config-host-validation.md`
- [x] Current implementation analyzed: `backend/src/routes/config.ts`
- [x] Environment validation pattern understood: `backend/src/lib/env.ts`
- [x] Test framework identified: Vitest with Fastify inject()
- [x] Git state clean on branch `client-status-db`

## Milestones

### M1: Core Security Fix
- Make `API_BASE_URL` required in `env.ts`
- Update `config.ts` to use only `API_BASE_URL`
- Add proper error handling for missing config

### M2: Defense-in-Depth
- Add `JSON.stringify()` escaping for JavaScript output
- Ensure trailing slash normalization preserved

### M3: Validation Test
- Add one integration test for host header rejection

### M4: Verification
- Run existing tests to ensure no regressions
- Verify Docker build succeeds

## Work Breakdown (Tasks)

### Task 1: Add API_BASE_URL to Required Env Vars
**Summary:** Add `'API_BASE_URL'` to `REQUIRED_ENV_VARS` array in `env.ts`
**Owner:** agent
**Dependencies:** None
**Target Milestone:** M1

**Acceptance Tests:**
- `API_BASE_URL` appears in `REQUIRED_ENV_VARS` array
- Application fails to start if `API_BASE_URL` is not set
- Existing tests still pass (they set this env var)

**Files/Interfaces:**
- `backend/src/lib/env.ts:4-17` - Add to array

### Task 2: Refactor config.ts to Use Only API_BASE_URL
**Summary:** Remove host header fallback; use `API_BASE_URL` directly with error handling
**Owner:** agent
**Dependencies:** Task 1
**Target Milestone:** M1

**Acceptance Tests:**
- `resolveApiBaseUrl()` function no longer reads request headers
- Returns 500 with clear error if `API_BASE_URL` not set
- `JSON.stringify()` used for safe JavaScript string embedding

**Files/Interfaces:**
- `backend/src/routes/config.ts:3-22` - Rewrite function

### Task 3: Add Integration Test for Host Header Rejection
**Summary:** Create test verifying malicious host headers don't affect output
**Owner:** agent
**Dependencies:** Task 2
**Target Milestone:** M3

**Acceptance Tests:**
- Test sends request with malicious `Host` header
- Response contains only the configured `API_BASE_URL` value
- Test lives in `backend/src/__tests__/integration/`

**Files/Interfaces:**
- `backend/src/__tests__/integration/app-config-host.test.ts` - New file (one test only)

### Task 4: Verify All Tests Pass
**Summary:** Run full test suite and Docker build
**Owner:** agent
**Dependencies:** Tasks 1-3
**Target Milestone:** M4

**Acceptance Tests:**
- `npm test` passes in Docker container
- `docker-compose up -d --build` succeeds
- `/app-config.js` endpoint returns expected response

**Files/Interfaces:**
- No file changes; verification only

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| Breaking existing deployments missing `API_BASE_URL` | High | Low | Document in .env.example; clear error message | Deployment failure |
| Test environment missing env var | Medium | Medium | Ensure test setup sets `API_BASE_URL` | Test failures |
| Docker compose env not updated | Medium | Low | Verify .env.example has `API_BASE_URL` | Build failure |

## Test Strategy

**ONE new test file:** `backend/src/__tests__/integration/app-config-host.test.ts`

Test case:
```typescript
it('ignores malicious Host header when API_BASE_URL is set', async () => {
  // Set API_BASE_URL to known value
  // Send request with malicious Host header
  // Assert response contains only API_BASE_URL value
});
```

Existing test coverage:
- `app.test.ts` already sets `API_BASE_URL` in env setup
- Environment validation tests exist in `env-guard.test.ts`

## References

- Research doc: `memory-bank/tickets/2026-01-14_review-findings/06-app-config-host-validation.md`
- Vulnerable code: `backend/src/routes/config.ts:3-17`
- Env validation: `backend/src/lib/env.ts:4-17`
- Test patterns: `backend/src/__tests__/integration/payments-api-key.test.ts`
- OWASP Host Header Injection: https://owasp.org/www-project-web-security-testing-guide/

## Alternative Approach (Not Recommended)

**Option B: Allowlist-based validation**
- Keep host header fallback
- Validate against `FRONTEND_ORIGIN` allowlist
- Add protocol and hostname format validation

**Why not chosen:** Over-engineering. Since `API_BASE_URL` is already supported and should be configured in production, requiring it is simpler and more secure than complex validation logic.

---

## Final Gate

| Item | Value |
|------|-------|
| Plan path | `memory-bank/plan/2026-01-16_20-15-00_app-config-host-validation.md` |
| Milestones | 4 (M1: Core Fix, M2: Defense, M3: Test, M4: Verify) |
| Tasks | 4 |
| Gates | Task dependencies enforced; tests must pass before completion |
| Drift detected | Minor (env loading fix in 135a550) - no impact on config.ts |

**Next command:** `/ce-ex "memory-bank/plan/2026-01-16_20-15-00_app-config-host-validation.md"`
