---
title: "Tests for Rate Limit and Webhook Edge Cases – Plan"
phase: Plan
date: "2026-01-17_20-29-05"
owner: "agent"
parent_research: "memory-bank/tickets/2026-01-17/08-tests-rate-limit-webhook.md"
git_commit_at_plan: "0ae20f0"
tags: [plan, tests, rate-limit, webhook]
---

## Goal

**Add ONE comprehensive test file covering rate limiting edge cases for the auth login endpoint.**

The webhook signature validation already has 3 tests covering missing headers, invalid signatures, and valid signatures (see `app.test.ts:1085-1143`). Rate limiting has **zero tests** currently - this is the critical gap to fill.

**Non-Goals:**
- Do not refactor the rate-limit implementation
- Do not add rate limit tests for payments or connect endpoints (focus on auth only)
- Do not add additional webhook tests (coverage already exists)

## Scope & Assumptions

**In Scope:**
- Rate limit tests for `/api/v1/auth/login` endpoint (5 requests / 15 minutes)
- Edge cases: window reset, boundary conditions, IP-based tracking
- Tests must run in Docker environment via `make test`

**Out of Scope:**
- Rate limiting for `/api/v1/payments/create` or `/api/v1/connect/*` endpoints
- Modifying the rate-limit.ts implementation
- Additional webhook tests (already covered)

**Assumptions:**
- In-memory rate limiter resets between test server instances
- Test framework is Vitest with Fastify inject for HTTP testing
- Tests will use the existing mock infrastructure in app.test.ts

## Deliverables (DoD)

| Artifact | Acceptance Criteria |
|----------|---------------------|
| `backend/src/__tests__/integration/auth-rate-limit.test.ts` | Contains rate limit edge case tests |
| Test passes | `make test` runs successfully with all tests passing |
| Coverage | Tests verify: limit enforcement (429), boundary at max requests, window reset behavior |

## Readiness (DoR)

- [x] Rate limit implementation exists (`backend/src/lib/rate-limit.ts`)
- [x] Auth route uses rate limit: 5 requests / 15 minutes (`backend/src/routes/auth.ts`)
- [x] Test infrastructure exists (Vitest, Fastify inject pattern)
- [x] Docker test environment configured (`make test`)
- [x] Existing test patterns available in `app.test.ts` for reference

## Milestones

| ID | Milestone | Description |
|----|-----------|-------------|
| M1 | Test File Setup | Create test file with proper imports and describe blocks |
| M2 | Core Tests | Implement rate limit edge case tests |
| M3 | Validation | Run tests in Docker, verify all pass |

## Work Breakdown (Tasks)

| Task ID | Summary | Owner | Dependencies | Milestone |
|---------|---------|-------|--------------|-----------|
| T1 | Create `auth-rate-limit.test.ts` with test infrastructure | agent | - | M1 |
| T2 | Implement test: "blocks requests after exceeding limit" | agent | T1 | M2 |
| T3 | Implement test: "allows requests up to the limit" | agent | T1 | M2 |
| T4 | Implement test: "rate limit is per-IP" | agent | T1 | M2 |
| T5 | Run `make test` and verify all tests pass | agent | T2-T4 | M3 |

### Task Details

**T1: Create test file**
- Files: `backend/src/__tests__/integration/auth-rate-limit.test.ts`
- Pattern: Follow existing integration test patterns
- Acceptance: File imports Vitest, Fastify, creates describe block

**T2-T4: Core Tests**
- Files: Same test file
- Acceptance Tests:
  - T2: Send 6 requests rapidly, verify 6th returns 429 `{ error: 'Too Many Requests' }`
  - T3: Send exactly 5 requests, verify all return 200 (or 401 for invalid creds)
  - T4: Use different IPs, verify each IP has independent limit

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| In-memory state persists between tests | Test flakiness | Medium | Create fresh server instance per test | Tests fail intermittently |
| Cannot mock IP addresses easily | Cannot test per-IP behavior | Low | Use Fastify inject with remoteAddress option | IP test fails |

## Test Strategy

**ONE new test file:** `backend/src/__tests__/integration/auth-rate-limit.test.ts`

**Test Cases (3-4 tests in single file):**
1. `it('returns 429 after exceeding rate limit')` - Core enforcement
2. `it('allows requests up to the limit before blocking')` - Boundary condition
3. `it('tracks rate limits per IP address')` - IP isolation

## References

- Rate limit implementation: `backend/src/lib/rate-limit.ts:10-29`
- Auth route with rate limit: `backend/src/routes/auth.ts`
- Existing webhook tests for pattern reference: `backend/src/__tests__/app.test.ts:1085-1143`
- Ticket: `memory-bank/tickets/2026-01-17/08-tests-rate-limit-webhook.md`

## Alternative Option

If rate limit testing proves complex due to in-memory state issues, an alternative is to add a unit test for the `rateLimit()` function directly by mocking Fastify request/reply objects. This would test the logic without HTTP layer complexity.

---

## Summary

- **Plan path:** `memory-bank/plan/2026-01-17_20-29-05_tests-rate-limit-webhook.md`
- **Milestones:** 3 (Setup, Core Tests, Validation)
- **Gates:** Tests must pass via `make test`
- **Next command:** `/ce-ex "memory-bank/plan/2026-01-17_20-29-05_tests-rate-limit-webhook.md"`
