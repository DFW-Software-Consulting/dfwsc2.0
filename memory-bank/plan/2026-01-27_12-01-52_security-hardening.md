---
title: "Security Hardening – Plan"
phase: Plan
date: "2026-01-27_12-01-52"
owner: "agent"
parent_research: "memory-bank/tickets/2026-01-27_security-hardening.md"
git_commit_at_plan: "2ff452e"
tags: [plan, security, hardening, defense-in-depth]
---

## Goal

**Singular Focus**: Implement three defense-in-depth security improvements to the DFWSC payment portal:
1. RFC-compliant email validation
2. Production enforcement of bcrypt-hashed admin passwords
3. HTML escaping in email templates

**Non-Goals**:
- Addressing any new security vulnerabilities (none identified)
- Refactoring beyond the specific hardening tasks
- Adding comprehensive test suites

## Scope & Assumptions

### In Scope
- `backend/src/routes/connect.ts` - Email validation and HTML template escaping
- `backend/src/routes/auth.ts` - Production password enforcement
- Adding two lightweight npm packages: `validator` and `he`

### Out of Scope
- Frontend changes
- Database schema changes
- New API endpoints
- Breaking changes to existing behavior (graceful degradation preserved)

### Assumptions
- Docker environment is operational
- Node.js container can install npm packages
- Current bcrypt implementation in `lib/auth.ts` is functioning correctly

## Deliverables (DoD)

| Deliverable | Acceptance Criteria |
|------------|---------------------|
| Email validation | Uses `validator.isEmail()` for RFC 5322 compliance |
| Password enforcement | Server refuses to start if `NODE_ENV=production` AND `ADMIN_PASSWORD` is not bcrypt-hashed |
| HTML escaping | `name` variable in email template is escaped using `he.encode()` |
| Test | ONE integration test verifying production password enforcement |

## Readiness (DoR)

- [x] Target files identified and analyzed
- [x] Current git state captured (2ff452e)
- [x] No drift detected since research
- [x] Dependencies identified (`validator`, `he`)
- [ ] Docker environment running (verify before execution)

## Milestones

| Milestone | Description | Gate Criteria |
|-----------|-------------|---------------|
| **M1** | Dependencies & setup | `npm install` succeeds, types resolve |
| **M2** | Email validation hardening | Validation rejects invalid emails, accepts valid |
| **M3** | HTML escaping in templates | `name` field escaped in email HTML |
| **M4** | Password enforcement | Server startup fails on plaintext password in production |
| **M5** | Test & verification | One test passes, `docker-compose up` succeeds |

## Work Breakdown (Tasks)

### Task 1: Install Dependencies
- **ID**: T1
- **Summary**: Add `validator` and `he` packages
- **Owner**: Agent
- **Dependencies**: None
- **Target Milestone**: M1
- **Files/Interfaces**: `backend/package.json`
- **Acceptance Tests**:
  - `npm install` completes without errors
  - Packages appear in `node_modules`
  - TypeScript recognizes types (`@types/he`, `@types/validator`)

### Task 2: Implement Email Validation
- **ID**: T2
- **Summary**: Replace basic `@` check with `validator.isEmail()`
- **Owner**: Agent
- **Dependencies**: T1
- **Target Milestone**: M2
- **Files/Interfaces**: `backend/src/routes/connect.ts:123-125`
- **Acceptance Tests**:
  - Rejects `"invalid"`, `"test@"`, `"@domain.com"`, `"test@.com"`
  - Accepts `"user@example.com"`, `"name+tag@domain.org"`

### Task 3: Implement HTML Escaping
- **ID**: T3
- **Summary**: Escape `name` variable using `he.encode()` in email template
- **Owner**: Agent
- **Dependencies**: T1
- **Target Milestone**: M3
- **Files/Interfaces**: `backend/src/routes/connect.ts:206-212`
- **Acceptance Tests**:
  - Input `<script>alert(1)</script>` renders as HTML entities
  - Normal names render unchanged

### Task 4: Production Password Enforcement
- **ID**: T4
- **Summary**: Add startup check that rejects plaintext passwords when `NODE_ENV=production`
- **Owner**: Agent
- **Dependencies**: None
- **Target Milestone**: M4
- **Files/Interfaces**: `backend/src/routes/auth.ts` (near top, before route registration)
- **Acceptance Tests**:
  - `NODE_ENV=production` + plaintext password = startup failure with clear error
  - `NODE_ENV=production` + bcrypt hash = normal startup
  - `NODE_ENV=development` + plaintext = warning only (existing behavior)

### Task 5: Write Integration Test
- **ID**: T5
- **Summary**: ONE test for production password enforcement
- **Owner**: Agent
- **Dependencies**: T4
- **Target Milestone**: M5
- **Files/Interfaces**: `backend/src/__tests__/auth.test.ts` (create if needed)
- **Acceptance Tests**:
  - Test verifies startup behavior with plaintext vs hashed password

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| `validator` package version incompatibility | Medium | Low | Pin version, test in Docker | Build fails |
| Email validation too strict | Medium | Low | Use default `validator.isEmail()` options | User reports valid email rejected |
| Startup check breaks dev workflow | High | Medium | Only enforce in `production` env | Dev startup fails |

## Test Strategy

**ONE test only** (as specified):

```typescript
// backend/src/__tests__/auth-startup.test.ts
describe('Production password enforcement', () => {
  it('should reject plaintext password in production mode', () => {
    // Test that startup validation function throws when:
    // - NODE_ENV=production
    // - ADMIN_PASSWORD does not start with $2a$, $2b$, or $2y$
  });
});
```

## References

- Parent ticket: `memory-bank/tickets/2026-01-27_security-hardening.md`
- Target files:
  - `backend/src/routes/connect.ts:123-125` (email validation)
  - `backend/src/routes/connect.ts:206-212` (email template)
  - `backend/src/routes/auth.ts:48-52` (password handling)
- Existing utilities: `backend/src/lib/auth.ts` (bcrypt helpers)

## Execution Order

```
T1 (deps) → T2 (email validation) ─┬→ T5 (test) → Verify
           T3 (HTML escape) ───────┤
           T4 (password enforce) ──┘
```

Tasks T2, T3, T4 can run in parallel after T1 completes.

---

## Alternative Approach (Optional)

**Minimal approach**: Skip `validator` package, use regex for email validation:
```typescript
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
```
- Pros: No new dependency
- Cons: Less robust than RFC-compliant validation
- **Recommendation**: Use `validator` for proper RFC compliance

---

## Final Gate

| Item | Value |
|------|-------|
| Plan path | `memory-bank/plan/2026-01-27_12-01-52_security-hardening.md` |
| Milestones | 5 |
| Tasks | 5 |
| Tests | 1 |
| Files modified | 3 (`package.json`, `connect.ts`, `auth.ts`) |
| New files | 1 (test file) |

**Next command**: `/ce-ex "memory-bank/plan/2026-01-27_12-01-52_security-hardening.md"`
