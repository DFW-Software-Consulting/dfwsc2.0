# Code Review Follow-up: app-config Host Validation

**Created:** 2026-01-14
**Priority:** Medium

## Summary

Prevent host-header based injection in `/app-config.js` by sanitizing or restricting host values.

## Tasks

- [ ] Use `API_BASE_URL`/`FRONTEND_ORIGIN` as the sole source for the API URL in production.
- [ ] If host header is used, validate against an allowlist and escape values.
- [ ] Add tests for untrusted Host/X-Forwarded headers.

## References
- `backend/src/routes/config.ts:3`
- `backend/src/routes/config.ts:17`
