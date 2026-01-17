# Testing Gap: Env Loading Order

**Created:** 2026-01-14
**Priority:** Low

## Summary

Add tests to ensure env vars are loaded before routes read them in dev.

## Tasks

- [ ] Test that `USE_CHECKOUT` and `STRIPE_WEBHOOK_SECRET` are read after dotenv is initialized.

## References
- `backend/src/routes/payments.ts:10`
- `backend/src/routes/webhooks.ts:9`
- `backend/src/server.ts:1`
