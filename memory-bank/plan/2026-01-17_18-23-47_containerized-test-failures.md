---
title: "Containerized Test Failures – Plan"
phase: Plan
date: "2026-01-17T18:23:47"
owner: "agent"
parent_research: "memory-bank/tickets/2026-01-14_review-findings/15-containerized-test-failures.md"
git_commit_at_plan: "f308b90"
tags: [plan, test-failures, integration-tests]
---

## Goal

**Fix the `/api/v1/connect/callback` handler to return 400 when `state` parameter is missing, aligning implementation with test expectations.**

This is the singular, focused deliverable. The test currently expects a 400 error with `"Missing state parameter."` message, but the handler returns 302 redirect instead.

**Non-goals:**
- Refactoring test isolation patterns (larger effort)
- Fixing clients.test.ts issues (separate concern - requires test data isolation work)
- Fixing payments-api-key.test.ts issues (analysis shows tests match code - may be stale assertion)

## Scope & Assumptions

**In Scope:**
- Modify `/api/v1/connect/callback` handler to reject missing `state` with 400
- Validate the fix passes the existing test

**Out of Scope:**
- Test infrastructure refactoring
- Database isolation improvements
- Other test file fixes

**Assumptions:**
- Docker containers are running and accessible
- The test expectation (400 for missing state) is the correct security behavior
- No other code depends on the current "accept missing state" behavior

## Deliverables (DoD)

1. **Modified handler code** in `backend/src/routes/connect.ts` that:
   - Checks for missing `state` query parameter at the start
   - Returns `{ error: 'Missing state parameter.' }` with status 400
   - Maintains all existing behavior when `state` IS provided

2. **Passing test** for `connect-callback-state.test.ts` scenario: "should reject request without state parameter"

## Readiness (DoR)

- [x] Docker environment running (`docker-compose up -d`)
- [x] Database accessible
- [x] Test file identified: `backend/src/__tests__/integration/connect-callback-state.test.ts`
- [x] Handler file identified: `backend/src/routes/connect.ts` (lines 225-319)
- [x] Current behavior analyzed: missing state → 302 redirect
- [x] Expected behavior clear: missing state → 400 error

## Milestones

- **M1**: Implement state parameter validation (handler modification)
- **M2**: Verify test passes in container environment
- **M3**: Confirm no regression in other connect tests

## Work Breakdown (Tasks)

| Task ID | Summary | Owner | Dependencies | Milestone |
|---------|---------|-------|--------------|-----------|
| T1 | Add missing state check to callback handler | agent | None | M1 |
| T2 | Run connect-callback-state tests | agent | T1 | M2 |
| T3 | Run full connect test suite | agent | T2 | M3 |

### Task Details

**T1: Add missing state check to callback handler**
- **File:** `backend/src/routes/connect.ts`
- **Location:** Around line 230, before the existing `if (state)` block
- **Change:** Add early return with 400 status when state is missing/empty
- **Acceptance Tests:**
  - Handler returns 400 when `state` query param is missing
  - Handler returns `{ error: 'Missing state parameter.' }` in response body
  - Existing behavior preserved when state IS provided

**T2: Run connect-callback-state tests**
- **Command:** `docker exec dfwsc20-api-1 npx vitest run src/__tests__/integration/connect-callback-state.test.ts`
- **Acceptance Tests:**
  - Test "should reject request without state parameter" passes
  - No new test failures introduced

**T3: Run full connect test suite**
- **Command:** `docker exec dfwsc20-api-1 npx vitest run src/__tests__/integration/connect`
- **Acceptance Tests:**
  - All connect-related tests pass
  - No regressions

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| Breaking change for clients relying on missing-state behavior | High | Low | Check for downstream dependencies; this is security fix | Production issues post-deploy |
| Other tests depend on 302 redirect | Medium | Low | Run full test suite before merging | Test failures in CI |

## Test Strategy

**ONE test verification:**
- Run the existing test `connect-callback-state.test.ts` → specifically the "should reject request without state parameter" case
- This test already exists and defines the expected behavior

No new tests needed - we are aligning implementation to existing test expectations.

## References

- Research doc: `memory-bank/tickets/2026-01-14_review-findings/15-containerized-test-failures.md`
- Handler code: `backend/src/routes/connect.ts:225-319`
- Test file: `backend/src/__tests__/integration/connect-callback-state.test.ts:183-208`

---

## Alternative Approach (Optional)

If the investigation reveals that missing state should actually be allowed (the test is wrong), the alternative is:
- Update test to expect 302 redirect
- Document the security trade-off

This is NOT recommended from a security perspective (state parameter prevents CSRF in OAuth flows).

---

## Final Gate

| Item | Value |
|------|-------|
| Plan path | `memory-bank/plan/2026-01-17_18-23-47_containerized-test-failures.md` |
| Milestones | 3 (M1: Implement, M2: Verify test, M3: Regression check) |
| Gates | Test must pass in container environment |
| Tasks | 3 |

**Next command:** `/ce-ex "memory-bank/plan/2026-01-17_18-23-47_containerized-test-failures.md"`
