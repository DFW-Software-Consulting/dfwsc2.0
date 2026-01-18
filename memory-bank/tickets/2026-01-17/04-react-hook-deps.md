# Ticket: Add missing React hook dependencies

**Created:** 2026-01-17
**Priority:** P2
**Area:** Frontend

## Summary

Add missing dependencies to React hooks to avoid stale closures and clarify intent.

## Context

- `front/src/pages/AdminDashboard.jsx:96` uses `showToast` without listing it
- `front/src/pages/ClientList.jsx:425` uses `onSessionExpired` without listing it

## Tasks

- [ ] Add `showToast` to the `fetchClients` dependency array
- [ ] Add `onSessionExpired` to the `updateClientStatus` dependency array
- [ ] Verify no lint warnings and behavior unchanged

## Acceptance Criteria

- [ ] Dependency arrays list all referenced values
- [ ] No React hook lint warnings
- [ ] UI behavior unchanged
