# Ticket 01: Admin Auth (Shared Credentials)

## Goal
Add a simple admin login using `.env` credentials and JWT.

## Scope
- Backend login route.
- JWT verification middleware.
- Update admin-only routes to require JWT instead of `x-api-role`.

## Requirements
- Add `.env` vars:
  - `ADMIN_USERNAME`
  - `ADMIN_PASSWORD`
  - `JWT_SECRET`
- `POST /api/v1/auth/login`
  - Validate credentials.
  - Return JWT with `{ role: 'admin' }` and short expiry.
- Add `requireAdminJwt` middleware.
- Apply middleware to admin routes (e.g., `POST /v1/accounts`, `POST /v1/onboard-client/initiate`, reports, etc.).

## Acceptance Criteria
- Invalid credentials return 401.
- Valid login returns JWT.
- Admin routes reject requests without valid JWT.
- Existing client token flow (`GET /v1/onboard-client`) remains public.

## Notes
- Consider rate limiting login endpoint.
