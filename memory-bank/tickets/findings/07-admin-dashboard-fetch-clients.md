# Admin dashboard does not auto-fetch clients after login or token restore

**Priority:** Medium

## Description

After successful admin login (`handleLoginSuccess`) the dashboard sets `isLoggedIn` but never calls `fetchClients`. The initial token check in `useEffect` also skips fetching. Returning admins with a valid token see “No clients yet” until they manually click Refresh.

## Steps to Reproduce

1. Log in as admin.
2. Observe dashboard client list.
3. Refresh page with token stored; observe list again.

## Expected

Clients load automatically after login or when a stored token is detected.

## Actual

Client list stays empty until Refresh is clicked.

## Proposed Fix

Invoke `fetchClients` after login success and after detecting a stored token in `useEffect`.

## Files

- `/home/jeremy/jcFolder/dfwsc/dfwsc2.0/front/src/components/admin/AdminDashboard.jsx`
