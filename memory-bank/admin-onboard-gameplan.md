# Admin + Client Onboarding Gameplan

## Goal
Keep `/onboard` as a shared entry page with two paths:
- **DFWSC employee login** (single shared admin credential from `.env`)
- **Client onboarding token** (existing flow to Stripe)

After employee login, show an admin dashboard on the same `/onboard` page to manage clients and generate onboarding tokens.

## Current State (Baseline)
- **Frontend**: `/onboard` is a client token entry page that calls `GET /v1/onboard-client?token=...`.
- **Backend**:
  - `POST /v1/accounts` creates `clients` + `onboarding_tokens` and returns a token + link hint.
  - `POST /v1/onboard-client/initiate` sends token via email.
  - `GET /v1/onboard-client` exchanges token for Stripe account link.
- **Auth**: Only `x-api-role` header (no real auth).

## Proposed Changes

### 1) Admin Auth (Simple Shared Credentials)
**Env vars**
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `JWT_SECRET`

**Backend**
- Add `POST /api/v1/auth/login`:
  - Validates `ADMIN_USERNAME` + `ADMIN_PASSWORD`.
  - Returns a short-lived JWT (e.g., 15-30 min) with `{ role: 'admin' }`.
- Add `requireAdminJwt` middleware:
  - Reads `Authorization: Bearer <token>`.
  - Verifies JWT and injects role/admin identity.
  - Replaces reliance on `x-api-role` for admin routes.

### 2) Client Management API (Admin-only)
- `GET /api/v1/clients`
  - Returns list of clients (name, email, stripeAccountId, status, createdAt).
- `POST /api/v1/accounts`
  - Keep current behavior: create client + token.
  - Require admin JWT.
- `PATCH /api/v1/clients/:id`
  - Soft delete: set `status = 'inactive'`.
  - Optional: prevent new tokens for inactive clients.

### 3) Database Updates
- Add `status` field to `clients` table:
  - Enum/string: `active | inactive`.
  - Default `active`.

### 4) Frontend Flow on `/onboard`
**Layout**
- Two cards or tabs:
  1) **Employee Login** (username + password)
  2) **Client Onboarding** (token input, current flow)

**After Login**
- Replace employee login card with **Admin Dashboard** on the same route:
  - List clients
  - Button: “Create New Client” → opens modal/form
  - Show generated token + onboarding link
  - Action: “Deactivate” client (soft delete)

**State**
- Store JWT in `sessionStorage`.
- If JWT exists/valid, auto-show dashboard.
- If JWT missing/expired, show login form.

## Suggested UI/UX
- `/onboard` title: “Onboarding Portal”
- Left card: Employee Login / Admin Dashboard
- Right card: Client token entry (unchanged behavior)
- Confirmations for deactivation
- Copy buttons for token/link

## Open Questions
- Should inactive clients be hidden or visible with status?
- Token expiration policy? (optional: add `expires_at` in `onboarding_tokens`)
- Should new tokens be blocked for inactive clients?

## Implementation Order
1) Add admin auth route + JWT middleware.
2) Add `status` to clients + migration.
3) Add clients list + deactivate endpoints.
4) Update `/onboard` UI to include login + dashboard + existing token flow.
5) Update docs + env example.

## Risks / Notes
- JWT secret must be set in production.
- Keeping admin login on same route is simple but ensure UI makes the “employee vs client” choice obvious.
- Consider rate limiting login and token generation endpoints.
