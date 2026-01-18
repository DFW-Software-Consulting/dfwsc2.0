# Ticket: Remove dead and redundant logic in connect callback

**Created:** 2026-01-17
**Priority:** P1
**Area:** Backend

## Summary

Remove the unreachable `else` branch in the Stripe connect callback and delete a redundant `if (state)` check to reduce confusion and keep control flow clear.

## Context

- File: `backend/src/routes/connect.ts`
- Dead branch: around lines 1315-1335
- Redundant check: around line 1257

## Tasks

- [x] Remove unreachable `else` branch after the `!state` early return
- [x] Remove redundant `if (state)` check after the early return
- [ ] Ensure behavior stays the same for valid and invalid states

## Acceptance Criteria

- [x] Connect callback logic has no unreachable branches
- [x] Redundant check is removed without changing behavior
- [x] Existing tests continue to pass
