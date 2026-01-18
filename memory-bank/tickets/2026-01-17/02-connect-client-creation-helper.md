# Ticket: Extract shared client/onboarding creation helper

**Created:** 2026-01-17
**Priority:** P1
**Area:** Backend

## Summary

Refactor duplicate client creation and onboarding token creation logic into a shared helper used by both endpoints.

## Context

- File: `backend/src/routes/connect.ts`
- Duplicate sections around lines 1048-1088 and 1092-1150

## Tasks

- [ ] Identify the shared fields and behavior between both flows
- [ ] Create a helper function to create client + onboarding token
- [ ] Replace inline logic in both endpoints with the helper
- [ ] Update or add tests if needed

## Acceptance Criteria

- [ ] Shared logic lives in a single helper
- [ ] Both endpoints use the helper
- [ ] Behavior and responses remain unchanged
