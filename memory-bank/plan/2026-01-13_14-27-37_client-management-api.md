---
title: "Client Management API – Plan"
phase: Plan
date: "2026-01-13 14:27:37"
owner: "claude-agent"
parent_research: "memory-bank/tickets/03-client-management-api.md"
git_commit_at_plan: "dedd66f"
tags: [plan, client-management, api, admin]
---

## Goal

**SINGULAR FOCUSED GOAL:** Add a `GET /api/v1/clients` endpoint that allows admin users to list all clients with their basic information (id, name, email, stripeAccountId, status, createdAt).

**Non-Goals:**
- Sorting and filtering capabilities (deferred for future iteration)
- Pagination (can be added later if needed)
- Client modification beyond existing PATCH endpoint
- Token creation endpoint modification (already admin-protected at `POST /api/v1/accounts`)

## Scope & Assumptions

**In Scope:**
- Add GET /api/v1/clients endpoint with admin authentication
- Return client list with specified fields: id, name, email, stripeAccountId, status, createdAt
- Verify existing POST /api/v1/accounts endpoint has admin JWT protection (already confirmed via code review)
- Write ONE focused integration test for the new GET endpoint

**Out of Scope:**
- Advanced filtering/sorting (noted in ticket as "can be added later")
- Pagination implementation
- Modifying existing client status update endpoint
- Frontend UI changes

**Assumptions:**
- Database schema (`clients` table) already contains all required fields
- `requireAdminJwt` middleware is working correctly (verified in existing routes)
- Docker environment is operational
- JWT authentication system is properly configured
- Database connection is stable

**Constraints:**
- Must use existing authentication patterns (`requireAdminJwt` from `src/lib/auth.ts`)
- Must follow existing route structure and patterns
- Must maintain consistency with existing API response formats
- Docker-based development workflow must be preserved

## Deliverables (DoD)

1. **GET /api/v1/clients endpoint**
   - Returns 200 with array of client objects
   - Each object contains: `id`, `name`, `email`, `stripeAccountId`, `status`, `createdAt` (ISO string)
   - Protected by `requireAdminJwt` middleware
   - Returns 401 for missing/invalid JWT
   - Returns 403 for non-admin role

2. **Integration Test**
   - ONE test file covering happy path and authorization scenarios
   - Test must pass in CI/CD environment
   - Minimum 80% code coverage for new endpoint

3. **Verification**
   - Existing `POST /api/v1/accounts` endpoint confirmed admin-protected (already done)
   - All existing tests still pass
   - No breaking changes to existing endpoints

## Readiness (DoR)

**Preconditions:**
- ✅ Docker containers are running (`docker-compose up -d`)
- ✅ Database is migrated and accessible
- ✅ JWT_SECRET is configured in .env
- ✅ Admin credentials are configured (ADMIN_USERNAME, ADMIN_PASSWORD)
- ✅ Existing auth system is functional
- ✅ Code review confirms `POST /api/v1/accounts` already has `requireAdminJwt` middleware

**Required Access:**
- ✅ Local development environment
- ✅ Database access via Drizzle ORM
- ✅ Existing codebase at commit `dedd66f`

**Data/Fixtures:**
- Test database with seed clients (handled by test setup)
- Valid admin JWT token for testing (generated in tests)

## Milestones

**M1: Code Implementation** (Primary Focus)
- Add GET endpoint to `backend/src/routes/clients.ts`
- Implement database query using Drizzle ORM
- Apply `requireAdminJwt` middleware
- Format response with required fields

**M2: Testing & Verification**
- Write ONE comprehensive integration test
- Run existing test suite to ensure no regressions
- Manual testing via curl/Postman in Docker environment

**M3: Documentation & Completion**
- Verify endpoint appears in Swagger docs (if enabled)
- Update any relevant API documentation
- Final smoke test

## Work Breakdown (Tasks)

### Task 1: Implement GET /api/v1/clients Endpoint
- **Owner:** Dev
- **Estimate:** Small (30 min)
- **Dependencies:** None
- **Target Milestone:** M1
- **Files Touched:**
  - `backend/src/routes/clients.ts`
- **Acceptance Tests:**
  - [ ] Endpoint responds with 200 status code for admin user
  - [ ] Response body is an array of client objects
  - [ ] Each client object contains: id, name, email, stripeAccountId, status, createdAt
  - [ ] createdAt is formatted as ISO string
  - [ ] Endpoint returns 401 when no Authorization header provided
  - [ ] Endpoint returns 403 when JWT has non-admin role
  - [ ] Empty array returned when no clients exist

### Task 2: Write Integration Test
- **Owner:** Dev
- **Estimate:** Small (20 min)
- **Dependencies:** Task 1
- **Target Milestone:** M2
- **Files Touched:**
  - `backend/src/routes/clients.test.ts`
- **Acceptance Tests:**
  - [ ] Test successfully lists clients with admin token
  - [ ] Test returns 401 without authorization
  - [ ] Test returns 403 with non-admin token
  - [ ] Test verifies all required fields are present
  - [ ] Test verifies createdAt format is ISO string
  - [ ] All tests pass in local Docker environment

### Task 3: Verification & Documentation
- **Owner:** Dev
- **Estimate:** Small (10 min)
- **Dependencies:** Task 2
- **Target Milestone:** M3
- **Files Touched:**
  - Manual testing, no code changes
