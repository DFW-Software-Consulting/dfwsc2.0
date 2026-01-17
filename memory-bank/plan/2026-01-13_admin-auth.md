---
title: "Admin Authentication – Plan"
phase: Plan
date: "2026-01-13"
owner: "Claude Code Agent"
parent_research: "memory-bank/tickets/01-admin-auth.md"
git_commit_at_plan: "N/A (not a git repository)"
tags: [plan, admin-auth, jwt, security]
---

## Goal
Implement JWT-based admin authentication to replace the insecure header-based `x-api-role` system. Admin users will authenticate via credentials stored in `.env`, receive a short-lived JWT token, and use that token to access admin-only endpoints.

**Non-Goals:**
- Multi-user admin system (single shared credential only)
- Password reset flows
- Refresh token mechanism
- Role-based permissions beyond admin/client distinction

## Scope & Assumptions

**In Scope:**
- Add environment variables for admin credentials and JWT secret
- Create `POST /api/v1/auth/login` endpoint for admin login
- Implement JWT signing and verification
- Replace `requireRole(['admin'])` with JWT-based middleware
- Rate limit the login endpoint
- Maintain existing client token flow (public onboarding)

**Out of Scope:**
- User registration/management UI
- OAuth or third-party authentication
- Session management beyond JWT expiry
- Audit logging (future enhancement)

**Assumptions:**
- Using `jsonwebtoken` library for JWT operations
- Using `bcrypt` or `bcryptjs` for password hashing
- JWT expiry set to 1 hour (configurable via env)
- Existing routes in `connect.ts` and `payments.ts` need protection
- Frontend will store JWT in localStorage/sessionStorage and send via Authorization header

**Constraints:**
- Must not break existing client onboarding flow (`GET /v1/onboard-client`)
- Must maintain backward compatibility during transition
- Keep dependencies minimal (2 new packages maximum)

## Deliverables (DoD)

1. **Environment Configuration**
   - `.env.example` updated with `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `JWT_SECRET`, `JWT_EXPIRY`
   - `src/lib/env.ts` validates new required variables
   - Acceptance: Server fails to start if JWT_SECRET missing

2. **Login Endpoint**
   - `POST /api/v1/auth/login` accepts `{ username, password }`
   - Returns `{ token, expiresIn }` on success, 401 on failure
   - Rate limited to 5 attempts per 15 minutes
   - Acceptance: Invalid credentials return 401, valid credentials return JWT

3. **JWT Middleware**
   - New `requireAdminJwt` middleware in `src/lib/auth.ts`
   - Validates JWT from `Authorization: Bearer <token>` header
   - Extracts role from JWT payload and verifies `role === 'admin'`
   - Acceptance: Requests without valid JWT are rejected with 401

4. **Protected Routes**
   - `POST /v1/accounts` uses `requireAdminJwt`
   - `POST /v1/onboard-client/initiate` uses `requireAdminJwt`
   - `GET /v1/reports/payments` uses `requireAdminJwt`
   - `POST /v1/payments/create` continues to allow both admin and client (future: client JWT)
   - Acceptance: Admin routes reject requests without valid JWT

5. **Test Coverage**
   - Login endpoint test (valid/invalid credentials)
   - JWT middleware test (valid/expired/malformed tokens)
   - Protected route integration test
   - Acceptance: All tests pass with >80% coverage on new code

## Readiness (DoR)

**Required Before Starting:**
- ✅ Access to `dfwsc2.0/backend` codebase
- ✅ Understanding of current auth system (`requireRole` in `src/lib/auth.ts`)
- ✅ List of admin-protected routes identified
- ⚠️ Decision on password hashing: bcrypt vs bcryptjs (recommend bcryptjs for pure JS)
- ⚠️ JWT expiry duration confirmed (default: 1 hour)

**Environment Setup:**
- Node.js environment available for `npm install`
- Test database available (or mocked)
- Vitest test runner configured

**Dependencies to Install:**
- `jsonwebtoken` and `@types/jsonwebtoken`
- `bcryptjs` and `@types/bcryptjs`

## Milestones

### M1: Foundation & Dependencies (Setup)
- Install JWT and bcrypt packages
- Update environment configuration system
- Add new env vars to `.env.example`
- Validate env vars in `src/lib/env.ts`

### M2: Authentication Core (Login & JWT)
- Create auth route file `src/routes/auth.ts`
- Implement `POST /api/v1/auth/login` endpoint
- Add password hashing utility functions
- Implement JWT signing with role claim
- Add rate limiting to login endpoint

### M3: Authorization Middleware (JWT Verification)
- Create `requireAdminJwt` middleware in `src/lib/auth.ts`
- Parse and verify JWT from Authorization header
- Extract and validate role claim
- Handle expired/invalid tokens gracefully

### M4: Route Protection (Apply Middleware)
- Update `src/routes/connect.ts` to use `requireAdminJwt`
- Update `src/routes/payments.ts` admin routes
- Register auth routes in `src/app.ts`
- Verify public routes remain public

### M5: Testing & Validation (Quality Gate)
- Write unit tests for login endpoint
- Write unit tests for JWT middleware
- Write integration tests for protected routes
- Test rate limiting behavior
- Manual smoke test with curl/Postman

## Work Breakdown (Tasks)

### Task 1.1: Install Dependencies
**Owner:** Dev
**Estimate:** 5 min
**Dependencies:** None
**Milestone:** M1

**Acceptance Tests:**
- [ ] `package.json` includes `jsonwebtoken@^9.0.0`
- [ ] `package.json` includes `bcryptjs@^2.4.3`
- [ ] `npm install` completes without errors
- [ ] TypeScript types installed for both packages

**Files/Interfaces:**
- `package.json`

---

### Task 1.2: Update Environment Configuration
**Owner:** Dev
**Estimate:** 10 min
**Dependencies:** None
**Milestone:** M1

**Acceptance Tests:**
- [ ] `.env.example` contains `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `JWT_SECRET`, `JWT_EXPIRY`
- [ ] `src/lib/env.ts` adds JWT_SECRET to `REQUIRED_ENV_VARS`
- [ ] `src/lib/env.ts` adds ADMIN_USERNAME, ADMIN_PASSWORD to `REQUIRED_ENV_VARS`
- [ ] `src/lib/env.ts` adds JWT_EXPIRY to `OPTIONAL_ENV_VARS` (default: "1h")
- [ ] Server throws error on startup if JWT_SECRET missing

