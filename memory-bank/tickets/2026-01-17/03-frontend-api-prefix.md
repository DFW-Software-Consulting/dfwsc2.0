# Ticket: Standardize frontend API path prefix

**Created:** 2026-01-17
**Priority:** P1
**Area:** Frontend

## Summary

Ensure all frontend API calls use the `/api/v1` prefix to match backend route registration.

## Context

- Example: `front/src/pages/OnboardClient.jsx:22` uses `/v1`
- Example: `front/src/pages/CreateClientForm.jsx:755` uses `/api/v1`

## Tasks

- [x] Audit frontend API calls for inconsistent prefixes
- [x] Update all calls to use `/api/v1`
- [x] Confirm no paths are missing the prefix

## Acceptance Criteria

- [x] All frontend API calls use `/api/v1`
- [ ] No regressions in onboarding or client creation flows