- **Acceptance Tests:**
  - [ ] Run full test suite - all tests pass
  - [ ] Manual curl test with admin JWT succeeds
  - [ ] Manual curl test without auth fails with 401
  - [ ] Swagger docs show new endpoint (if enabled)
  - [ ] No console errors or warnings

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| Large dataset performance issue | Medium | Low | Initially return all clients; add pagination in future if needed | Query takes >2s with 1000+ clients |
| Test database state conflicts | Medium | Low | Use beforeEach/afterEach cleanup in tests; ensure isolated test data | Test failures due to data collisions |
| JWT middleware not properly applied | High | Low | Verify middleware in route registration; test auth scenarios thoroughly | Unauthorized access succeeds |
| Date serialization inconsistency | Low | Low | Use `.toISOString()` consistently; verify in tests | Date format varies across responses |

## Test Strategy

**ONE Integration Test Suite:**

Test file: `backend/src/routes/clients.test.ts` (extend existing file)

**Test Cases:**
1. **Happy Path:** Admin successfully lists clients
   - Setup: Insert 2-3 test clients
   - Action: GET /api/v1/clients with admin JWT
   - Assert: 200 status, array length matches, all fields present and correctly formatted

2. **Authorization - No Token:** Request without Authorization header
   - Action: GET /api/v1/clients without auth
   - Assert: 401 status, error message present

3. **Authorization - Non-Admin:** Request with non-admin JWT
   - Setup: Generate JWT with role='user'
   - Action: GET /api/v1/clients with user JWT
   - Assert: 403 status, error message present

4. **Empty State:** No clients exist
   - Setup: Clean database (no clients)
   - Action: GET /api/v1/clients with admin JWT
   - Assert: 200 status, empty array `[]`

**Testing Environment:**
- Run tests in Docker container: `docker exec -it dfwsc20-api-1 npm test`
- Use vitest framework (already configured)
- Leverage existing test patterns from `clients.test.ts`

## References

**Ticket:** `memory-bank/tickets/03-client-management-api.md`

**Key Files:**
- Database Schema: `backend/src/db/schema.ts:3-13` (clients table definition)
- Auth Middleware: `backend/src/lib/auth.ts:48-90` (requireAdminJwt function)
- Existing Client Routes: `backend/src/routes/clients.ts` (PATCH endpoint as reference)
- Existing Tests: `backend/src/routes/clients.test.ts` (test patterns to follow)
- Route Registration: `backend/src/app.ts:121` (clientRoutes registration)
- Connect Routes: `backend/src/routes/connect.ts:28-59` (POST /accounts with requireAdminJwt)

**Verification Points:**
- ✅ `POST /api/v1/accounts` already protected by `requireAdminJwt` (line 32 in connect.ts)
- ✅ Database schema supports all required fields
- ✅ Auth middleware is battle-tested in existing endpoints

## Architecture Notes

**Existing Pattern to Follow:**
```typescript
// Route structure (from clients.ts PATCH endpoint)
app.get<{ Querystring: QueryInterface }>('/api/v1/clients',
  { preHandler: requireAdminJwt },
  async (req, res) => {
    // 1. Query database using Drizzle ORM
    // 2. Format response data
    // 3. Return 200 with JSON array
  }
);
```

**Database Query Pattern:**
```typescript
// Use Drizzle ORM select (from existing code)
const clientList = await db
  .select({
    id: clients.id,
    name: clients.name,
    email: clients.email,
    stripeAccountId: clients.stripeAccountId,
    status: clients.status,
    createdAt: clients.createdAt,
  })
  .from(clients);
```

**Response Format:**
```typescript
// Map to ensure proper date serialization
return res.status(200).send(
  clientList.map(client => ({
    ...client,
    createdAt: client.createdAt?.toISOString(),
  }))
);
```

## Alternative Approach (Not Primary)

**Option B: Add Pagination from Start**
- Pros: Better scalability, prevents large payload issues
- Cons: Over-engineering for current needs, ticket explicitly says "can be added later"
- Decision: Stick with simple list endpoint; add pagination when needed (YAGNI principle)

## Subagent Deployment Strategy

**Deploy 2 subagents in parallel for context synthesis:**

1. **codebase-analyzer agent** - Analyze existing patterns
   - Task: Review auth middleware implementation and test patterns
   - Output: Confirm best practices for new endpoint

2. **context-synthesis agent** - Validate implementation approach
   - Task: Cross-reference ticket requirements with existing codebase patterns
   - Output: Identify any edge cases or gaps

**Maximum 2 subagents** (within 3-agent limit) to maintain focus on singular execution goal.

## Final Gate

**Summary:**
- **Plan Path:** `/home/jeremy/jcFolder/dfwsc/dfwsc2.0/memory-bank/plan/2026-01-13_14-27-37_client-management-api.md`
- **Milestones:** 3 (Implementation → Testing → Verification)
- **Tasks:** 3 focused tasks with clear acceptance criteria
- **Primary Goal:** Add GET /api/v1/clients endpoint with admin authentication
- **Test Strategy:** ONE comprehensive integration test suite with 4 test cases

**Gates:**
1. ✅ Code compiles and TypeScript validation passes
2. ✅ All new tests pass (minimum 4 test cases)
3. ✅ Existing test suite passes (no regressions)
4. ✅ Manual verification in Docker environment succeeds

**Next Command:**
```bash
/execute "/home/jeremy/jcFolder/dfwsc/dfwsc2.0/memory-bank/plan/2026-01-13_14-27-37_client-management-api.md"
```

---

**Plan Status:** Ready for Execution
**Estimated Effort:** Small (< 1 hour total)
**Risk Level:** Low
**Dependencies:** None (all prerequisites met)
