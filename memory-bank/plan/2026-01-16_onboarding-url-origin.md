---
title: "Onboarding URL Origin – Plan"
phase: Plan
date: "2026-01-16T12:00:00Z"
owner: "developer"
parent_research: "memory-bank/tickets/2026-01-14_review-findings/04-onboarding-url-origin.md"
git_commit_at_plan: "36fdf60"
tags: [plan, onboarding, frontend-origin, environment]
---

## Goal

Replace hard-coded `https://dfwsc.com/onboard` URLs in `connect.ts` with `FRONTEND_ORIGIN` environment variable to enable non-production environments (local dev, staging) to function correctly.

**Non-goals:**
- Refactoring the entire onboarding flow
- Adding new endpoints or features
- Changing callback URL handling (already uses `API_BASE_URL`)

## Scope & Assumptions

**In Scope:**
- Lines 57 and 92 in `backend/src/routes/connect.ts` where `onboardingUrlHint` and `onboardingUrl` are hard-coded
- Adding `FRONTEND_ORIGIN` validation with clear error message
- Updating documentation to reflect environment-dependent URLs

**Out of Scope:**
- The callback redirect at line 269 (already uses `FRONTEND_ORIGIN`)
- API base URL handling (already handled by `resolveServerBaseUrl()`)
- Frontend changes

**Assumptions:**
- `FRONTEND_ORIGIN` is already defined in env validation (`backend/src/lib/env.ts`)
- The pattern from `payments.ts:106-108` is the established pattern for validation
- Trailing slash trimming is required (consistent with existing code)

## Deliverables (DoD)

1. **Code Change**: Both `onboardingUrlHint` (line 57) and `onboardingUrl` (line 92) use `FRONTEND_ORIGIN` instead of hard-coded domain
2. **Validation**: Both endpoints return HTTP 500 with clear error if `FRONTEND_ORIGIN` is missing
3. **Documentation**: `backend/documentation/src/routes/accounts.md` updated to note `FRONTEND_ORIGIN` requirement
4. **Tests Pass**: Existing tests continue to pass; no new test required (coverage exists)

## Readiness (DoR)

- [x] `FRONTEND_ORIGIN` already in env validation list (`backend/src/lib/env.ts:9`)
- [x] Established pattern exists in `payments.ts:106-108`
- [x] Docker environment available for testing
- [x] Test environment sets `FRONTEND_ORIGIN` (`app.test.ts:360`)

## Milestones

| ID | Milestone | Description |
|----|-----------|-------------|
| M1 | Code Change | Update hard-coded URLs to use `FRONTEND_ORIGIN` |
| M2 | Validation | Add missing env var error handling |
| M3 | Documentation | Update API docs |
| M4 | Verification | Run tests, verify in Docker |

## Work Breakdown (Tasks)

### Task 1: Update `/accounts` endpoint (POST)
**Summary:** Replace hard-coded `onboardingUrlHint` with `FRONTEND_ORIGIN`
**Owner:** developer
**Dependencies:** None
**Target Milestone:** M1

**Files/Interfaces:**
- `backend/src/routes/connect.ts:38-65` (POST `/accounts` handler)

**Changes:**
1. Add `FRONTEND_ORIGIN` retrieval and validation before building URL
2. Replace line 57: `const onboardingUrlHint = \`https://dfwsc.com/onboard?token=\${token}\`;`
   → `const onboardingUrlHint = \`\${frontendOrigin}/onboard?token=\${token}\`;`

**Acceptance Tests:**
- [ ] Endpoint returns 500 with `{ error: 'FRONTEND_ORIGIN is not configured.' }` when env var missing
- [ ] Endpoint returns correct `onboardingUrlHint` using configured origin

---

### Task 2: Update `/onboard-client/initiate` endpoint (POST)
**Summary:** Replace hard-coded `onboardingUrl` with `FRONTEND_ORIGIN`
**Owner:** developer
**Dependencies:** None
**Target Milestone:** M1

**Files/Interfaces:**
- `backend/src/routes/connect.ts:68-123` (POST `/onboard-client/initiate` handler)

**Changes:**
1. Add `FRONTEND_ORIGIN` retrieval and validation before building URL
2. Replace line 92: `const onboardingUrl = \`https://dfwsc.com/onboard?token=\${token}\`;`
   → `const onboardingUrl = \`\${frontendOrigin}/onboard?token=\${token}\`;`

**Acceptance Tests:**
- [ ] Endpoint returns 500 with `{ error: 'FRONTEND_ORIGIN is not configured.' }` when env var missing
- [ ] Email sent contains correct onboarding URL using configured origin

---

### Task 3: Update documentation
**Summary:** Document `FRONTEND_ORIGIN` requirement for onboarding endpoints
**Owner:** developer
**Dependencies:** Task 1, Task 2
**Target Milestone:** M3

**Files/Interfaces:**
- `backend/documentation/src/routes/accounts.md`

**Changes:**
- Add `FRONTEND_ORIGIN` as required env var for POST `/accounts` and `/onboard-client/initiate`
- Note that onboarding URLs are built from this variable

**Acceptance Tests:**
- [ ] Documentation accurately reflects new requirement

---

### Task 4: Verification
**Summary:** Run tests and verify in Docker
**Owner:** developer
**Dependencies:** Task 1, Task 2, Task 3
**Target Milestone:** M4

**Commands:**
```bash
docker-compose up -d --build
docker exec -it dfwsc20-api-1 npm test
```

**Acceptance Tests:**
- [ ] All existing tests pass
- [ ] Manual verification: POST `/accounts` returns URL with correct origin
- [ ] Manual verification: POST `/onboard-client/initiate` sends email with correct URL

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| Breaking existing tests | Medium | Low | Tests already set `FRONTEND_ORIGIN`; follow existing pattern | Test failures |
| Production deployment without env var | High | Low | Clear error message guides operators; env var already documented | 500 errors on these endpoints |

## Test Strategy

**No new test required.** Existing test infrastructure:
- `app.test.ts` sets `FRONTEND_ORIGIN=http://localhost:5173`
- Existing tests for these endpoints will validate the change
- Pattern matches `payments.ts` which has test coverage for missing `FRONTEND_ORIGIN`

If validation confirms no test covers the 500 error case for these specific endpoints, add ONE test for the `/accounts` endpoint missing `FRONTEND_ORIGIN` scenario.

## References

- Ticket: `memory-bank/tickets/2026-01-14_review-findings/04-onboarding-url-origin.md`
- Existing pattern: `backend/src/routes/payments.ts:106-108`
- Target file: `backend/src/routes/connect.ts:57,92`
- Env validation: `backend/src/lib/env.ts:9`

## Alternative Approach (Not Recommended)

**Option B: Create a shared helper function**

Instead of inline validation in each handler, create a helper like `resolveFrontendOrigin()` that throws/returns error.

**Why not chosen:** Over-engineering for two usages. The inline pattern from `payments.ts` is simple, readable, and consistent with existing code. A helper adds indirection without meaningful benefit.

---

## Summary

| Item | Value |
|------|-------|
| **Plan Path** | `memory-bank/plan/2026-01-16_onboarding-url-origin.md` |
| **Milestones** | 4 (Code, Validation, Docs, Verification) |
| **Tasks** | 4 |
| **Gates** | Tests pass, manual Docker verification |
| **Estimated Files Changed** | 2 (`connect.ts`, `accounts.md`) |

**Next Command:** `/ce-ex "memory-bank/plan/2026-01-16_onboarding-url-origin.md"`
