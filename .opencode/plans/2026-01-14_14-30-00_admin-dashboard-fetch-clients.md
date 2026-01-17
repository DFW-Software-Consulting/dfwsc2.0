---
title: "Admin Dashboard Auto-Fetch Clients – Plan"
phase: Plan
date: 2026-01-14_14-30-00
owner: opencode
parent_research: "memory-bank/tickets/07-admin-dashboard-fetch-clients.md"
git_commit_at_plan: "41301a1"
tags: [plan, admin-dashboard, frontend, react]
---

## Goal
Ensure clients are automatically fetched after admin login or when a stored token is detected, eliminating the need for manual refresh.

## Scope & Assumptions
- **In Scope**: Modify `AdminDashboard.jsx` to call `fetchClients` after login success and when a stored token is detected in `useEffect`.
- **Out of Scope**: Changes to backend API, authentication logic, or other components.
- **Assumptions**: The `fetchClients` function is already implemented and works correctly. The `handleLoginSuccess` callback is called after successful login.

## Deliverables (DoD)
- Clients are automatically fetched after successful login.
- Clients are automatically fetched when a stored token is detected on page load.
- No manual refresh required for returning admins with valid tokens.

## Readiness (DoR)
- Access to `/front/src/components/admin/AdminDashboard.jsx`.
- Docker environment running for testing.
- Existing `fetchClients` function is functional.

## Milestones
- **M1**: Identify and modify the `handleLoginSuccess` function to call `fetchClients`.
- **M2**: Update the `useEffect` hook to call `fetchClients` when a stored token is detected.
- **M3**: Test the changes in the Docker environment to ensure clients load automatically.

## Work Breakdown (Tasks)

### Task 1: Modify `handleLoginSuccess`
- **Summary**: Update `handleLoginSuccess` to call `fetchClients` after setting `isLoggedIn` to `true`.
- **Owner**: opencode
- **Estimate**: 5 minutes
- **Dependencies**: None
- **Target Milestone**: M1
- **Acceptance Tests**:
  - After login, clients are fetched automatically.
  - No manual refresh is required.
- **Files/Interfaces**: `/front/src/components/admin/AdminDashboard.jsx`

### Task 2: Update `useEffect` for Token Detection
- **Summary**: Modify the `useEffect` hook to call `fetchClients` when a stored token is detected.
- **Owner**: opencode
- **Estimate**: 5 minutes
- **Dependencies**: None
- **Target Milestone**: M2
- **Acceptance Tests**:
  - On page load with a stored token, clients are fetched automatically.
  - No manual refresh is required.
- **Files/Interfaces**: `/front/src/components/admin/AdminDashboard.jsx`

### Task 3: Test Changes
- **Summary**: Verify that clients load automatically after login and on page load with a stored token.
- **Owner**: opencode
- **Estimate**: 10 minutes
- **Dependencies**: Task 1 and Task 2
- **Target Milestone**: M3
- **Acceptance Tests**:
  - Test login flow and verify clients are fetched automatically.
  - Test page refresh with stored token and verify clients are fetched automatically.
- **Files/Interfaces**: `/front/src/components/admin/AdminDashboard.jsx`

## Risks & Mitigations
- **Risk**: Calling `fetchClients` too frequently may cause performance issues.
  - **Impact**: High
  - **Likelihood**: Low
  - **Mitigation**: Ensure `fetchClients` is only called when necessary (after login or token detection).
  - **Trigger**: Performance issues reported during testing.

- **Risk**: Token validation fails silently, causing unexpected behavior.
  - **Impact**: Medium
  - **Likelihood**: Low
  - **Mitigation**: Ensure error handling in `fetchClients` is robust and logs errors appropriately.
  - **Trigger**: Errors reported during testing.

## Test Strategy
- Test login flow and verify clients are fetched automatically.
- Test page refresh with stored token and verify clients are fetched automatically.
- Verify that manual refresh still works as expected.

## References
- Ticket: `memory-bank/tickets/07-admin-dashboard-fetch-clients.md`
- File: `/front/src/components/admin/AdminDashboard.jsx`
