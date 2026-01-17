# Testing Gap: app-config Host Handling

**Created:** 2026-01-14
**Priority:** Low

## Summary

Add tests to cover untrusted Host/X-Forwarded headers in `/app-config.js`.

## Tasks

- [ ] Test that untrusted Host/X-Forwarded headers are rejected or sanitized.

## References
- `backend/src/routes/config.ts:3`
- `backend/src/routes/config.ts:17`
