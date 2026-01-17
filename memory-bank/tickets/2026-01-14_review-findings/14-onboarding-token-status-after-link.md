# Code Review Follow-up: Defer Onboarding Token Status Update

**Created:** 2026-01-14
**Priority:** High

## Summary

Avoid permanently blocking onboarding when Stripe account link creation fails.

## Tasks

- [ ] Update onboarding token status only after `stripe.accountLinks.create` succeeds.
- [ ] Allow retry for `in_progress` tokens or implement rollback to `pending` when link creation fails.
- [ ] Add coverage for Stripe API failure to ensure retries remain possible.

## References
- `backend/src/routes/connect.ts:173-194`
