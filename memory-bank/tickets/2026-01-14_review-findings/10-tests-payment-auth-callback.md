# Testing Gap: Payment Auth and Connect Callback

**Created:** 2026-01-14
**Priority:** Medium

## Summary

Add tests covering payment authorization and `/connect/callback` tampering scenarios.

## Tasks

- [ ] Test that `/payments/create` rejects missing/invalid API keys (after API-key auth is added).
- [ ] Test that `/connect/callback` rejects invalid/expired state or mismatched account.

## References
- `backend/src/routes/payments.ts:19`
- `backend/src/routes/connect.ts:173`
