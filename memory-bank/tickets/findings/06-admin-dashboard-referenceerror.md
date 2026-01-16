# Code Review Follow-up: AdminDashboard ReferenceError

**Branch:** `client-status-db`
**Created:** 2026-01-14
**Priority:** P0

## Summary

Fix a runtime crash in `AdminDashboard` caused by self-referential hook dependencies that trigger a `ReferenceError` during render.

---

## Tasks

### 1. Reorder hooks to avoid temporal dead zone

**File:** `front/src/components/admin/AdminDashboard.jsx`

Ensure `fetchClients` and `showToast` are defined before they are referenced in `useEffect` and hook dependency arrays.

---

## Acceptance Criteria

- [ ] `AdminDashboard` renders without a `ReferenceError`
- [ ] Hooks reference defined functions in their dependency arrays
- [ ] Admin UI mounts successfully on the OnboardClient page
