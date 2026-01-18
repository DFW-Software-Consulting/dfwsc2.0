---
title: "Connect Callback Dead Code Removal – Plan"
phase: Plan
date: "2026-01-17T22:45:30Z"
owner: "agent"
parent_research: "memory-bank/tickets/2026-01-17/01-connect-callback-dead-code.md"
git_commit_at_plan: "34277f0"
tags: [plan, dead-code, cleanup, connect-callback]
---

## Goal

Remove unreachable dead code and a redundant conditional check in the `/connect/callback` handler to improve code clarity without changing behavior.

**Non-goals:**
- Adding new features
- Refactoring other parts of the file
- Changing behavior

## Scope & Assumptions

**In scope:**
- Remove the `else` branch (lines 299-319) that is unreachable due to early return at line 237
- Remove the redundant `if (state)` check at line 241 (always true after early return)

**Out of scope:**
- Other endpoints in `connect.ts`
- Test modifications (existing tests already verify correct behavior)

**Assumptions:**
- The early return at lines 235-238 (`if (!state)`) is the intended behavior
- All callers must provide a valid `state` parameter (enforced by early return)

## Deliverables (DoD)

| Artifact | Acceptance Criteria |
|----------|---------------------|
| `backend/src/routes/connect.ts` | No unreachable `else` branch; no redundant `if (state)` wrapper |
| Existing tests | All 7 tests in `connect-callback-state.test.ts` pass |

## Readiness (DoR)

- [x] Source file identified: `backend/src/routes/connect.ts`
- [x] Dead code locations confirmed: lines 241 (redundant check), 299-319 (unreachable else)
- [x] Existing test coverage verified: 7 tests cover all callback scenarios
- [x] Docker environment available for testing

## Milestones

| ID | Name | Description |
|----|------|-------------|
| M1 | Code Cleanup | Remove dead/redundant code |
| M2 | Validation | Run existing tests to confirm no regression |

## Work Breakdown (Tasks)

### T1: Remove redundant `if (state)` wrapper (M1)
**Summary:** Unwrap the body of `if (state) { ... }` at line 241 since condition is always true after the early return at line 237.

**Owner:** agent
**Dependencies:** none
**Target Milestone:** M1

**Acceptance Tests:**
- Code compiles without errors
- Logic inside the former `if (state)` block remains intact and unindented

**Files/Interfaces:**
- `backend/src/routes/connect.ts` (lines 241-298)

---

### T2: Remove unreachable `else` branch (M1)
**Summary:** Delete the entire `else` block (lines 299-319) which can never execute.

**Owner:** agent
**Dependencies:** T1
**Target Milestone:** M1

**Acceptance Tests:**
- No `else` branch after the state validation logic
- Code compiles without errors

**Files/Interfaces:**
- `backend/src/routes/connect.ts` (lines 299-319)

---

### T3: Run existing tests (M2)
**Summary:** Execute `make test` to verify all existing tests pass.

**Owner:** agent
**Dependencies:** T2
**Target Milestone:** M2

**Acceptance Tests:**
- All 7 tests in `connect-callback-state.test.ts` pass
- No regressions in other test files

**Files/Interfaces:**
- None (test execution only)

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| Hidden side effect in dead code | Medium | Very Low | Review dead code carefully before deletion | Code review reveals non-obvious dependency |

## Test Strategy

**No new tests required.** The existing 7 tests in `connect-callback-state.test.ts` comprehensively cover:
- Missing state parameter → 400 error
- Invalid state parameter → 400 error
- Expired state parameter → 400 error
- Valid state → redirect + DB update
- Cross-client injection → 400 error
- Mismatched account ID → 400 error
- Full token lifecycle (pending → in_progress → completed)

These tests validate that removing the dead code does not change behavior.

## References

- Ticket: `memory-bank/tickets/2026-01-17/01-connect-callback-dead-code.md`
- Source: `backend/src/routes/connect.ts` (lines 226-326)
- Tests: `backend/src/__tests__/integration/connect-callback-state.test.ts`

---

## Alternative Option (Not Recommended)

Instead of removing the dead code, we could add a comment explaining why the `else` branch exists. **Not recommended** because dead code increases maintenance burden and confusion.

---

## Summary

| Item | Value |
|------|-------|
| Plan Path | `memory-bank/plan/2026-01-17_22-45-30_connect-callback-dead-code.md` |
| Milestones | 2 |
| Tasks | 3 |
| Gates | Existing tests must pass |
| Next Command | `/ce-ex memory-bank/plan/2026-01-17_22-45-30_connect-callback-dead-code.md` |