**Files/Interfaces:**
- `backend/.env.example`
- `backend/src/lib/env.ts`

---

### Task 2.1: Create Auth Route with Login Endpoint
**Owner:** Dev
**Estimate:** 30 min
**Dependencies:** Task 1.1, Task 1.2
**Milestone:** M2

**Acceptance Tests:**
- [ ] `POST /api/v1/auth/login` endpoint exists
- [ ] Accepts JSON body with `username` and `password`
- [ ] Returns 400 if username or password missing
- [ ] Returns 401 if credentials invalid
- [ ] Returns 200 with `{ token, expiresIn }` if credentials valid
- [ ] Token is a valid JWT with payload `{ role: 'admin', iat, exp }`
- [ ] Rate limit of 5 requests per 15 minutes applied

**Files/Interfaces:**
- `backend/src/routes/auth.ts` (new file)
- `backend/src/app.ts` (register route)

---

### Task 2.2: Implement Password Verification Utility
**Owner:** Dev
**Estimate:** 10 min
**Dependencies:** Task 1.1
**Milestone:** M2

**Acceptance Tests:**
- [ ] Function `verifyPassword(plaintext: string, hashed: string): Promise<boolean>` exists
- [ ] Function uses `bcryptjs.compare()` internally
- [ ] Function returns true for matching passwords
- [ ] Function returns false for non-matching passwords

**Files/Interfaces:**
- `backend/src/lib/auth.ts` (add utility function)

---

### Task 2.3: Implement JWT Signing Utility
**Owner:** Dev
**Estimate:** 10 min
**Dependencies:** Task 1.1, Task 1.2
**Milestone:** M2

**Acceptance Tests:**
- [ ] Function `signJwt(payload: { role: string }): string` exists
- [ ] Uses `JWT_SECRET` from environment
- [ ] Sets expiry based on `JWT_EXPIRY` env var (default "1h")
- [ ] Returns valid JWT string

**Files/Interfaces:**
- `backend/src/lib/auth.ts` (add utility function)

---

### Task 3.1: Create JWT Verification Middleware
**Owner:** Dev
**Estimate:** 25 min
**Dependencies:** Task 2.3
**Milestone:** M3

**Acceptance Tests:**
- [ ] Middleware `requireAdminJwt` exists in `src/lib/auth.ts`
- [ ] Reads `Authorization` header (format: "Bearer <token>")
- [ ] Returns 401 if header missing or malformed
- [ ] Returns 401 if token signature invalid
- [ ] Returns 401 if token expired
- [ ] Returns 403 if role is not 'admin'
- [ ] Allows request to proceed if token valid and role is 'admin'
- [ ] Attaches decoded payload to `request.user` (optional enhancement)

**Files/Interfaces:**
- `backend/src/lib/auth.ts` (new middleware function)

---

### Task 4.1: Apply JWT Middleware to Connect Routes
**Owner:** Dev
**Estimate:** 10 min
**Dependencies:** Task 3.1
**Milestone:** M4

