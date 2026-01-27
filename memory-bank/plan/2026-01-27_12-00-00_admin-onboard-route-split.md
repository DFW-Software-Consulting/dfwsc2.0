---
title: "Admin/Onboard Route Split – Plan"
phase: Plan
date: "2026-01-27T12:00:00-06:00"
owner: "developer"
parent_research: "memory-bank/tickets/2026-01-27_admin-onboard-route-split.md"
git_commit_at_plan: "cdebcb7"
tags: [plan, routing, admin, onboard, frontend]
---

## Goal

**Split the `/onboard` page into two dedicated routes:**
- `/admin` — Admin login + dashboard (client management)
- `/onboard` — Client-only token onboarding flow

**Non-goals:**
- No backend API changes
- No new authentication mechanisms
- No changes to Stripe integration logic

## Scope & Assumptions

### In Scope
- Create new `/admin` route in React Router
- Extract admin components from `OnboardClient.jsx` to new `AdminPage.jsx`
- Simplify `OnboardClient.jsx` to client-only token flow
- Preserve all existing functionality (just relocate)

### Out of Scope
- Backend modifications
- New UI components
- Navigation links between routes (marked optional in ticket)
- Mobile responsiveness changes

### Assumptions
- JWT storage in `sessionStorage` as `adminToken` remains unchanged
- All admin components (`AdminDashboard`, `AdminLogin`, etc.) are reusable as-is
- No CORS changes needed (same origin)

## Deliverables (DoD)

| Artifact | Acceptance Criteria |
|----------|---------------------|
| `/admin` route | Renders `AdminLogin` when logged out; renders `AdminDashboard` when logged in |
| `/onboard` route | Renders only client token input UI; no admin components visible |
| Existing tests pass | `npm test` in `/front` passes |
| Manual QA | Admin login works at `/admin`; token onboarding works at `/onboard?token=...` |

## Readiness (DoR)

- [x] Docker environment running (`docker-compose up -d`)
- [x] Current codebase analyzed and understood
- [x] No blocking drift detected in recent commits
- [x] Ticket requirements clear

## Milestones

| ID | Milestone | Description |
|----|-----------|-------------|
| M1 | Route Setup | Add `/admin` route to `App.jsx` |
| M2 | Admin Page | Create `AdminPage.jsx` with admin dashboard |
| M3 | Simplify Onboard | Remove admin section from `OnboardClient.jsx` |
| M4 | Validation | Run tests and manual QA |

## Work Breakdown (Tasks)

### Task 1: Add /admin route to App.jsx
- **Summary:** Register new `/admin` route in React Router configuration
- **Owner:** developer
- **Dependencies:** None
- **Target Milestone:** M1
- **Files/Interfaces:**
  - `front/src/App.jsx` — Add route entry
- **Acceptance Tests:**
  - [ ] `/admin` URL is accessible and renders without error

### Task 2: Create AdminPage.jsx
- **Summary:** Create new page component that renders `AdminDashboard`
- **Owner:** developer
- **Dependencies:** Task 1
- **Target Milestone:** M2
- **Files/Interfaces:**
  - `front/src/pages/AdminPage.jsx` — New file
- **Acceptance Tests:**
  - [ ] `AdminPage` imports and renders `AdminDashboard` component
  - [ ] Page title set to "Admin Dashboard" or similar

### Task 3: Simplify OnboardClient.jsx
- **Summary:** Remove admin dashboard section, keep only client token flow
- **Owner:** developer
- **Dependencies:** Task 2
- **Target Milestone:** M3
- **Files/Interfaces:**
  - `front/src/pages/OnboardClient.jsx` — Remove admin imports and rendering
- **Acceptance Tests:**
  - [ ] No admin components rendered on `/onboard`
  - [ ] Token input and verification still works
  - [ ] URL parameter `?token=...` auto-fills input

### Task 4: Run tests and validate
- **Summary:** Ensure existing tests pass and perform manual QA
- **Owner:** developer
- **Dependencies:** Task 3
- **Target Milestone:** M4
- **Files/Interfaces:**
  - None (validation only)
- **Acceptance Tests:**
  - [ ] `cd front && npm test` passes
  - [ ] Manual: `/admin` shows login form → dashboard after login
  - [ ] Manual: `/onboard?token=abc` shows token UI and processes token

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| Existing tests reference `/onboard` admin behavior | Medium | Low | Review test file before changes | Test failures |
| Hardcoded routes in components | Low | Low | Search for `/onboard` strings | Navigation breaks |

## Test Strategy

**Single validation test:** Ensure the existing `front/src/__tests__/coreFlows.test.jsx` passes after changes. No new tests required for this refactor as it's a structural change with no new logic.

## References

- Ticket: `memory-bank/tickets/2026-01-27_admin-onboard-route-split.md`
- Current routing: `front/src/App.jsx:25`
- OnboardClient page: `front/src/pages/OnboardClient.jsx`
- Admin components: `front/src/components/admin/`

---

## Alternative Approach (Not Recommended)

**Option B: Conditional rendering with URL check**
- Keep single `/onboard` route
- Use URL path or query param to toggle admin vs client view
- **Why not chosen:** Violates separation of concerns; ticket explicitly requests separate routes

---

## Final Gate

| Item | Value |
|------|-------|
| Plan path | `memory-bank/plan/2026-01-27_12-00-00_admin-onboard-route-split.md` |
| Milestones | 4 |
| Tasks | 4 |
| Gates | Tests pass + Manual QA |
| Estimated files changed | 3 (App.jsx, AdminPage.jsx [new], OnboardClient.jsx) |

**Next command:** `/ce-ex "memory-bank/plan/2026-01-27_12-00-00_admin-onboard-route-split.md"`
