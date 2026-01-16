---
title: "Payments API Key Auth – Plan"
phase: Plan
date: "2026-01-16T06:53:51"
owner: "claude-agent"
parent_research: "memory-bank/tickets/2026-01-14_review-findings/01-payments-api-key-auth.md"
git_commit_at_plan: "6bb6217"
tags: [plan, payments, api-key, auth, security]
---

## Goal

**Replace the spoofable `x-api-role` header with per-client API key authentication for `/payments/create`**, ensuring payment creation is cryptographically bound to the authenticated client.

**Non-goals:**
- Hashing API keys (out of scope per research doc: "plaintext stored in DB")
- Multi-key support per client
- Key rotation or revocation UI

## Scope & Assumptions

### In Scope
- Add `apiKey` column to `clients` table
- Generate API key on client creation (`POST /accounts`)
- Authenticate `/payments/create` via `x-api-key` header
- Bind payment to the API-key's client (ignore body `clientId`)
- Remove `requireRole` from payments route

### Out of Scope
- Admin dashboard UI for key management
- Key expiration/rotation
- Hashing keys (per research doc specification)

### Assumptions
- Docker environment is running and accessible
- Database migrations run via Drizzle ORM
- Single API key per client is sufficient
- API key returned once at creation (admin stores it securely)

## Deliverables (DoD)

| Deliverable | Acceptance Criteria |
|-------------|---------------------|
| `apiKey` column in clients table | Migration runs successfully, column is text/nullable |
| API key generation | `POST /accounts` returns `apiKey` in response body |
| `requireApiKey` middleware | Returns 401 for missing/invalid key, attaches `clientId` to request |
| Payments endpoint secured | `/payments/create` uses API key auth, ignores body `clientId` |
| Integration test | Test validates key auth flow end-to-end |

## Readiness (DoR)

- [x] Research document reviewed
- [x] Codebase analyzed (auth.ts, payments.ts, connect.ts, schema.ts)
- [x] Git state captured (6bb6217)
- [ ] Docker containers running (`docker-compose up -d`)

## Milestones

### M1: Schema & Migration
Add `apiKey` column to clients table and generate migration.

### M2: Key Generation at Client Creation
Modify `POST /accounts` to generate and return API key.

### M3: API Key Middleware & Payments Auth
Create `requireApiKey` middleware, apply to `/payments/create`, remove `requireRole`.

### M4: Test & Validation
Write integration test, validate in Docker environment.

## Work Breakdown (Tasks)

| ID | Task | Owner | Dependencies | Milestone |
|----|------|-------|--------------|-----------|
| T1 | Add `apiKey` column to `clients` schema | agent | none | M1 |
| T2 | Generate and run Drizzle migration | agent | T1 | M1 |
| T3 | Generate API key in `POST /accounts` route | agent | T2 | M2 |
| T4 | Return `apiKey` in creation response | agent | T3 | M2 |
| T5 | Create `requireApiKey` middleware in auth.ts | agent | T2 | M3 |
| T6 | Apply middleware to `/payments/create` | agent | T5 | M3 |
| T7 | Remove `requireRole` from payments route | agent | T6 | M3 |
| T8 | Update payments handler to use `req.clientId` from middleware | agent | T6 | M3 |
| T9 | Write integration test for API key auth flow | agent | T8 | M4 |

### Task Details

**T1: Add apiKey column to clients schema**
- File: `backend/src/db/schema.ts`
- Change: Add `apiKey: text('api_key')` to clients table
- Acceptance: Schema compiles, type exports updated

**T5: Create requireApiKey middleware**
- File: `backend/src/lib/auth.ts`
- Pattern: Similar to `requireAdminJwt`
- Logic:
  1. Extract `x-api-key` header
  2. Query `clients` table by `apiKey`
  3. Reject if not found or client inactive
  4. Attach `clientId` to request object
- Acceptance: 401 on missing/invalid key, request decorated with clientId

**T8: Update payments handler**
- File: `backend/src/routes/payments.ts`
- Change: Use `req.clientId` from middleware instead of `body.clientId`
- Acceptance: Payment bound to authenticated client only

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| Plaintext API keys in DB | Medium | Low | Document as intentional per spec; future ticket for hashing | Security review |
| Migration fails on existing data | High | Low | Make column nullable, backfill keys for existing clients | Migration error |
| Breaking existing integrations | High | Medium | Coordinate with any existing API consumers | Deploy |

## Test Strategy

**ONE integration test** covering the full flow:

```
Test: API Key Authentication for Payments
1. Create client via POST /accounts (admin auth)
2. Extract apiKey from response
3. POST /payments/create with x-api-key header
4. Assert: Payment created successfully, bound to correct client
5. POST /payments/create with invalid key
6. Assert: 401 Unauthorized
```

- File: `backend/src/__tests__/integration/payments-api-key.test.ts`

## References

- Research: `memory-bank/tickets/2026-01-14_review-findings/01-payments-api-key-auth.md`
- Auth middleware: `backend/src/lib/auth.ts:7`
- Payments route: `backend/src/routes/payments.ts:19`
- Client creation: `backend/src/routes/connect.ts:28-59`
- Schema: `backend/src/db/schema.ts`

## Alternative Approach (Not Recommended)

**Option B: Separate API keys table**
- Create `api_keys` table with foreign key to clients
- Supports multiple keys per client, revocation
- **Rejected:** Over-engineering for current requirements; can migrate later if needed

---

## Final Gate

| Check | Criteria |
|-------|----------|
| Schema | `apiKey` column exists in clients table |
| Generation | New clients receive API key in response |
| Auth | `/payments/create` requires valid `x-api-key` |
| Binding | Payment uses client from API key, not body |
| Test | Integration test passes in Docker |

---

**Plan Summary:**
- **Path:** `memory-bank/plan/2026-01-16_06-53-51_payments-api-key-auth.md`
- **Milestones:** 4 (Schema → Key Gen → Auth Middleware → Test)
- **Tasks:** 9
- **Gates:** 5 acceptance criteria

**Next command:** `/cc-ex "memory-bank/plan/2026-01-16_06-53-51_payments-api-key-auth.md"`
