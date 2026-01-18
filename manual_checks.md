# Manual Checks - Client Status Toggle Functionality

## Overview
This document outlines the manual verification steps for the client status toggle functionality in the admin dashboard. This feature allows administrators to activate or deactivate client accounts directly from the client list view.

## Prerequisites
- Access to the admin dashboard
- Valid admin credentials with client management permissions
- At least one client account available for testing
- Browser with developer tools (optional, for monitoring network requests)

## Test Scenarios

### 1. Activate Client Account
**Objective**: Verify that admins can successfully activate an inactive client account.

**Steps**:
1. Navigate to the admin dashboard
2. Locate a client account with "inactive" status
3. Click the "Activate" button in the Actions column for that client
4. Observe the UI response (status indicator should change to "active", button text should change to "Deactivate")
5. Wait for the API request to complete
6. Verify that a success toast notification appears ("Client activated successfully")

**Expected Results**:
- Client status changes from "inactive" to "active" in the UI immediately
- Button text changes from "Activate" to "Deactivate"
- Green success toast notification appears
- If API fails, status should revert to "inactive"

### 2. Deactivate Client Account
**Objective**: Verify that admins can successfully deactivate an active client account.

**Steps**:
1. Navigate to the admin dashboard
2. Locate a client account with "active" status
3. Click the "Deactivate" button in the Actions column for that client
4. A confirmation modal should appear with details about the client
5. Click "Deactivate" in the confirmation modal
6. Observe the UI response (status indicator should change to "inactive", button text should change to "Activate")
7. Wait for the API request to complete
8. Verify that a success toast notification appears ("Client deactivated successfully")

**Expected Results**:
- Confirmation modal appears before deactivation
- Client status changes from "active" to "inactive" in the UI immediately
- Button text changes from "Deactivate" to "Activate"
- Red success toast notification appears
- If API fails, status should revert to "active"

### 3. Cancel Deactivation
**Objective**: Verify that admins can cancel the deactivation process.

**Steps**:
1. Navigate to the admin dashboard
2. Locate a client account with "active" status
3. Click the "Deactivate" button in the Actions column for that client
4. A confirmation modal should appear
5. Click "Cancel" in the confirmation modal
6. Observe that no changes occur to the client status

**Expected Results**:
- Confirmation modal closes
- Client status remains unchanged
- No API request is made
- No toast notification appears

### 4. Loading State During Toggle
**Objective**: Verify that appropriate loading indicators are shown during API requests.

**Steps**:
1. Navigate to the admin dashboard
2. Locate a client account with "active" status
3. Click the "Deactivate" button in the Actions column for that client
4. Click "Deactivate" in the confirmation modal
5. Observe the button state while the API request is in progress

**Expected Results**:
- Button shows loading spinner
- Button text changes to "..." during the request
- Button remains disabled until the request completes
- Status indicator shows the optimistic update immediately

### 5. Error Handling
**Objective**: Verify that appropriate error messages are displayed when toggle operations fail.

**Steps**:
1. Simulate an API failure (e.g., using browser dev tools to intercept requests)
2. Attempt to toggle a client status
3. Observe the UI response

**Expected Results**:
- Client status reverts to its original state
- Error toast notification appears with descriptive message
- Button returns to its original state (Activate/Deactivate)

### 6. Session Expiration Handling
**Objective**: Verify that session expiration is handled gracefully during toggle operations.

**Steps**:
1. Navigate to the admin dashboard
2. Allow the admin session to expire (or manually remove the admin token)
3. Attempt to toggle a client status
4. Observe the system response

**Expected Results**:
- User is automatically logged out
- Session expired toast notification appears
- Redirected to login page
- Admin token is removed from sessionStorage

### 7. Multiple Concurrent Toggles
**Objective**: Verify that the system handles multiple simultaneous toggle requests appropriately.

**Steps**:
1. Navigate to the admin dashboard
2. Quickly attempt to toggle multiple client statuses in succession
3. Observe the behavior of each toggle operation

**Expected Results**:
- Each operation is handled independently
- Loading states are properly displayed for each client
- Status updates are applied correctly
- No race conditions occur

## Verification Checklist
- [ ] Activation functionality works as expected
- [ ] Deactivation functionality works as expected
- [ ] Confirmation modal appears for deactivation
- [ ] No confirmation modal for activation
- [ ] Loading states are properly displayed
- [ ] Success notifications appear
- [ ] Error handling works correctly
- [ ] Session expiration is handled gracefully
- [ ] Optimistic updates work correctly
- [ ] Rollback occurs on API failure
- [ ] Button states update correctly
- [ ] Status indicators update correctly