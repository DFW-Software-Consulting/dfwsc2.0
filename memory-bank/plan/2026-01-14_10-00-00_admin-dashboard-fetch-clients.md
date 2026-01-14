---
title: "Admin Dashboard Client Fetch – Plan"
phase: Plan
date: "2026-01-14_10-00-00"
owner: "opencode"
parent_research: "memory-bank/tickets/07-admin-dashboard-fetch-clients.md"
git_commit_at_plan: "41301a1"
tags: [plan, admin-dashboard, client-fetch]
---

## Goal
Ensure clients are automatically fetched after admin login and when a stored token is detected, eliminating the need for manual refresh.

## Scope & Assumptions
- **In Scope**: Modify `AdminDashboard.jsx` to call `fetchClients` after login and token detection
- **Out of Scope**: Changes to backend API, authentication logic, or other components
- **Assumptions**: 
  - `fetchClients` function already works correctly
  - Token storage/retrieval via `sessionStorage` is stable
  - No breaking changes to existing functionality

## Deliverables (DoD)
- Clients load automatically after successful login
- Clients load automatically when page refreshes with a valid token
- No manual refresh required for initial data load
- Existing functionality remains intact

## Readiness (DoR)
- Codebase is in a stable state (commit 41301a1)
- `AdminDashboard.jsx` is accessible and readable
- `fetchClients` function exists and is functional
- No pending breaking changes to authentication flow

## Milestones
- M1: Identify and document current issues
- M2: Implement automatic client fetch after login
- M3: Implement automatic client fetch on token detection
- M4: Test and verify functionality

## Work Breakdown (Tasks)

### Task 1: Analyze Current Implementation
- **Summary**: Review current `useEffect` and `handleLoginSuccess` implementations
- **Owner**: opencode
- **Estimate**: 5 minutes
- **Dependencies**: None
- **Target Milestone**: M1
- **Acceptance Tests**:
  - Current `useEffect` only checks for token but doesn't fetch clients
  - `handleLoginSuccess` only sets `isLoggedIn` but doesn't fetch clients
- **Files/Interfaces**: `AdminDashboard.jsx`

### Task 2: Fix Login Success Flow
- **Summary**: Modify `handleLoginSuccess` to call `fetchClients` after setting `isLoggedIn`
- **Owner**: opencode
- **Estimate**: 10 minutes
- **Dependencies**: Task 1
- **Target Milestone**: M2
- **Acceptance Tests**:
  - After login, `fetchClients` is called
  - Clients are populated in the UI without manual refresh
- **Files/Interfaces**: `AdminDashboard.jsx:77-79`

### Task 3: Fix Token Detection Flow
- **Summary**: Modify `useEffect` to call `fetchClients` when stored token is detected
- **Owner**: opencode
- **Estimate**: 10 minutes
- **Dependencies**: Task 1
- **Target Milestone**: M3
- **Acceptance Tests**:
  - On page load with valid token, `fetchClients` is called
  - Clients are populated in the UI without manual refresh
- **Files/Interfaces**: `AdminDashboard.jsx:14-19`

### Task 4: Verify No Breaking Changes
- **Summary**: Ensure existing functionality still works (logout, refresh, error handling)
- **Owner**: opencode
- **Estimate**: 15 minutes
- **Dependencies**: Tasks 2-3
- **Target Milestone**: M4
- **Acceptance Tests**:
  - Logout still clears state
  - Manual refresh still works
  - Error handling still functions
  - Session expiration still triggers logout
- **Files/Interfaces**: `AdminDashboard.jsx`

## Risks & Mitigations
- **Risk**: Calling `fetchClients` too frequently could cause performance issues
  - **Impact**: Medium (extra API calls)
  - **Likelihood**: Low (conditional checks in place)
  - **Mitigation**: Add early return in `fetchClients` if already loading
  - **Trigger**: Performance testing reveals issues

- **Risk**: Race conditions between token detection and login
  - **Impact**: Medium (potential duplicate fetches)
  - **Likelihood**: Low (token check happens once on mount)
  - **Mitigation**: Add loading state check before fetching
  - **Trigger**: Testing reveals duplicate API calls

## Test Strategy
- **Test**: Verify automatic fetch after login
  - Steps: Login as admin, observe clients load automatically
  - Expected: Clients appear without clicking refresh

## References
- Ticket: `memory-bank/tickets/07-admin-dashboard-fetch-clients.md`
- File: `/home/jeremy/jcFolder/dfwsc/dfwsc2.0/front/src/components/admin/AdminDashboard.jsx`
- Git commit: 41301a1
