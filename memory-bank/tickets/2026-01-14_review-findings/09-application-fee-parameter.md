# Code Review Follow-up: applicationFeeAmount Handling

**Created:** 2026-01-14
**Priority:** Low

## Summary

Align fee handling in `/payments/create` with API contract: either honor `applicationFeeAmount` from the request or remove it and update error messages/docs.

## Tasks

- [ ] Decide whether to accept `applicationFeeAmount` or enforce `DEFAULT_PROCESS_FEE_CENTS` only.
- [ ] Update validation and error messaging accordingly.
- [ ] Update API docs to match behavior.

## References
- `backend/src/routes/payments.ts:29`
- `backend/src/routes/payments.ts:65`
