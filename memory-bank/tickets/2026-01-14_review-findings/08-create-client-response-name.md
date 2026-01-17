# Code Review Follow-up: Create Client Response Name

**Created:** 2026-01-14
**Priority:** Low

## Summary

Fix the create-client response so the admin toast has the client name.

## Tasks

- [ ] Return `name` from `/accounts` response, or update the UI toast to not depend on it.

## References
- `front/src/components/admin/CreateClientForm.jsx:73`
- `backend/src/routes/connect.ts:54`
