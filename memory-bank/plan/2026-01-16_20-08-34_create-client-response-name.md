---
title: "Create Client Response Name – Plan"
phase: Plan
date: "2026-01-16_20-08-34"
owner: "agent"
parent_research: "memory-bank/tickets/2026-01-14_review-findings/08-create-client-response-name.md"
git_commit_at_plan: "b522c7e"
tags: [plan, create-client, response, toast]
---

## Goal

**Add `name` field to the `/accounts` POST response** so the admin toast correctly displays the client name after creation.

Non-goals:
- Changing the UI toast logic
- Modifying any other endpoints
- Adding new database fields

## Scope & Assumptions

**In Scope:**
- Backend: `POST /accounts` response in `backend/src/routes/connect.ts:64-69`

**Out of Scope:**
- Frontend changes (UI already expects `data.name` at line 78)
- Other response fields
- Email templates

**Assumptions:**
- The `name` value is already available in the request handler (passed in request body and inserted into DB)
- No schema changes required - just returning the existing value

## Deliverables (DoD)

| Artifact | Acceptance Criteria |
|----------|---------------------|
| Updated `/accounts` response | Response includes `name` field with the client's name |
| Existing tests pass | `npm test` passes in Docker container |
| Manual verification | Toast displays client name after creation |

## Readiness (DoR)

- [x] Docker environment running
- [x] Backend code accessible
- [x] Research doc reviewed
- [x] Git state clean

## Milestones

| ID | Milestone | Description |
|----|-----------|-------------|
| M1 | Implementation | Add `name` to response object |
| M2 | Verification | Run tests, verify toast works |

## Work Breakdown (Tasks)

| ID | Task | Owner | Dependencies | Milestone |
|----|------|-------|--------------|-----------|
| T1 | Add `name` field to `/accounts` response | agent | none | M1 |
| T2 | Run existing tests | agent | T1 | M2 |
| T3 | Manual verification in browser | user | T2 | M2 |

### T1: Add `name` field to `/accounts` response

**Files/Interfaces:**
- `backend/src/routes/connect.ts:64-69`

**Change:**
```typescript
// Current response (line 64-69):
return reply.code(201).send({
  onboardingToken: token,
  onboardingUrlHint,
  apiKey,
  clientId,
});

// Updated response:
return reply.code(201).send({
  name,  // <-- ADD THIS
  onboardingToken: token,
  onboardingUrlHint,
  apiKey,
  clientId,
});
```

**Acceptance Tests:**
- Response body contains `name` field
- `name` field value matches the input name from request body

### T2: Run existing tests

**Command:**
```bash
docker exec -it dfwsc20-api-1 npm test
```

**Acceptance:**
- All tests pass

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| Breaking API consumers | Medium | Low | Field addition is backwards-compatible | API contract docs updated |

## Test Strategy

- Run existing test suite - no new tests required (adding a field to response is backwards-compatible and trivial)

## References

- Research: `memory-bank/tickets/2026-01-14_review-findings/08-create-client-response-name.md`
- Frontend consumer: `front/src/components/admin/CreateClientForm.jsx:78`
- Backend endpoint: `backend/src/routes/connect.ts:32-70`

---

## Final Gate

| Item | Value |
|------|-------|
| Plan path | `memory-bank/plan/2026-01-16_20-08-34_create-client-response-name.md` |
| Milestones | 2 |
| Tasks | 3 |
| Gates | Test pass, manual verification |
| Next command | `/ce-ex "memory-bank/plan/2026-01-16_20-08-34_create-client-response-name.md"` |
