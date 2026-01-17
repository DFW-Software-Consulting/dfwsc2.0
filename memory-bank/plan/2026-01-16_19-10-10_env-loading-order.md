---
title: "Env Loading Order Fix – Plan"
phase: Plan
date: "2026-01-16T19:10:10"
owner: "claude"
parent_research: "memory-bank/tickets/2026-01-14_review-findings/05-env-loading-order.md"
git_commit_at_plan: "ea8ae39"
tags: [plan, env-loading, dotenv, timing]
---

## Goal

**Fix the env loading race condition** so that `USE_CHECKOUT` and `STRIPE_WEBHOOK_SECRET` are reliably available when their modules are first imported, eliminating module-load timing issues in development.

**Non-goals:**
- Refactoring unrelated env usage patterns
- Changing production behavior (production uses pre-set env vars)

## Scope & Assumptions

### In Scope
- `backend/src/server.ts` – entry point with async dotenv load
- `backend/src/routes/payments.ts:10` – top-level `USE_CHECKOUT` read
- `backend/src/routes/webhooks.ts:9-12` – top-level `STRIPE_WEBHOOK_SECRET` read with throw
- `backend/src/lib/stripe.ts:3-7` – top-level `STRIPE_SECRET_KEY` read with throw
- `backend/src/db/client.ts:4` – top-level `DATABASE_URL` read

### Out of Scope
- Request-time env reads (already safe: `payments.ts:63,95,106`, `auth.ts:27-28`, `mailer.ts:13-16`, etc.)
- Test files (they set env before imports)

### Assumptions
- In development, dotenv must load **before** any module reads env vars
- In production, env vars are pre-set by the container/runtime
- The current async IIFE pattern in `server.ts:1-5` does NOT block static imports

## Deliverables (DoD)

| Artifact | Acceptance Criteria |
|----------|---------------------|
| Updated `server.ts` | Dotenv loads synchronously before static imports |
| Refactored `webhooks.ts` | No top-level throw; read env at route registration time |
| Refactored `payments.ts` | `useCheckout` computed at registration or request time |
| Guard test | One test verifying missing env throws meaningful error at startup |

## Readiness (DoR)

- [x] Source files identified and read
- [x] Git commit baseline captured: `ea8ae39`
- [x] Problem understood: async IIFE doesn't block ES module imports
- [x] Docker environment available for testing

## Milestones

| ID | Milestone | Gate |
|----|-----------|------|
| M1 | Entry point fix | `server.ts` loads dotenv synchronously before imports |
| M2 | Route refactors | `webhooks.ts` and `payments.ts` defer env reads |
| M3 | Validation | Docker rebuild + manual test + one automated guard test |

## Work Breakdown (Tasks)

### Task 1: Fix server.ts entry point (M1)
**Summary:** Make dotenv load synchronously before static imports
**Owner:** dev
**Dependencies:** None
**Files:** `backend/src/server.ts`

**Approach:**
Create a separate entry file (`backend/src/index.ts`) that:
1. Calls `dotenv.config()` synchronously at the very top
2. Then dynamically imports `./server` and calls `start()`

This ensures env vars are loaded before any other module is evaluated.

**Acceptance Tests:**
- [ ] App starts in dev with only `.env` file (no pre-set env vars)
- [ ] All env vars available when routes register

---

### Task 2: Refactor webhooks.ts (M2)
**Summary:** Move `STRIPE_WEBHOOK_SECRET` read to route registration time
**Owner:** dev
**Dependencies:** Task 1
**Files:** `backend/src/routes/webhooks.ts`

**Approach:**
Move the env read and validation inside the route registration function, not at module top-level.

**Acceptance Tests:**
- [ ] Module imports without throwing
- [ ] Route still validates webhook secret at registration
- [ ] Webhook endpoint works correctly

---

### Task 3: Refactor payments.ts (M2)
**Summary:** Compute `useCheckout` at registration time instead of top-level
**Owner:** dev
**Dependencies:** Task 1
**Files:** `backend/src/routes/payments.ts`

**Approach:**
Move `useCheckout` computation inside the route registration function.

**Acceptance Tests:**
- [ ] Module imports without reading env
- [ ] `USE_CHECKOUT` behavior unchanged

---

### Task 4: Add guard test (M3)
**Summary:** Verify missing required env throws clear error at startup
**Owner:** dev
**Dependencies:** Tasks 1-3
**Files:** `backend/src/__tests__/env-guard.test.ts` (new)

**Acceptance Tests:**
- [ ] Test confirms meaningful error when `STRIPE_WEBHOOK_SECRET` missing
- [ ] Test passes in CI

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| Breaking production startup | High | Low | Production doesn't use dotenv; env pre-set | Test in Docker with production-like config |
| Import order changes cause side effects | Medium | Low | Minimal changes; test in Docker | Route tests fail |

## Test Strategy

**One new test:** `backend/src/__tests__/env-guard.test.ts`
- Spawns app without required env var
- Asserts process exits with clear error message

Existing tests remain unchanged (they already mock env vars before imports).

## References

- Ticket: `memory-bank/tickets/2026-01-14_review-findings/05-env-loading-order.md`
- `backend/src/server.ts:1-5` – current async IIFE
- `backend/src/routes/webhooks.ts:9-12` – problem top-level read
- `backend/src/routes/payments.ts:10` – problem top-level read
- `backend/src/lib/env.ts` – existing env validation (called too late)

---

## Final Gate

- **Plan path:** `memory-bank/plan/2026-01-16_19-10-10_env-loading-order.md`
- **Milestones:** 3
- **Tasks:** 4
- **Gates:** Entry point fix → Route refactors → Validation

**Next command:** `/ce-ex "memory-bank/plan/2026-01-16_19-10-10_env-loading-order.md"`