**Acceptance Tests:**
- [ ] `POST /v1/accounts` preHandler uses `requireAdminJwt` instead of `requireRole(['admin'])`
- [ ] `POST /v1/onboard-client/initiate` preHandler uses `requireAdminJwt`
- [ ] `GET /v1/onboard-client` remains public (no auth required)
- [ ] `GET /v1/connect/callback` remains public

**Files/Interfaces:**
- `backend/src/routes/connect.ts` (lines 32, 65)

---

### Task 4.2: Apply JWT Middleware to Payment Routes
**Owner:** Dev
**Estimate:** 10 min
**Dependencies:** Task 3.1
**Milestone:** M4

**Acceptance Tests:**
- [ ] `GET /v1/reports/payments` preHandler uses `requireAdminJwt` instead of `requireRole(['admin'])`
- [ ] `POST /v1/payments/create` continues to use `requireRole(['admin', 'client'])` (note for future: implement client JWT)

**Files/Interfaces:**
- `backend/src/routes/payments.ts` (line 140)

---

### Task 4.3: Register Auth Routes in App
**Owner:** Dev
**Estimate:** 5 min
**Dependencies:** Task 2.1
**Milestone:** M4

**Acceptance Tests:**
- [ ] Auth routes registered in `src/app.ts` with prefix `/api/v1`
- [ ] Login endpoint accessible at `POST /api/v1/auth/login`

**Files/Interfaces:**
- `backend/src/app.ts` (add `authRoutes` import and registration)

---

### Task 5.1: Write Login Endpoint Tests
**Owner:** Dev
**Estimate:** 20 min
**Dependencies:** Task 2.1, Task 4.3
**Milestone:** M5

**Acceptance Tests:**
- [ ] Test file `src/__tests__/auth.test.ts` exists
- [ ] Test: Invalid credentials return 401
- [ ] Test: Missing username/password returns 400
- [ ] Test: Valid credentials return 200 with JWT
- [ ] Test: Returned JWT is valid and contains `role: 'admin'`
- [ ] Test: Rate limiting triggers after 5 failed attempts

**Files/Interfaces:**
- `backend/src/__tests__/auth.test.ts` (new file)

---

### Task 5.2: Write JWT Middleware Tests
**Owner:** Dev
**Estimate:** 20 min
**Dependencies:** Task 3.1
**Milestone:** M5

**Acceptance Tests:**
- [ ] Test file `src/__tests__/jwt-middleware.test.ts` exists
- [ ] Test: Missing Authorization header returns 401
- [ ] Test: Malformed token returns 401
- [ ] Test: Expired token returns 401
- [ ] Test: Invalid signature returns 401
- [ ] Test: Valid token with admin role allows request
- [ ] Test: Valid token with non-admin role returns 403

**Files/Interfaces:**
- `backend/src/__tests__/jwt-middleware.test.ts` (new file)

---

### Task 5.3: Write Protected Route Integration Tests
**Owner:** Dev
**Estimate:** 15 min
**Dependencies:** Task 4.1, Task 4.2
**Milestone:** M5

**Acceptance Tests:**
- [ ] Test: `POST /v1/accounts` without JWT returns 401
- [ ] Test: `POST /v1/accounts` with valid JWT succeeds
- [ ] Test: `POST /v1/onboard-client/initiate` without JWT returns 401
- [ ] Test: `GET /v1/reports/payments` without JWT returns 401
- [ ] Test: `GET /v1/onboard-client` works without authentication (public)

**Files/Interfaces:**
- `backend/src/__tests__/protected-routes.test.ts` (new file)

---

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| JWT_SECRET leaked in .env file | **Critical** - Full system compromise | Medium | Add `.env` to `.gitignore`, document rotation procedure, use strong random secret (32+ chars) | Security audit, accidental commit |
| Admin password stored in plaintext | **High** - Credential exposure | Medium | Recommend hashing password in `.env` during setup (pre-hash with bcrypt), add documentation | Review `.env.example` |
| Token expiry too long | **Medium** - Extended unauthorized access window | Low | Default to 1 hour, make configurable via `JWT_EXPIRY` env var | Security review |
| Rate limiting bypassed via IP rotation | **Medium** - Brute force attacks | Low | Consider additional rate limiting at load balancer level (out of scope) | Monitor failed login attempts |
| Breaking existing client flows | **High** - Client onboarding broken | Low | Maintain public routes, add integration tests for public endpoints | Test coverage, staging validation |
| Missing TypeScript types | **Low** - Development friction | Low | Install @types packages, verify TS compilation | Build failure |

## Test Strategy

**Primary Test Focus:** Login endpoint security and JWT middleware validation

**Test Types:**
1. **Unit Tests** (Priority: High)
   - Login endpoint credential validation
   - JWT signing and verification functions
   - Password comparison utility
   - Middleware token parsing logic

2. **Integration Tests** (Priority: High)
   - End-to-end login flow (POST /auth/login → receive token → access protected route)
   - Protected routes reject invalid tokens
   - Public routes remain accessible
   - Rate limiting behavior

