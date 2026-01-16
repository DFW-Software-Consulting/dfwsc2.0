# Code Review Follow-up: Env Loading Order

**Created:** 2026-01-14
**Priority:** Medium

## Summary

Ensure `USE_CHECKOUT` and `STRIPE_WEBHOOK_SECRET` are read after dotenv loads in dev, avoiding module-load timing issues.

## Tasks

- [ ] Load dotenv before importing modules that read env vars, or refactor to read env at request time.
- [ ] Remove top-level env reads where possible.
- [ ] Add a guard/test for missing env in dev.

## References
- `backend/src/routes/payments.ts:10`
- `backend/src/routes/webhooks.ts:9`
- `backend/src/server.ts:1`
