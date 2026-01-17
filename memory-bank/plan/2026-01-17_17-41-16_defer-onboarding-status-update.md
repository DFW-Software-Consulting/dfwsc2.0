---
title: "Defer Onboarding Token Status Update – Plan"
phase: Plan
date: "2026-01-17T17:41:16"
owner: "claude-agent"
parent_research: "memory-bank/tickets/2026-01-14_review-findings/14-onboarding-token-status-after-link.md"
git_commit_at_plan: "ef4f45c"
tags: [plan, onboarding, stripe, error-handling]
---

## Goal

**Defer the onboarding token status update from `pending` to `in_progress` until AFTER `stripe.accountLinks.create()` succeeds**, preventing permanent blocking of onboarding when Stripe API fails.

**Non-goals:**
- Adding retry UI flows in frontend
- Implementing a new `failed` status (out of scope for this ticket)
- Complex retry/backoff mechanisms

## Scope & Assumptions

**In Scope:**
- Move status update to after successful `stripe.accountLinks.create()` call
- Add try/catch error handling around the Stripe API call
- Return appropriate error response when Stripe fails (allowing client to retry)
- Add ONE test for Stripe API failure scenario

**Out of Scope:**
- Frontend changes
- New database migrations (no schema changes needed)
- Implementing exponential backoff or automatic retries
- Adding a `failed` status to the token lifecycle

**Assumptions:**
- Token remains `pending` on failure, allowing immediate retry
- Existing `/api/v1/onboard-client` endpoint query already filters by `status = 'pending'`
- State parameter and expiration should still be set atomically with status update

## Deliverables (DoD)

1. **Code Change:** `backend/src/routes/connect.ts` modified to defer status update
   - Status update moved after `stripe.accountLinks.create()` succeeds
   - Try/catch wrapper returns 502 error on Stripe failure
   - Token remains `pending` on failure (retryable)

2. **Test:** ONE integration test verifying retry-ability after Stripe failure
   - Mock `stripe.accountLinks.create` to reject
   - Verify token status remains `pending`
   - Verify subsequent retry succeeds

## Readiness (DoR)

- [x] Access to codebase and Docker environment
- [x] Understanding of current flow (lines 173-207 in connect.ts)
- [x] Test patterns documented (Vitest + Stripe mocking)
- [x] No database schema changes required

## Milestones

| Milestone | Description |
|-----------|-------------|
| M1 | Refactor `/onboard-client` handler to defer status update |
| M2 | Add test for Stripe failure + retry scenario |
| M3 | Verify in Docker environment |

## Work Breakdown (Tasks)

### Task 1: Refactor onboard-client handler
**Owner:** Executor
**Target Milestone:** M1
**Dependencies:** None

**Summary:** Restructure the `/onboard-client` GET handler to:
1. Call `stripe.accountLinks.create()` first (wrapped in try/catch)
2. Only update token status to `in_progress` on success
3. Return 502 Bad Gateway on Stripe API failure

**Files/Interfaces:**
- `backend/src/routes/connect.ts` (lines 173-207)

**Acceptance Tests:**
- [ ] On Stripe success: token status updated to `in_progress`, account link URL returned
- [ ] On Stripe failure: token status remains `pending`, 502 error returned
- [ ] State parameter and expiration set atomically with status update

**Implementation Notes:**
```typescript
// BEFORE (current - problematic):
// 1. Update status to in_progress
// 2. Call stripe.accountLinks.create()

// AFTER (target - safe):
// 1. Generate state + expiration
// 2. Try: call stripe.accountLinks.create()
// 3. On success: update status to in_progress with state
// 4. On failure: log error, return 502 (token stays pending)
```

---

### Task 2: Add Stripe failure retry test
**Owner:** Executor
**Target Milestone:** M2
**Dependencies:** Task 1

**Summary:** Add ONE integration test that:
1. Creates a client and pending onboarding token
2. Mocks `stripe.accountLinks.create` to reject on first call
3. Verifies token remains `pending` and error response returned
4. Mocks success on second call
5. Verifies retry succeeds and status becomes `in_progress`

**Files/Interfaces:**
- `backend/src/__tests__/integration/connect-token-lifecycle.test.ts` (add test case)

**Acceptance Tests:**
- [ ] Test mocks Stripe failure correctly
- [ ] Test verifies token status is `pending` after failure
- [ ] Test verifies retry succeeds
- [ ] Test passes in CI/Docker environment

---

### Task 3: Docker validation
**Owner:** Executor
**Target Milestone:** M3
**Dependencies:** Task 1, Task 2

**Summary:** Run full test suite in Docker and verify no regressions.

**Acceptance Tests:**
- [ ] `docker exec -it dfwsc20-api-1 npm test` passes
- [ ] Existing connect-token-lifecycle tests still pass
- [ ] Existing connect-callback-state tests still pass

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| State/expiration set but Stripe fails | Medium | Low | Generate state before Stripe call, only persist on success | Stripe API error |
| Race condition on retry | Low | Low | Token query filters by `pending` status | Concurrent requests |
| Test flakiness | Low | Low | Use deterministic mocks, no timing dependencies | CI failures |

## Test Strategy

**ONE new test** to be added to `connect-token-lifecycle.test.ts`:

```typescript
it('allows retry when stripe.accountLinks.create fails', async () => {
  // 1. Create client + pending token
  // 2. Mock stripe.accountLinks.create to reject
  // 3. Call /onboard-client - expect 502
  // 4. Verify token still pending
  // 5. Mock stripe.accountLinks.create to resolve
  // 6. Call /onboard-client - expect success
  // 7. Verify token is in_progress
});
```

## References

- Ticket: `memory-bank/tickets/2026-01-14_review-findings/14-onboarding-token-status-after-link.md`
- Current implementation: `backend/src/routes/connect.ts:173-207`
- Existing tests: `backend/src/__tests__/integration/connect-token-lifecycle.test.ts`
- Test patterns: `backend/src/__tests__/integration/connect-callback-state.test.ts`

---

## Alternative Approach (Not Recommended)

**Rollback on failure:** Instead of deferring the update, update to `in_progress` first, then rollback to `pending` if Stripe fails.

**Why not chosen:**
- More complex (2 DB writes on failure path)
- Race condition window between update and rollback
- Deferring is simpler and achieves same goal

---

## Final Gate

| Item | Value |
|------|-------|
| Plan Path | `memory-bank/plan/2026-01-17_17-41-16_defer-onboarding-status-update.md` |
| Milestones | 3 |
| Tasks | 3 |
| Tests | 1 new integration test |
| Next Command | `/ce-ex "memory-bank/plan/2026-01-17_17-41-16_defer-onboarding-status-update.md"` |
