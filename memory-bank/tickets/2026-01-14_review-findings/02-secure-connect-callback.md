# Code Review Follow-up: Secure Connect Callback

**Created:** 2026-01-14
**Priority:** High

## Summary

Harden `/connect/callback` so Stripe account linkage cannot be overwritten by arbitrary callers.

## Tasks

- [ ] Add a verifiable `state` parameter when creating the Stripe account link (store in DB or sign it).
- [ ] Require the `state` value on callback and validate it before updating `stripeAccountId`.
- [ ] Consider verifying the `account` with Stripe API and ensure it matches the client from the `state`.
- [ ] Add error handling for invalid/expired state.

## References
- `backend/src/routes/connect.ts:173`
