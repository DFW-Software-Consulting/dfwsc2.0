# 2026-01-27 Admin Reset Path

## Summary
Provide a safe admin credential recovery mechanism through a one-time browser-accessible endpoint (no CLI path).

## Priority
Medium - Operational safety and access recovery

## Tasks

### 1. One-Time Setup Endpoint + Admin UI
**Goal:** Enable admin setup only when no admin is configured.
**Constraints:**
- Endpoint should be enabled only when `ALLOW_ADMIN_SETUP=true`
- Must be disabled automatically after first successful setup
- Optionally require `ADMIN_SETUP_TOKEN` header for extra protection
 - `/admin` should show a first-time setup form when backend indicates no admin configured

---

### 2. Implement One-Time Setup Endpoint
**Files:** `backend/src/routes/auth.ts` (or new route)

**Recommendation:**
- Only allow if a configured flag `ALLOW_ADMIN_SETUP=true` and no admin exists
- Disable automatically after first successful setup
- Return bcrypt hash so it can be persisted in environment variables
- Provide a lightweight status check for admin setup (e.g., `GET /api/v1/auth/setup/status`)

---

### 3. Admin UI Integration
**Files:** `front/src/pages/AdminPage.jsx` (and related components)

**Recommendation:**
- On load, call setup status endpoint
- If setup is allowed and no admin configured, show setup form instead of login
- Show clear instructions to persist returned hash in environment variables

---

### 4. Documentation
**Files:** `backend/README.md`, `backend/documentation/docs/deployment.md`, `front/README.md`

**Recommendation:**
- Explain the recommended reset flow and security implications

## Acceptance Criteria
- [ ] One-time setup endpoint implemented (no CLI path)
- [ ] Endpoint disabled after first successful setup
- [ ] Optional setup token supported
- [ ] Docs updated with recovery steps

## Notes
- Avoid always-on unauthenticated reset endpoints
- Endpoint should only be enabled when explicitly configured
