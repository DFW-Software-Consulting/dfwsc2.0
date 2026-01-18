---
title: "Frontend Logging Utility – Plan"
phase: Plan
date: "2026-01-17T23:45:00Z"
owner: "agent"
parent_research: "memory-bank/tickets/2026-01-17/06-frontend-logging-utility.md"
git_commit_at_plan: "c4e7e6f"
tags: [plan, frontend, logging, utility]
---

## Goal

**Create a minimal logging utility for the React frontend that centralizes all console.error calls and conditionally suppresses them in production builds.**

Non-goals:
- External error tracking services (Sentry, LogRocket)
- Complex log levels beyond error/warn/debug
- Server-side log shipping
- Adding new logging where none exists

## Scope & Assumptions

### In Scope
- Create a single `logger.js` utility file in `front/src/utils/`
- Replace 6 existing `console.error` calls with logger utility
- Environment-aware logging (verbose in dev, silent in prod)

### Out of Scope
- Adding logging to new locations
- Backend logging changes
- Log aggregation or external services
- Adding console.log or console.warn calls

### Assumptions
- Vite's `import.meta.env.MODE` is available for environment detection
- No additional npm dependencies required
- Existing error handling patterns (try-catch + toast) remain unchanged

## Deliverables (DoD)

| Artifact | Acceptance Criteria |
|----------|---------------------|
| `front/src/utils/logger.js` | Exports `logger.error()`, `logger.warn()`, `logger.debug()` methods |
| Updated components (6 files) | All `console.error` replaced with `logger.error` |
| Environment detection | Errors visible in dev (`import.meta.env.MODE === 'development'`), silent in prod |

## Readiness (DoR)

- [x] Frontend codebase accessible at `/home/messyginger0804/dfwsc/dfwsc2.0/front`
- [x] Vite build system in place with environment variable support
- [x] `utils/` directory exists at `front/src/utils/`
- [x] All 6 console.error locations identified

## Milestones

| ID | Milestone | Description |
|----|-----------|-------------|
| M1 | Logger utility | Create `logger.js` with environment-aware methods |
| M2 | Component updates | Replace all 6 console.error calls |
| M3 | Validation | Verify logging works in dev, silent in prod build |

## Work Breakdown (Tasks)

### T1: Create Logger Utility
- **Summary:** Create `front/src/utils/logger.js` with error/warn/debug methods
- **Owner:** agent
- **Dependencies:** None
- **Target:** M1
- **Files:** `front/src/utils/logger.js` (new)

**Implementation:**
```javascript
const isDev = import.meta.env.MODE === 'development';

export const logger = {
  error: (...args) => isDev && console.error(...args),
  warn: (...args) => isDev && console.warn(...args),
  debug: (...args) => isDev && console.log(...args),
};

export default logger;
```

### T2: Update OnboardClient.jsx
- **Summary:** Replace console.error at line 62
- **Owner:** agent
- **Dependencies:** T1
- **Target:** M2
- **Files:** `front/src/pages/OnboardClient.jsx`

### T3: Update AdminLogin.jsx
- **Summary:** Replace console.error at line 69
- **Owner:** agent
- **Dependencies:** T1
- **Target:** M2
- **Files:** `front/src/components/admin/AdminLogin.jsx`

### T4: Update CreateClientForm.jsx
- **Summary:** Replace console.error at lines 81 and 97
- **Owner:** agent
- **Dependencies:** T1
- **Target:** M2
- **Files:** `front/src/components/admin/CreateClientForm.jsx`

### T5: Update AdminDashboard.jsx
- **Summary:** Replace console.error at line 63
- **Owner:** agent
- **Dependencies:** T1
- **Target:** M2
- **Files:** `front/src/components/admin/AdminDashboard.jsx`

### T6: Update ClientList.jsx
- **Summary:** Replace console.error at line 70
- **Owner:** agent
- **Dependencies:** T1
- **Target:** M2
- **Files:** `front/src/components/admin/ClientList.jsx`

### T7: Validate Build
- **Summary:** Run `npm run build` in front/ to ensure no build errors
- **Owner:** agent
- **Dependencies:** T2-T6
- **Target:** M3

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| Import path issues | Medium | Low | Use consistent relative imports | Build fails |
| Missing environment variable | Low | Very Low | Vite provides MODE by default | Runtime errors |

## Test Strategy

**ONE test approach:** Manual validation via browser dev tools
1. Run `npm run dev` - verify errors appear in console during error scenarios
2. Run `npm run build && npm run preview` - verify errors do NOT appear in console

No automated test file needed - this is a logging utility that wraps console methods.

## References

- Ticket: `memory-bank/tickets/2026-01-17/06-frontend-logging-utility.md`
- Vite env docs: https://vitejs.dev/guide/env-and-mode.html
- Files to modify:
  - `front/src/pages/OnboardClient.jsx:62`
  - `front/src/components/admin/AdminLogin.jsx:69`
  - `front/src/components/admin/CreateClientForm.jsx:81,97`
  - `front/src/components/admin/AdminDashboard.jsx:63`
  - `front/src/components/admin/ClientList.jsx:70`

---

## Alternative Approach (Not Recommended)

**Option B: Use a logging library (loglevel, pino-browser)**

Pros:
- More features (log levels, formatters)
- Maintained by community

Cons:
- Adds dependency for 6 console.error calls
- Overkill for current scope
- Increases bundle size

**Decision:** Option A (custom utility) is preferred for simplicity.

---

## Final Gate

| Item | Value |
|------|-------|
| Plan path | `memory-bank/plan/2026-01-17_23-45-00_frontend-logging-utility.md` |
| Milestones | 3 |
| Tasks | 7 |
| Files to modify | 6 (+ 1 new) |
| Dependencies | None |
| Estimated complexity | Low |

**Next command:** `/ce-ex "memory-bank/plan/2026-01-17_23-45-00_frontend-logging-utility.md"`
