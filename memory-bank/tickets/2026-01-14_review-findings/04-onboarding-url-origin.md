# Code Review Follow-up: Onboarding URL Origin

**Created:** 2026-01-14
**Priority:** Medium

## Summary

Replace hard-coded onboarding URLs with `FRONTEND_ORIGIN` to support non-prod environments.

## Tasks

- [ ] Build onboarding URL from `FRONTEND_ORIGIN` (and trim trailing slash).
- [ ] Ensure a clear error is returned if `FRONTEND_ORIGIN` is missing.
- [ ] Update docs to reflect environment-dependent URLs.

## References
- `backend/src/routes/connect.ts:52`
- `backend/src/routes/connect.ts:84`
