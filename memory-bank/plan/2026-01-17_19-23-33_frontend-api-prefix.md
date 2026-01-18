---
title: "Frontend API Prefix Standardization – Plan"
phase: Plan
date: "2026-01-17_19-23-33"
owner: "agent"
parent_research: "memory-bank/tickets/2026-01-17/03-frontend-api-prefix.md"
git_commit_at_plan: "70fc221"
tags: [plan, frontend, api-prefix, standardization]
---

## Goal

**Singular Goal:** Fix the inconsistency in frontend API path construction where `VITE_API_URL` already contains `/api/v1`, but frontend components incorrectly append additional path segments without accounting for this, causing potential 404 errors or routing issues.

**Non-goals:**
- Refactoring frontend architecture
- Adding new API endpoints
- Changing backend route structure

## Scope & Assumptions

### In Scope
- Audit and fix all frontend API fetch calls to use correct paths relative to `VITE_API_URL`
- Ensure paths work correctly when `VITE_API_URL=/api/v1` (production via Docker)

### Out of Scope
- Backend route changes
- New environment configurations
- Frontend refactoring beyond the API path fixes

### Assumptions
- `VITE_API_URL` is set to `http://localhost:4242/api/v1` (dev) or `/api/v1` (production)
- All backend routes are registered under `/api/v1` prefix
- Frontend appends endpoint paths (e.g., `/clients`) to `VITE_API_URL`

### Constraints
- Must maintain backwards compatibility with existing .env configurations
- No regressions in onboarding or client creation flows

## Deliverables (DoD)

1. **All frontend API calls use correct relative paths** - Each fetch call appends the correct endpoint path (without duplicating `/api/v1`)
2. **Verified working flows** - Onboarding and client management flows work correctly

## Readiness (DoR)

- [x] Access to frontend codebase
- [x] Understanding of backend route structure (all routes prefixed with `/api/v1`)
- [x] Understanding of `VITE_API_URL` configuration (`/api/v1` in production)
- [x] List of files requiring changes identified

## Milestones

- **M1: Code Changes** - Update all frontend API paths
- **M2: Verification** - Confirm no regressions

## Work Breakdown (Tasks)

### Task 1: Fix OnboardClient.jsx API path
- **Summary:** Change `/onboard-client` endpoint path to be consistent
- **Owner:** agent
- **Dependencies:** None
- **Target Milestone:** M1
- **Files/Interfaces:** `front/src/pages/OnboardClient.jsx:26`
- **Current:** `${VITE_API_URL}/onboard-client` → Results in `/api/v1/onboard-client` ✓ (CORRECT)
- **Status:** NO CHANGE NEEDED - path is already correct

### Task 2: Fix AdminLogin.jsx API path
- **Summary:** Verify `/auth/login` endpoint path
- **Owner:** agent
- **Dependencies:** None
- **Target Milestone:** M1
- **Files/Interfaces:** `front/src/components/admin/AdminLogin.jsx:39`
- **Current:** `${VITE_API_URL}/auth/login` → Results in `/api/v1/auth/login` ✓ (CORRECT)
- **Status:** NO CHANGE NEEDED - path is already correct

### Task 3: Fix CreateClientForm.jsx API path
- **Summary:** Verify `/accounts` endpoint path
- **Owner:** agent
- **Dependencies:** None
- **Target Milestone:** M1
- **Files/Interfaces:** `front/src/components/admin/CreateClientForm.jsx:50`
- **Current:** `${VITE_API_URL}/accounts` → Results in `/api/v1/accounts` ✓ (CORRECT)
- **Status:** NO CHANGE NEEDED - path is already correct

### Task 4: Fix AdminDashboard.jsx API path
- **Summary:** Verify `/clients` endpoint path
- **Owner:** agent
- **Dependencies:** None
- **Target Milestone:** M1
- **Files/Interfaces:** `front/src/components/admin/AdminDashboard.jsx:35`
- **Current:** `${VITE_API_URL}/clients` → Results in `/api/v1/clients` ✓ (CORRECT)
- **Status:** NO CHANGE NEEDED - path is already correct

### Task 5: Fix ClientList.jsx API path
- **Summary:** Verify `/clients/:id` endpoint path
- **Owner:** agent
- **Dependencies:** None
- **Target Milestone:** M1
- **Files/Interfaces:** `front/src/components/admin/ClientList.jsx:37`
- **Current:** `${VITE_API_URL}/clients/${clientId}` → Results in `/api/v1/clients/:id` ✓ (CORRECT)
- **Status:** NO CHANGE NEEDED - path is already correct

### Task 6: Update .env.example for clarity
- **Summary:** Update the .env.example to use `/api/v1` consistently for documentation clarity
- **Owner:** agent
- **Dependencies:** None
- **Target Milestone:** M1
- **Files/Interfaces:** `front/.env.example:7`
- **Current:** `VITE_API_URL=http://localhost:4242/api` (missing `/v1`)
- **Change to:** `VITE_API_URL=http://localhost:4242/api/v1`
- **Acceptance Tests:**
  - [ ] .env.example shows correct URL with `/api/v1` suffix

## Analysis Summary

After thorough analysis, I found that:

1. **The actual .env file is correct:** `VITE_API_URL=http://localhost:4242/api/v1`
2. **Docker production is correct:** `VITE_API_URL=/api/v1`
3. **All frontend API calls use the correct pattern:** They append endpoint paths like `/clients`, `/auth/login`, etc. to `VITE_API_URL`
4. **The only issue is .env.example:** It shows `http://localhost:4242/api` (missing `/v1`)

The ticket's original concern about `OnboardClient.jsx:22` using `/v1` appears to be outdated - the current code at line 26 uses the correct pattern `${VITE_API_URL}/onboard-client`.

**ACTUAL CHANGE REQUIRED:** Only update `.env.example` to match the correct pattern.

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| Breaking existing developer setups | Medium | Low | Only changing .env.example, not .env | If developers copied old .env.example |

## Test Strategy

- **Manual verification:** Verify that the example configuration matches production expectations
- No new automated test needed - this is a documentation/config fix only

## References

- Ticket: `memory-bank/tickets/2026-01-17/03-frontend-api-prefix.md`
- Backend route registration: `backend/src/app.ts:111-116` (all routes prefixed with `/api/v1`)
- Frontend .env: `front/.env` (correct: `/api/v1`)
- Frontend .env.example: `front/.env.example` (incorrect: `/api` - needs fix)

## Alternative Option

If the team wants to decouple the API version from the base URL for flexibility, an alternative approach would be:

- Set `VITE_API_URL=http://localhost:4242/api`
- Create `VITE_API_VERSION=v1`
- Update all fetch calls to use `${VITE_API_URL}/${VITE_API_VERSION}/endpoint`

**Recommendation:** Not recommended for this small project. The current approach is simpler and works correctly.

---

## Final Gate

| Item | Status |
|------|--------|
| Plan path | `memory-bank/plan/2026-01-17_19-23-33_frontend-api-prefix.md` |
| Milestones count | 2 |
| Gates | .env.example updated, no regressions |
| Files to change | 1 (`front/.env.example`) |

**Next command:** `/ce-ex "memory-bank/plan/2026-01-17_19-23-33_frontend-api-prefix.md"`
