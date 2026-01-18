---
title: "Connect Client Creation Helper – Plan"
phase: Plan
date: "2026-01-17T23:15:00Z"
owner: "claude-agent"
parent_research: "memory-bank/tickets/2026-01-17/02-connect-client-creation-helper.md"
git_commit_at_plan: "ef90814"
tags: [plan, refactor, connect, helper]
---

## Goal

**Extract duplicate client + onboarding token creation logic into a single reusable helper function** in `backend/src/routes/connect.ts`.

**Non-goals:**
- Do NOT create a new service layer or repository pattern
- Do NOT refactor email sending logic
- Do NOT change response structures or API contracts
- Do NOT add new features or error handling beyond what exists

## Scope & Assumptions

### In Scope
- Lines 41-55 and 82-96 in `connect.ts` (identical code blocks)
- Creating a helper function within the same file
- Updating both `/accounts` and `/onboard-client/initiate` endpoints to use the helper

### Out of Scope
- Refactoring the `FRONTEND_ORIGIN` check (differs between endpoints)
- Email sending logic (only exists in `/onboard-client/initiate`)
- Response body structures (intentionally different)
- Creating new files or service layers

### Assumptions
- Helper function will remain in `connect.ts` (following codebase pattern of no service layer)
- Both endpoints will continue to work identically after refactoring
- No changes to tests required (behavior unchanged)

## Deliverables (DoD)

| Artifact | Acceptance Criteria |
|----------|---------------------|
| `createClientWithOnboardingToken()` helper | Returns `{ clientId, apiKey, token }` |
| Updated `/accounts` endpoint | Uses helper, response unchanged |
| Updated `/onboard-client/initiate` endpoint | Uses helper, response unchanged |
| Passing tests | `make test` passes with no new failures |

## Readiness (DoR)

- [x] Research complete - duplicate code identified at lines 41-55 and 82-96
- [x] Schema understood - `clients` and `onboardingTokens` tables
- [x] Test patterns documented - existing tests in `__tests__/integration/`
- [x] No blocking dependencies

## Milestones

| Milestone | Description |
|-----------|-------------|
| M1 | Create helper function with type definitions |
| M2 | Replace inline code in both endpoints |
| M3 | Run tests and verify behavior unchanged |

## Work Breakdown (Tasks)

### Task 1: Create `createClientWithOnboardingToken` helper
- **ID:** T1
- **Summary:** Add helper function above route handlers
- **Owner:** agent
- **Dependencies:** None
- **Target Milestone:** M1

**Implementation:**
```typescript
interface ClientWithToken {
  clientId: string;
  apiKey: string;
  token: string;
}

async function createClientWithOnboardingToken(
  name: string,
  email: string
): Promise<ClientWithToken> {
  const clientId = uuidv4();
  const apiKey = generateApiKey();

  await db.insert(clients).values({ id: clientId, name, email, apiKey });

  const token = crypto.randomBytes(32).toString('hex');
  const onboardingTokenId = uuidv4();

  await db.insert(onboardingTokens).values({
    id: onboardingTokenId,
    clientId: clientId,
    token: token,
    status: 'pending',
    email: email,
  });

  return { clientId, apiKey, token };
}
```

**Acceptance Tests:**
- [ ] Helper function compiles without errors
- [ ] Function is defined before route handlers

**Files/Interfaces:**
- `backend/src/routes/connect.ts` (add function around line 30)

---

### Task 2: Update `/accounts` endpoint
- **ID:** T2
- **Summary:** Replace inline logic with helper call
- **Owner:** agent
- **Dependencies:** T1
- **Target Milestone:** M2

**Before (lines 41-55):**
```typescript
const clientId = uuidv4();
const apiKey = generateApiKey();
await db.insert(clients).values({ id: clientId, name, email, apiKey });
const token = crypto.randomBytes(32).toString('hex');
const onboardingTokenId = uuidv4();
await db.insert(onboardingTokens).values({...});
```

**After:**
```typescript
const { clientId, apiKey, token } = await createClientWithOnboardingToken(name, email);
```

**Acceptance Tests:**
- [ ] Response body structure unchanged: `{ name, onboardingToken, onboardingUrlHint, apiKey, clientId }`
- [ ] 201 status code returned

**Files/Interfaces:**
- `backend/src/routes/connect.ts` lines 41-55

---

### Task 3: Update `/onboard-client/initiate` endpoint
- **ID:** T3
- **Summary:** Replace inline logic with helper call
- **Owner:** agent
- **Dependencies:** T1
- **Target Milestone:** M2

**Before (lines 82-96):**
```typescript
const clientId = uuidv4();
const apiKey = generateApiKey();
await db.insert(clients).values({ id: clientId, name, email, apiKey });
const token = crypto.randomBytes(32).toString('hex');
const onboardingTokenId = uuidv4();
await db.insert(onboardingTokens).values({...});
```

**After:**
```typescript
const { clientId, apiKey, token } = await createClientWithOnboardingToken(name, email);
```

**Acceptance Tests:**
- [ ] Response body structure unchanged: `{ message, clientId, apiKey }`
- [ ] Email still sent with correct `onboardingUrl`
- [ ] 201 status code returned

**Files/Interfaces:**
- `backend/src/routes/connect.ts` lines 82-96

---

### Task 4: Run tests and verify
- **ID:** T4
- **Summary:** Execute test suite to confirm no regressions
- **Owner:** agent
- **Dependencies:** T2, T3
- **Target Milestone:** M3

**Acceptance Tests:**
- [ ] `make test` passes
- [ ] No new test failures
- [ ] Integration tests for connect routes pass

**Files/Interfaces:**
- N/A (test execution only)

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| Helper breaks existing behavior | High | Low | Run full test suite after changes | Tests fail |
| Type inference issues | Low | Low | Explicit return type on helper | TypeScript errors |

## Test Strategy

**No new tests required.** The refactoring preserves existing behavior exactly. Existing integration tests in `backend/src/__tests__/integration/` cover:
- Token lifecycle (`connect-token-lifecycle.test.ts`)
- Callback state validation (`connect-callback-state.test.ts`)

If tests fail, investigate and fix without adding new tests.

## References

- Ticket: `memory-bank/tickets/2026-01-17/02-connect-client-creation-helper.md`
- Source file: `backend/src/routes/connect.ts` lines 41-55 and 82-96
- Schema: `backend/src/db/schema.ts` (clients, onboardingTokens tables)

---

## Alternative Approach (Not Recommended)

**Option B: Extract to separate service file**

Could create `backend/src/services/client.ts` with the helper. However:
- Codebase has no service layer pattern currently
- Adds unnecessary complexity for a single function
- Would require additional imports/exports

**Recommendation: Keep helper in `connect.ts`** (Option A above)

---

## Final Gate Summary

| Item | Value |
|------|-------|
| Plan path | `memory-bank/plan/2026-01-17_23-15-00_connect-client-creation-helper.md` |
| Milestones | 3 |
| Tasks | 4 |
| Files modified | 1 (`backend/src/routes/connect.ts`) |
| New tests | 0 |
| Estimated lines changed | ~25 lines removed, ~20 lines added |

**Next command:** `/ce-ex "memory-bank/plan/2026-01-17_23-15-00_connect-client-creation-helper.md"`
