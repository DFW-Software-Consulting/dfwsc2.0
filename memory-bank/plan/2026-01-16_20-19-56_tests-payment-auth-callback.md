---
title: "Tests Payment Auth & Callback – Plan"
phase: Plan
date: "2026-01-16_20-19-56"
owner: "agent"
parent_research: "memory-bank/tickets/2026-01-14_review-findings/10-tests-payment-auth-callback.md"
git_commit_at_plan: "c7fd6df"
tags: [plan, tests, payment-auth, connect-callback, security]
---

## Goal

**Add ONE focused integration test** that validates the `/connect/callback` endpoint rejects tampered state parameters, covering the security gap identified in the research document.

**Non-goals:**
- Payment API key tests (already covered in `payments-api-key.test.ts`)
- Full test suite rewrite
- Unit tests for auth middleware
- Multiple new test files

## Scope & Assumptions

### In Scope
- Add test case(s) to existing `connect-callback-state.test.ts` for state tampering rejection
- Validate invalid/expired state handling
- Validate mismatched account rejection (if not already covered)

### Out of Scope
- Payment API key authentication tests (T1 in research doc - ALREADY EXISTS at `backend/src/__tests__/integration/payments-api-key.test.ts`)
- New test files or test infrastructure
- Mocking changes
- Performance testing

### Assumptions
- Vitest + Fastify inject() pattern continues to be used
- Real database integration tests (not mocked)
- Docker environment available for test execution
- Existing `connect-callback-state.test.ts` can be extended

### Constraints
- Maximum ONE new test (per prompt requirements)
- Must follow existing test patterns in codebase
- No code changes to production files

## Deliverables (DoD)

| Artifact | Acceptance Criteria |
|----------|---------------------|
| Extended test in `connect-callback-state.test.ts` | Test validates that `/connect/callback` rejects requests with mismatched client_id and state combinations (cross-client state injection) |

## Readiness (DoR)

- [x] Research document read and understood
- [x] Existing test patterns analyzed
- [x] Key files identified (`connect-callback-state.test.ts`, `connect.ts`)
- [x] Testing framework confirmed (Vitest)
- [x] Database schema understood (`onboardingTokens` table)
- [ ] Docker environment running (required for execution)

## Milestones

| ID | Milestone | Description |
|----|-----------|-------------|
| M1 | Analysis | Review existing test coverage in `connect-callback-state.test.ts` |
| M2 | Implementation | Add cross-client state injection test case |
| M3 | Validation | Run test suite, verify pass |

## Work Breakdown (Tasks)

### T1: Review Existing Connect Callback Tests
- **Summary:** Read `connect-callback-state.test.ts` to identify coverage gaps
- **Owner:** Agent
- **Dependencies:** None
- **Target Milestone:** M1
- **Files:** `backend/src/__tests__/integration/connect-callback-state.test.ts`
- **Acceptance Tests:**
  - [ ] Identify which tampering scenarios are already covered
  - [ ] Confirm cross-client state injection is NOT currently tested

### T2: Add Cross-Client State Injection Test
- **Summary:** Add test that attempts to use state from Client A with Client B's callback
- **Owner:** Agent
- **Dependencies:** T1
- **Target Milestone:** M2
- **Files:** `backend/src/__tests__/integration/connect-callback-state.test.ts`
- **Acceptance Tests:**
  - [ ] Test creates two clients with separate onboarding tokens/states
  - [ ] Test attempts callback with Client A's client_id but Client B's state
  - [ ] Test verifies 400 response with "Invalid or expired state parameter"
  - [ ] Test follows existing patterns (Fastify inject, real DB, cleanup)

### T3: Run Test Suite
- **Summary:** Execute tests and verify all pass
- **Owner:** Agent
- **Dependencies:** T2
- **Target Milestone:** M3
- **Acceptance Tests:**
  - [ ] `npm run test` passes in Docker container
  - [ ] New test case passes
  - [ ] No regressions in existing tests

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| Test already exists | Low | Medium | Skip T2 if coverage confirmed in T1 | Discovery in T1 |
| Database state conflicts | Medium | Low | Use unique UUIDs, proper cleanup in afterEach | Test failures |
| Docker not running | High | Low | Prompt user to start containers | Connection errors |

## Test Strategy

**ONE new test case** added to existing `connect-callback-state.test.ts`:

```
Test: "should reject state parameter from different client (cross-client injection)"
  Given: Client A with valid state, Client B with valid state
  When: Callback called with client_id=A, state=B's_state
  Then: Returns 400 "Invalid or expired state parameter"
```

**Rationale:** This is the most critical security gap - the existing tests cover missing state, invalid state, and expired state, but NOT cross-client state injection which is an OWASP-level vulnerability.

## Alternative Option

If the cross-client state injection test already exists, the alternative focus would be:
- Add test for **state reuse prevention** (same state used twice should fail on second attempt)

This would validate that completed states cannot be replayed.

## References

- Research: `memory-bank/tickets/2026-01-14_review-findings/10-tests-payment-auth-callback.md`
- Existing tests: `backend/src/__tests__/integration/connect-callback-state.test.ts`
- Route under test: `backend/src/routes/connect.ts:211-285`
- Schema: `backend/src/db/schema.ts` (onboardingTokens table)
- Auth analysis: Agent findings on state validation (atomic dual-condition query)

---

## Final Gate

| Item | Value |
|------|-------|
| Plan Path | `memory-bank/plan/2026-01-16_20-19-56_tests-payment-auth-callback.md` |
| Milestones | 3 (Analysis → Implementation → Validation) |
| Gates | T1 confirms gap exists, T2 adds test, T3 validates |
| Next Command | `/ce-ex "memory-bank/plan/2026-01-16_20-19-56_tests-payment-auth-callback.md"` |