3. **Manual Testing** (Priority: Medium)
   - curl/Postman workflow validation
   - Token expiry behavior verification
   - Error message clarity

**Test Data:**
- Valid admin credentials from `.env`
- Invalid credentials (wrong password, wrong username, missing fields)
- Valid JWT, expired JWT, malformed JWT, missing JWT
- Admin role payload, non-admin role payload

**Coverage Goal:** >85% on new code (auth routes, middleware, utilities)

**Test Execution:**
- Run via `npm test` (Vitest)
- CI integration optional (not in scope)

**One Key Test:**
**Test: Admin Login and Protected Route Access**
```typescript
describe('Admin Authentication Flow', () => {
  it('should login and access protected route with JWT', async () => {
    // 1. Login with valid credentials
    const loginRes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'password123' }
    });
    expect(loginRes.statusCode).toBe(200);
    const { token } = JSON.parse(loginRes.body);
    expect(token).toBeTruthy();

    // 2. Access protected route with JWT
    const protectedRes = await server.inject({
      method: 'POST',
      url: '/api/v1/accounts',
      headers: { 'Authorization': `Bearer ${token}` },
      payload: { name: 'Test Client', email: 'test@example.com' }
    });
    expect(protectedRes.statusCode).toBe(201);

    // 3. Verify access denied without JWT
    const unauthRes = await server.inject({
      method: 'POST',
      url: '/api/v1/accounts',
      payload: { name: 'Test Client', email: 'test@example.com' }
    });
    expect(unauthRes.statusCode).toBe(401);
  });
});
```

## References

**Ticket:** `memory-bank/tickets/01-admin-auth.md`

**Current Implementation:**
- Auth system: `backend/src/lib/auth.ts:1-14` (requireRole function)
- Protected routes:
  - `backend/src/routes/connect.ts:32` (POST /accounts)
  - `backend/src/routes/connect.ts:65` (POST /onboard-client/initiate)
  - `backend/src/routes/payments.ts:140` (GET /reports/payments)
- Environment config: `backend/src/lib/env.ts:1-67`
- App setup: `backend/src/app.ts:1-128`

**External Documentation:**
- [jsonwebtoken npm](https://www.npmjs.com/package/jsonwebtoken)
- [bcryptjs npm](https://www.npmjs.com/package/bcryptjs)
- [Fastify Authentication Docs](https://fastify.dev/docs/latest/Reference/Hooks/#prehandler)
- [JWT Best Practices](https://tools.ietf.org/html/rfc8725)

## Agents

This plan supports parallel execution via 2 specialized subagents:

1. **context-synthesis** - Post-implementation review
   - Analyze implemented auth flow for security gaps
   - Verify all admin routes protected
   - Check for credential leakage or insecure patterns
   - Validate test coverage adequacy

2. **codebase-analyzer** - Pre-implementation reconnaissance
   - Identify all current usages of `requireRole(['admin'])`
   - Map all admin-only endpoints requiring protection
   - Check for existing JWT or auth libraries
   - Verify environment configuration patterns

**Maximum Concurrent Agents:** 2 (as per constraint)

## Alternative Approach (Low Priority)

**Option 2: Session-Based Authentication**
Instead of JWT, use server-side sessions with Redis/in-memory store.

**Pros:**
- Server-side revocation (logout works instantly)
- No token expiry concerns
- Slightly simpler client implementation

**Cons:**
- Requires session store (Redis dependency or memory store)
- Not stateless (horizontal scaling requires sticky sessions or shared store)
- More complex infrastructure

**Recommendation:** Stick with JWT (Option 1) for stateless simplicity and alignment with modern API patterns. Session-based auth adds infrastructure overhead not justified for single-admin use case.

---

## Final Gate

**Summary:**
- **Plan Path:** `memory-bank/plan/2026-01-13_admin-auth.md`
- **Milestones:** 5 (Setup → Auth Core → Middleware → Route Protection → Testing)
- **Tasks:** 11 concrete tasks with clear acceptance criteria
- **Estimated Effort:** ~2.5 hours of focused development
- **Key Risks:** JWT_SECRET security, backward compatibility
- **Test Coverage:** 1 primary integration test + comprehensive unit tests

**Next Steps:**
Execute this plan using:
```bash
/execute "memory-bank/plan/2026-01-13_admin-auth.md"
```

**Validation Checklist Before Execution:**
- [ ] Confirm JWT expiry duration (default 1h acceptable?)
- [ ] Confirm admin password should be plaintext in .env (recommend bcrypt pre-hash)
- [ ] Confirm rate limit settings (5 attempts per 15 min acceptable?)
- [ ] Confirm no breaking changes to client onboarding flow

**Ready for Execution:** YES ✅
