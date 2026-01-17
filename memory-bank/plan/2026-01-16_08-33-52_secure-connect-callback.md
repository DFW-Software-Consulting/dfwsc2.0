---
title: "Secure Connect Callback – Plan"
phase: Plan
date: "2026-01-16T08:33:52"
owner: "agent"
parent_research: "memory-bank/tickets/2026-01-14_review-findings/02-secure-connect-callback.md"
git_commit_at_plan: "28cda26"
tags: [plan, security, connect-callback, oauth-state]
---

## Goal

Harden the `/connect/callback` endpoint so that Stripe account linkage cannot be overwritten by arbitrary callers. Implement CSRF-style state parameter validation to ensure only legitimate onboarding flows can update a client's `stripeAccountId`.

**Non-goals:**
- Changing the onboarding token flow (already secure)
- Adding new authentication mechanisms beyond state validation
- Modifying the Stripe account creation logic

## Scope & Assumptions

**In scope:**
- Generate and store a cryptographically secure `state` parameter when creating Stripe account links
- Validate `state` on callback before updating `stripeAccountId`
- Verify the returned Stripe `account` matches what we expect for the client
- Handle invalid/expired state with proper error responses

**Out of scope:**
- Changes to `/onboard-client/initiate` endpoint
- Changes to onboarding email flow
- Frontend changes (callback redirects to frontend success page)

**Assumptions:**
- The `onboardingTokens` table can be extended with a `state` column
- State tokens should have short expiry (15-30 minutes)
- We can leverage existing `crypto` module already imported in `connect.ts`

**Constraints:**
- Must not break existing onboarding flow
- Must work within Docker environment
- Migration must be backwards-compatible

## Deliverables (DoD)

| Artifact | Acceptance Criteria |
|----------|---------------------|
| DB migration | New `state` and `state_expires_at` columns added to `onboarding_tokens` |
| State generation | `/onboard-client` generates signed state, stores in DB with 30-min expiry |
| Callback validation | `/connect/callback` validates state, rejects invalid/expired/missing state |
| Stripe account verification | Callback verifies `account` param matches client's expected `stripeAccountId` |
| Integration test | One test covering valid state flow and rejection of invalid state |

## Readiness (DoR)

- [x] Research doc reviewed (`02-secure-connect-callback.md`)
- [x] Current `connect.ts` implementation analyzed (lines 125-196)
- [x] DB schema understood (`onboardingTokens` table structure)
- [x] Test patterns identified (see `payments-api-key.test.ts`)
- [x] Docker environment available

## Milestones

| Milestone | Description |
|-----------|-------------|
| M1 | Schema migration for `state` + `state_expires_at` columns |
| M2 | State generation in `/onboard-client` endpoint |
| M3 | State validation in `/connect/callback` endpoint |
| M4 | Integration test |

## Work Breakdown (Tasks)

### Task 1: Add state columns to onboarding_tokens
- **Summary:** Create Drizzle migration adding `state` (text) and `state_expires_at` (timestamp) columns
- **Owner:** agent
- **Dependencies:** None
- **Target Milestone:** M1
- **Files/Interfaces:**
  - `backend/src/db/schema.ts` – add columns to `onboardingTokens`
  - `backend/drizzle/0002_connect_state.sql` – new migration file
- **Acceptance Tests:**
  - Migration runs without error in Docker
  - Schema reflects new nullable columns

### Task 2: Generate state parameter in /onboard-client
- **Summary:** Generate cryptographic state token when creating Stripe account link, store in `onboardingTokens`, include in callback URL
- **Owner:** agent
- **Dependencies:** Task 1
- **Target Milestone:** M2
- **Files/Interfaces:**
  - `backend/src/routes/connect.ts:125-180` – modify `/onboard-client` handler
- **Acceptance Tests:**
  - State is 64-char hex string
  - State stored in DB with 30-minute expiry
  - Callback URL includes `state` query param

### Task 3: Validate state in /connect/callback
- **Summary:** Extract state from query params, validate against DB, check expiry, verify Stripe account matches client
- **Owner:** agent
- **Dependencies:** Task 2
- **Target Milestone:** M3
- **Files/Interfaces:**
  - `backend/src/routes/connect.ts:182-196` – modify `/connect/callback` handler
- **Acceptance Tests:**
  - Missing state returns 400
  - Invalid state returns 400
  - Expired state returns 400
  - Mismatched account returns 400
  - Valid state + account proceeds to redirect

### Task 4: Integration test
- **Summary:** Write integration test covering secure callback flow
- **Owner:** agent
- **Dependencies:** Task 3
- **Target Milestone:** M4
- **Files/Interfaces:**
  - `backend/src/__tests__/integration/connect-callback-state.test.ts` – new test file
- **Acceptance Tests:**
  - Test validates rejection of requests without valid state

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| Breaking existing onboarding flow | High | Low | Thorough testing in Docker before merge | Test failure |
| State expiry too short for slow users | Medium | Low | Use 30-minute expiry, log for monitoring | User complaints |
| Migration fails on existing data | Medium | Low | Columns are nullable, no data transformation needed | Migration error |

## Test Strategy

**Single Integration Test:**
- Test file: `backend/src/__tests__/integration/connect-callback-state.test.ts`
- Coverage: Validates that `/connect/callback` rejects requests without valid state parameter
- Pattern: Follow existing `payments-api-key.test.ts` structure

## References

- Research doc: `memory-bank/tickets/2026-01-14_review-findings/02-secure-connect-callback.md`
- Current implementation: `backend/src/routes/connect.ts:125-196`
- DB schema: `backend/src/db/schema.ts:25-33`
- Test pattern: `backend/src/__tests__/integration/payments-api-key.test.ts`

---

## Final Gate

| Item | Value |
|------|-------|
| Plan path | `memory-bank/plan/2026-01-16_08-33-52_secure-connect-callback.md` |
| Milestones | 4 |
| Gates | Schema migration → State generation → State validation → Integration test |
| Next command | `/ce-ex "memory-bank/plan/2026-01-16_08-33-52_secure-connect-callback.md"` |
