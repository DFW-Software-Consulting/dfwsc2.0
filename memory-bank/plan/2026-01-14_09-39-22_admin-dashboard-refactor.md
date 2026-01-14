---
title: "Admin Dashboard Refactor – Plan"
phase: Plan
date: "2026-01-14_09-39-22"
owner: "claude-agent"
parent_research: "memory-bank/tickets/TICKET.md"
git_commit_at_plan: "bf81bbc"
tags: [plan, refactor, frontend, admin-dashboard]
---

## Goal

**Singular Focus:** Refactor `OnboardClient.jsx` (656 lines) into smaller, maintainable components while removing unused code and adding proper memoization.

**Non-Goals:**
- Backend pagination (Task 8) - out of scope for this plan
- Backend search/filter (Task 9) - out of scope
- Token invalidation mechanism (Task 10) - out of scope
- Full validation library integration - use simple inline validation

## Scope & Assumptions

### In Scope (from TICKET.md)
1. **Task 1**: Split OnboardClient.jsx into 5 components
2. **Task 2**: Remove unused `copySuccess` state variable
3. **Task 3**: Add `useCallback` memoization for 5 functions
4. **Task 4**: Add frontend input validation (password length, email format, name limits)
5. **Task 5**: Extract toast timeout to constant
6. **Task 6**: Add confirmation dialog for client deactivation
7. **Task 7**: Add per-row loading state for toggle buttons

### Out of Scope
- Tasks 8-10 (backend changes) - require separate plan
- External toast library integration - keep inline implementation
- Global state management - keep local useState pattern

### Assumptions
- Existing Tailwind CSS patterns will be followed
- Components go in `/front/src/components/admin/` subdirectory
- No breaking changes to API contracts
- sessionStorage auth pattern remains unchanged

### Constraints
- Must maintain existing functionality
- Must work within Docker environment
- No new dependencies unless absolutely necessary

## Deliverables (DoD)

| Deliverable | Acceptance Criteria |
|-------------|---------------------|
| `AdminLogin.jsx` | Standalone login form component with validation |
| `AdminDashboard.jsx` | Wrapper component managing auth state and layout |
| `ClientList.jsx` | Table with status management, per-row loading, confirmation modal |
| `CreateClientForm.jsx` | Form with validation, toast integration |
| `Toast.jsx` | Reusable toast with configurable timeout constant |
| `ConfirmModal.jsx` | Reusable confirmation dialog component |
| Clean `OnboardClient.jsx` | <150 lines, imports and composes above components |
| All functions memoized | `useCallback` on fetchClients, handleCreateClient, showToast, copyToClipboard, updateClientStatus |
| No unused code | `copySuccess` state removed |
| Input validation | Email regex, password min 8 chars, name 1-100 chars |

## Readiness (DoR)

- [x] Ticket with requirements exists (TICKET.md)
- [x] Current codebase analyzed and understood
- [x] Component patterns identified (Banner.jsx as reference)
- [x] Styling patterns identified (Tailwind dark theme)
- [x] Docker environment available for testing
- [x] Git branch exists (`client-status-db`)

## Milestones

### M1: Foundation (Create reusable primitives)
- Create `/front/src/components/admin/` directory
- Extract Toast.jsx with configurable timeout
- Create ConfirmModal.jsx component

### M2: Core Components (Extract main features)
- Extract AdminLogin.jsx with validation
- Extract CreateClientForm.jsx with validation
- Extract ClientList.jsx with per-row loading and confirmation

### M3: Integration (Wire everything together)
- Create AdminDashboard.jsx wrapper
- Refactor OnboardClient.jsx to compose components
- Add useCallback memoization to all functions
- Remove unused copySuccess state

### M4: Validation & Cleanup
- Manual testing in Docker environment
- Verify all functionality works end-to-end
- Code cleanup and final review

## Work Breakdown (Tasks)

### Task 1: Create Toast.jsx
**Milestone:** M1
**Dependencies:** None
**Files:** `/front/src/components/admin/Toast.jsx` (new)

**Implementation:**
- Extract toast rendering from OnboardClient.jsx:639-647
- Add `TOAST_TIMEOUT_MS` constant (default 5000)
- Props: `show`, `message`, `type`, `onClose`
- Support types: success, error, warning, info

**Acceptance Tests:**
- Toast renders with correct color per type
- Toast auto-dismisses after timeout
- Toast can be manually closed

---

### Task 2: Create ConfirmModal.jsx
**Milestone:** M1
**Dependencies:** None
**Files:** `/front/src/components/admin/ConfirmModal.jsx` (new)

**Implementation:**
- Modal overlay with backdrop blur
- Props: `isOpen`, `title`, `message`, `onConfirm`, `onCancel`, `confirmText`, `cancelText`
- Focus trap and escape key handling
- Match existing dark theme styling

**Acceptance Tests:**
- Modal opens/closes based on isOpen prop
- Confirm button triggers onConfirm callback
- Cancel button and backdrop click trigger onCancel
- Escape key closes modal

---

### Task 3: Create AdminLogin.jsx
**Milestone:** M2
**Dependencies:** Toast.jsx
**Files:** `/front/src/components/admin/AdminLogin.jsx` (new)

**Implementation:**
- Extract login form from OnboardClient.jsx:382-439
- Add password validation: minimum 8 characters
- Props: `onLoginSuccess`, `showToast`
- Manage own loading/error state

**Acceptance Tests:**
- Login form validates password length before submit
- Shows error message for invalid password
- Calls onLoginSuccess with token on success
- Shows loading state during API call

