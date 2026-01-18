# Ticket: Add tests for rate limit and webhook edge cases

**Created:** 2026-01-17
**Priority:** P2
**Area:** Backend tests

## Summary

Fill gaps in tests for auth rate limiting and webhook signature validation edge cases.

## Context

- Test coverage gaps identified in findings

## Tasks

- [ ] Add auth rate limit tests for edge conditions (reset, retry windows)
- [ ] Add webhook signature validation tests for edge cases
- [ ] Ensure tests run in Docker environment

## Acceptance Criteria

- [ ] Rate limit edge cases are covered by tests
- [ ] Webhook signature edge cases are covered by tests
- [ ] Tests run successfully in the containerized setup
