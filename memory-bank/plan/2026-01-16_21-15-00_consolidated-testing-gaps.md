---
title: "Consolidated Testing Gaps – Plan"
phase: Plan
date: "2026-01-16T21:15:00Z"
owner: "agent"
parent_research: "memory-bank/tickets/2026-01-14_review-findings/11-13"
git_commit_at_plan: "3928a38"
tags: [plan, testing, onboarding-token, env-loading, app-config]
---

## Goal

Add targeted integration tests for three testing gaps identified in the 2026-01-14 review:
1. Onboarding token lifecycle (pending status persistence)
2. Environment variable loading order verification
3. App-config host header rejection

**Non-goals**: Refactoring existing code, adding new features, performance testing.

## Scope & Assumptions

### In Scope
- One focused integration test per ticket area
- Tests run in existing Docker/Vitest infrastructure
- Use established test patterns from codebase

### Out of Scope
- Expired/abandoned token flows (not yet implemented per ticket #11)
- Production environment testing
- Load/stress testing

### Assumptions
- Docker environment available for test execution
- Database accessible for integration tests
- Existing test patterns in `backend/src/__tests__/integration/` are the standard

## Deliverables (DoD)

| Deliverable | Acceptance Criteria |
|-------------|---------------------|
| Token lifecycle test | Test verifies token remains `pending` until `in_progress` transition via `/onboard-client` endpoint |
| Env loading test | Test confirms `USE_CHECKOUT` and `STRIPE_WEBHOOK_SECRET` are available after server build |
| App-config test | Test confirms malicious Host/X-Forwarded headers are ignored in favor of `API_BASE_URL` |

## Readiness (DoR)

- [x] Research tickets reviewed
- [x] Codebase analyzed for existing patterns
- [x] Key files identified
- [x] Test infrastructure understood (Vitest + Fastify inject)

## Milestones

| ID | Milestone | Description |
|----|-----------|-------------|
| M1 | Token Lifecycle Test | Add test for pending token persistence |
| M2 | Env Loading Test | Add test for env var availability timing |
| M3 | App-config Host Test | Add test for header rejection (may already exist) |

## Work Breakdown (Tasks)

### T1: Onboarding Token Lifecycle Test
- **Summary**: Add integration test verifying tokens stay `pending` until explicit state transition
- **Owner**: Agent
- **Dependencies**: None
- **Target**: M1
- **Files**: `backend/src/__tests__/integration/connect-token-lifecycle.test.ts` (new)

**Acceptance Tests**:
- [ ] Test creates token via POST `/api/v1/accounts`
- [ ] Test verifies token status is `pending` in database
- [ ] Test verifies token remains `pending` without calling `/onboard-client`
- [ ] Test passes in Docker environment

**Reference**: `backend/src/routes/connect.ts:49-55` (token creation with pending status)

---

### T2: Environment Loading Order Test
- **Summary**: Add test verifying env vars are loaded before route registration reads them
- **Owner**: Agent
- **Dependencies**: None
- **Target**: M2
- **Files**: `backend/src/__tests__/env-loading-order.test.ts` (new)

**Acceptance Tests**:
- [ ] Test verifies `validateEnv()` is called before routes access env vars
- [ ] Test confirms `USE_CHECKOUT` is available during payments route registration
- [ ] Test confirms `STRIPE_WEBHOOK_SECRET` is available during webhooks route registration
- [ ] Test passes in Docker environment

**Reference**:
- `backend/src/lib/env.ts:24-60` (validateEnv)
- `backend/src/routes/payments.ts:19` (USE_CHECKOUT read)
- `backend/src/routes/webhooks.ts:9-14` (STRIPE_WEBHOOK_SECRET read)

---

### T3: App-config Host Header Test
- **Summary**: Verify existing test coverage or add test for Host header rejection
- **Owner**: Agent
- **Dependencies**: None
- **Target**: M3
- **Files**: `backend/src/__tests__/integration/app-config-host.test.ts` (existing)

**Acceptance Tests**:
- [ ] Confirm test exists for malicious Host header being ignored
- [ ] Confirm test exists for X-Forwarded-Host being ignored
- [ ] If missing, add test case
- [ ] Test passes in Docker environment

**Reference**: `backend/src/routes/config.ts:3-9` (resolveApiBaseUrl uses only env var)

**Note**: Analysis shows this test may already exist at `backend/src/__tests__/integration/app-config-host.test.ts:24-43`. Task is to verify coverage and add X-Forwarded-Host case if missing.

---

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| Tests flaky due to database state | Medium | Low | Use proper beforeAll/afterAll cleanup | Test fails intermittently |
| Env tests affect other tests | High | Medium | Isolate with separate test file, restore env after | Other tests break |
| App-config test already complete | Low | High | Review existing test, skip if adequate | Test file exists |

## Test Strategy

**ONE test file per ticket area** (maximum 3 test files total):
1. `connect-token-lifecycle.test.ts` - Token pending state persistence
2. `env-loading-order.test.ts` - Env var timing verification
3. `app-config-host.test.ts` - Verify/extend existing coverage

**Pattern**: Follow existing integration test patterns using `buildServer()` and Fastify's `.inject()`.

## References

- Ticket #11: `memory-bank/tickets/2026-01-14_review-findings/11-tests-onboarding-token-lifecycle.md`
- Ticket #12: `memory-bank/tickets/2026-01-14_review-findings/12-tests-env-loading.md`
- Ticket #13: `memory-bank/tickets/2026-01-14_review-findings/13-tests-app-config-host.md`
- Existing test patterns: `backend/src/__tests__/integration/connect-callback-state.test.ts`
- Env validation: `backend/src/lib/env.ts`

---

## Alternative Approach

**Option B**: Combine all three tests into a single `testing-gaps.test.ts` file with describe blocks. This reduces file count but mixes concerns. **Not recommended** - separate files match existing codebase patterns.

---

## Final Gate

| Item | Value |
|------|-------|
| Plan Path | `memory-bank/plan/2026-01-16_21-15-00_consolidated-testing-gaps.md` |
| Milestones | 3 |
| Gates | Each task must pass in Docker environment |
| Next Command | `/ce-ex "memory-bank/plan/2026-01-16_21-15-00_consolidated-testing-gaps.md"` |