---

### Task 4: Create CreateClientForm.jsx
**Milestone:** M2
**Dependencies:** Toast.jsx
**Files:** `/front/src/components/admin/CreateClientForm.jsx` (new)

**Implementation:**
- Extract form from OnboardClient.jsx:452-555
- Add validation:
  - Email: regex pattern `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
  - Name: 1-100 characters
- Props: `onClientCreated`, `showToast`
- Display created client info (token, onboarding URL)

**Acceptance Tests:**
- Validates email format before submit
- Validates name length before submit
- Shows inline error messages
- Displays success info after creation
- Copy to clipboard works for token/URL

---

### Task 5: Create ClientList.jsx
**Milestone:** M2
**Dependencies:** Toast.jsx, ConfirmModal.jsx
**Files:** `/front/src/components/admin/ClientList.jsx` (new)

**Implementation:**
- Extract table from OnboardClient.jsx:557-636
- Add per-row loading state: `loadingClientId` state
- Integrate ConfirmModal for deactivation confirmation
- Props: `clients`, `onStatusChange`, `showToast`, `loading`, `error`
- Use `useCallback` for `updateClientStatus`

**Acceptance Tests:**
- Shows loading spinner on specific row being updated
- Confirmation modal appears before deactivation
- Activation does NOT require confirmation
- Optimistic update with rollback on error
- Handles empty state, loading state, error state

---

### Task 6: Create AdminDashboard.jsx
**Milestone:** M3
**Dependencies:** All M2 components
**Files:** `/front/src/components/admin/AdminDashboard.jsx` (new)

**Implementation:**
- Wrapper component managing:
  - `isLoggedIn` state
  - `clients` state
  - `toast` state
- Composes: AdminLogin, CreateClientForm, ClientList, Toast
- Handles logout functionality
- Uses `useCallback` for: fetchClients, showToast

**Acceptance Tests:**
- Shows login when not authenticated
- Shows dashboard when authenticated
- Logout clears session and shows login
- Toast notifications work across all child components

---

### Task 7: Refactor OnboardClient.jsx
**Milestone:** M3
**Dependencies:** AdminDashboard.jsx
**Files:** `/front/src/pages/OnboardClient.jsx` (modify)

**Implementation:**
- Remove all admin-related code
- Keep only client onboarding flow (token entry, handleSubmit)
- Import and render AdminDashboard component
- Remove unused `copySuccess` state
- Target: <150 lines

**Acceptance Tests:**
- Client onboarding flow works unchanged
- Admin dashboard renders and functions
- No unused state variables
- File size significantly reduced

---

### Task 8: Add Memoization
**Milestone:** M3
**Dependencies:** Task 7
**Files:** Multiple component files

**Implementation:**
- Wrap these with `useCallback`:
  - `fetchClients` in AdminDashboard.jsx
  - `handleCreateClient` in CreateClientForm.jsx
  - `showToast` in AdminDashboard.jsx
  - `copyToClipboard` in CreateClientForm.jsx
  - `updateClientStatus` in ClientList.jsx

**Acceptance Tests:**
- Functions maintain stable references across renders
- No unnecessary re-renders (verify with React DevTools)

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| Props drilling complexity | Medium | Medium | Keep component tree shallow, use composition | >3 levels of prop passing |
| Breaking existing functionality | High | Low | Manual E2E testing in Docker | Any workflow fails |
| Modal accessibility issues | Low | Medium | Add focus trap, aria labels, escape handling | Screen reader testing |
| State sync issues between components | Medium | Medium | Lift state to AdminDashboard, pass callbacks | Stale data after operations |

## Test Strategy

### Single Integration Test
Create ONE test that validates the refactored components work together:

**File:** `/front/src/components/admin/__tests__/AdminDashboard.test.jsx`

**Test:** "Admin dashboard renders login, authenticates, and displays client list"
- Mock fetch for login and clients endpoints
- Verify login form renders
- Submit login, verify dashboard appears
- Verify client list renders with mocked data

## Alternative Approach (Not Recommended)

**Option B: Incremental extraction without AdminDashboard wrapper**
- Extract components but keep state in OnboardClient.jsx
- Pros: Simpler, less refactoring
- Cons: OnboardClient.jsx stays large (~300 lines), prop drilling increases
- **Rejected:** Does not achieve the goal of clean separation

## References

- TICKET.md: `/home/jeremy/jcFolder/dfwsc/dfwsc2.0/memory-bank/tickets/TICKET.md`
- Current OnboardClient.jsx: `/home/jeremy/jcFolder/dfwsc/dfwsc2.0/front/src/pages/OnboardClient.jsx`
- Banner component pattern: `/home/jeremy/jcFolder/dfwsc/dfwsc2.0/front/src/components/Banner.jsx`
- Tailwind theme: `/home/jeremy/jcFolder/dfwsc/dfwsc2.0/front/src/index.css`

---

## Final Gate

| Metric | Value |
|--------|-------|
| Plan Path | `memory-bank/plan/2026-01-14_09-39-22_admin-dashboard-refactor.md` |
| Milestones | 4 (M1: Foundation, M2: Core Components, M3: Integration, M4: Validation) |
| Tasks | 8 |
| New Components | 6 (Toast, ConfirmModal, AdminLogin, CreateClientForm, ClientList, AdminDashboard) |
| Test Files | 1 |
| Gates | Manual Docker testing at M4 |

**Next Command:** `/execute "memory-bank/plan/2026-01-14_09-39-22_admin-dashboard-refactor.md"`
