---
title: "Frontend Core Flow Tests – Plan"
phase: Plan
date: "2026-01-17_20-34-01"
owner: "agent"
parent_research: "memory-bank/tickets/2026-01-17/09-tests-frontend-core-flows.md"
git_commit_at_plan: "0ada7a1"
tags: [plan, tests, frontend, vitest, react-testing-library]
---

## Goal

**Add ONE automated test file covering both the onboarding and payment/client creation flows using Vitest + React Testing Library.**

Non-goals:
- E2E testing (Playwright/Cypress) - out of scope
- Full test coverage - only core happy paths
- Refactoring existing components

## Scope & Assumptions

### In Scope
- Install Vitest + @testing-library/react + jsdom
- Configure Vitest for React component testing
- Create ONE test file covering:
  1. OnboardClient.jsx - token extraction and redirect behavior
  2. CreateClientForm.jsx - form validation and submission
- Document test commands in README or CLAUDE.md

### Out of Scope
- E2E browser tests
- Backend API mocking beyond simple fetch mocks
- Coverage thresholds or CI integration
- Testing every component

### Assumptions
- Vite build system already configured (confirmed)
- React 18.2.0 is test-compatible (confirmed)
- Docker environment not required for unit tests

## Deliverables (DoD)

| Deliverable | Acceptance Criteria |
|-------------|---------------------|
| Vitest config | `vitest.config.js` exists, `npm test` runs |
| Test file | `src/__tests__/coreFlows.test.jsx` exists with passing tests |
| Onboarding test | At least 1 test for OnboardClient token handling |
| Client creation test | At least 1 test for CreateClientForm validation/submission |
| Documentation | Test command documented in CLAUDE.md |

## Readiness (DoR)

- [x] Frontend code available in `/front`
- [x] package.json accessible for dependency addition
- [x] vite.config.js exists for extension
- [x] Target components identified: OnboardClient.jsx, CreateClientForm.jsx

## Milestones

| ID | Milestone | Gate |
|----|-----------|------|
| M1 | Testing infrastructure | `npm test` runs without error |
| M2 | Core flow tests | Both tests pass |
| M3 | Documentation | Instructions added to CLAUDE.md |

## Work Breakdown (Tasks)

| ID | Task | Owner | Dependencies | Milestone |
|----|------|-------|--------------|-----------|
| T1 | Install test dependencies (vitest, @testing-library/react, @testing-library/user-event, jsdom) | agent | none | M1 |
| T2 | Create vitest.config.js with React/jsdom setup | agent | T1 | M1 |
| T3 | Add test setup file for jsdom globals | agent | T1 | M1 |
| T4 | Create coreFlows.test.jsx with onboarding test | agent | T2, T3 | M2 |
| T5 | Add client creation form test to same file | agent | T4 | M2 |
| T6 | Update CLAUDE.md with test instructions | agent | T5 | M3 |

### Task Details

**T1: Install test dependencies**
- Files: `front/package.json`
- Command: `npm install -D vitest @testing-library/react @testing-library/user-event jsdom`
- Acceptance: Dependencies appear in devDependencies

**T2: Create vitest.config.js**
- Files: `front/vitest.config.js`
- Acceptance: Config exports test environment as jsdom, includes React plugin

**T3: Add test setup file**
- Files: `front/src/test/setup.js`
- Acceptance: Setup file configures jsdom globals if needed

**T4: Create onboarding test**
- Files: `front/src/__tests__/coreFlows.test.jsx`
- Test: OnboardClient extracts token from URL and renders loading state
- Acceptance: Test passes with `npm test`

**T5: Add client creation test**
- Files: `front/src/__tests__/coreFlows.test.jsx` (same file)
- Test: CreateClientForm validates required fields and shows errors
- Acceptance: Test passes with `npm test`

**T6: Update documentation**
- Files: `CLAUDE.md`
- Acceptance: Contains `npm test` or equivalent command in frontend section

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| Vite/Vitest version conflict | High | Low | Pin vitest to ^3.0.0 | Install fails |
| Component has hard-coded fetch | Medium | Medium | Mock global fetch in setup | Test hangs |
| sessionStorage access in tests | Low | Medium | jsdom provides mock | Test throws |

## Test Strategy

**ONE test file: `front/src/__tests__/coreFlows.test.jsx`**

Contains:
1. `describe('OnboardClient')` - Tests token extraction from URL params
2. `describe('CreateClientForm')` - Tests form validation (empty fields, invalid email)

Mock strategy:
- Mock `fetch` globally to prevent real API calls
- Use `MemoryRouter` from react-router-dom for URL simulation
- Mock sessionStorage if needed via jsdom

## References

- Ticket: `memory-bank/tickets/2026-01-17/09-tests-frontend-core-flows.md`
- OnboardClient: `front/src/pages/OnboardClient.jsx`
- CreateClientForm: `front/src/components/admin/CreateClientForm.jsx`
- Vitest docs: https://vitest.dev/guide/

---

## Summary

| Item | Value |
|------|-------|
| Plan path | `memory-bank/plan/2026-01-17_20-34-01_tests-frontend-core-flows.md` |
| Milestones | 3 (Infrastructure → Tests → Docs) |
| Tasks | 6 |
| Test files | 1 |
| Gate | All tests pass, documentation updated |
| Next command | `/ce-ex memory-bank/plan/2026-01-17_20-34-01_tests-frontend-core-flows.md` |
