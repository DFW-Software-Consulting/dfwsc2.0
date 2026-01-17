---
title: "Onboarding Token Completion Timing – Plan"
phase: Plan
date: "2026-01-16_10-21-30"
owner: "claude-agent"
parent_research: "memory-bank/tickets/2026-01-14_review-findings/03-onboarding-token-completion.md"
git_commit_at_plan: "85afae0"
tags: [plan, onboarding, token-lifecycle, stripe-connect]
---

## Goal

**Move the onboarding token status update from `completed` BEFORE Stripe onboarding to AFTER successful Stripe callback validation.** The token should only be marked `completed` when Stripe confirms the client has finished onboarding, not when they merely click the onboarding link.

**Non-goals:**
- Full token expiry/reissue workflow (separate ticket)
- Adding new token statuses beyond `pending` → `in_progress` → `completed`

## Scope & Assumptions

### In Scope
- Change token status flow: `pending` → `in_progress` (at `/onboard-client`) → `completed` (at `/connect/callback`)
- Add logging for token status transitions
- Update existing integration tests

### Out of Scope
- Token expiry/cleanup logic (tracked separately)
- Email notifications for status changes
- Admin UI for token management

### Assumptions
- The state parameter mechanism already validates callback authenticity (implemented in commit 85afae0)
- A new status `in_progress` is acceptable for tracking tokens that have started but not completed onboarding
- The schema already has `status` as a plain text field (no enum constraint in DB)

## Deliverables (DoD)

1. Token marked `in_progress` when user accesses `/onboard-client` endpoint
2. Token marked `completed` only in `/connect/callback` after successful Stripe account linkage
3. Logging for all token status transitions (status, timestamp, token_id)
4. Integration test validating the complete lifecycle: `pending` → `in_progress` → `completed`

## Readiness (DoR)

- [x] Database schema supports status field (text, no enum constraint)
- [x] State parameter validation already implemented
- [x] Integration test infrastructure exists
- [x] Docker environment running and accessible

## Milestones

- **M1: Core Logic** - Update `/onboard-client` to set `in_progress`, update `/connect/callback` to set `completed`
- **M2: Logging** - Add structured logging for status transitions
- **M3: Test** - Update/add integration test for full lifecycle

## Work Breakdown (Tasks)

### Task 1: Update `/onboard-client` to set status `in_progress`
- **Summary:** Change line 172 in `connect.ts` from `status: 'completed'` to `status: 'in_progress'`
- **Owner:** executor
- **Dependencies:** None
- **Target Milestone:** M1
- **Acceptance Tests:**
  - Token status is `in_progress` after calling `/onboard-client`
  - Token status is NOT `completed` after calling `/onboard-client`
- **Files/Interfaces:**
  - `backend/src/routes/connect.ts:172` - change status value

### Task 2: Update `/connect/callback` to set status `completed`
- **Summary:** Add token status update to `completed` in the callback handler after successful validation
- **Owner:** executor
- **Dependencies:** Task 1
- **Target Milestone:** M1
- **Acceptance Tests:**
  - Token status changes from `in_progress` to `completed` after successful callback
  - Status update occurs AFTER Stripe account linkage
- **Files/Interfaces:**
  - `backend/src/routes/connect.ts:247` - add status update before redirect

### Task 3: Add logging for token status transitions
- **Summary:** Add `request.log.info()` calls when token status changes
- **Owner:** executor
- **Dependencies:** Tasks 1, 2
- **Target Milestone:** M2
- **Acceptance Tests:**
  - Log entry emitted when status changes to `in_progress`
  - Log entry emitted when status changes to `completed`
  - Logs include: token_id, old_status, new_status, timestamp
- **Files/Interfaces:**
  - `backend/src/routes/connect.ts` - add logging in both endpoints

### Task 4: Integration test for token lifecycle
- **Summary:** Add/update integration test to verify `pending` → `in_progress` → `completed` flow
- **Owner:** executor
- **Dependencies:** Tasks 1, 2, 3
- **Target Milestone:** M3
- **Acceptance Tests:**
  - Test creates token, verifies `pending`
  - Test calls `/onboard-client`, verifies `in_progress`
  - Test calls `/connect/callback`, verifies `completed`
- **Files/Interfaces:**
  - `backend/src/__tests__/integration/connect-callback-state.test.ts` - extend existing tests

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| Existing tests rely on `completed` status at `/onboard-client` | High | Medium | Update all existing tests to expect `in_progress` | Test failures |
| Abandoned tokens stuck in `in_progress` forever | Low | Medium | Out of scope - tracked in separate ticket | N/A |

## Test Strategy

**Single Integration Test:**
One comprehensive test that validates the complete token lifecycle:
1. Create client with token (verify `pending`)
2. Call `/onboard-client` (verify `in_progress`, state generated)
3. Call `/connect/callback` with valid state (verify `completed`)

This extends the existing `connect-callback-state.test.ts` with lifecycle verification.

## References

- Ticket: `memory-bank/tickets/2026-01-14_review-findings/03-onboarding-token-completion.md`
- Current implementation: `backend/src/routes/connect.ts:164-176` (sets completed at /onboard-client)
- Callback handler: `backend/src/routes/connect.ts:193-254`
- Existing tests: `backend/src/__tests__/integration/connect-callback-state.test.ts`
- Related plan: `memory-bank/plan/2026-01-16_08-33-52_secure-connect-callback.md` (state validation - completed)

## Alternative Approach (Not Recommended)

**Option B: Keep binary `pending`/`completed` status**
- Only mark `completed` at callback, leave as `pending` during onboarding
- Simpler but less visibility into abandoned tokens
- Rejected because: Cannot distinguish between "never started" and "started but abandoned"

---

## Final Gate

| Item | Value |
|------|-------|
| Plan Path | `memory-bank/plan/2026-01-16_10-21-30_onboarding-token-completion-timing.md` |
| Milestones | 3 (M1: Core Logic, M2: Logging, M3: Test) |
| Tasks | 4 |
| Gates | Task dependencies enforced; tests must pass |
| Next Command | `/cc-ex "memory-bank/plan/2026-01-16_10-21-30_onboarding-token-completion-timing.md"` |
