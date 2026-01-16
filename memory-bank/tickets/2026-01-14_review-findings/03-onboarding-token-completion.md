# Code Review Follow-up: Onboarding Token Completion Timing

**Created:** 2026-01-14
**Priority:** Medium

## Summary

Do not mark onboarding tokens `completed` before the Stripe onboarding flow finishes.

## Tasks

- [ ] Move token completion update from `/onboard-client` to the callback (or after Stripe confirms onboarding completed).
- [ ] Define behavior for abandoned/expired onboarding tokens (expiry timestamp or reissue flow).
- [ ] Add logging for token status transitions.

## References
- `backend/src/routes/connect.ts:164`
