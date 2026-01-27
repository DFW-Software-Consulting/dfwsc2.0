# 2026-01-27 Admin/Onboard Route Split

## Summary
Split the shared `/onboard` page into two routes:
- `/admin` for admin login + dashboard
- `/onboard` for client-only onboarding token flow

## Goals
- Keep admin functionality on a dedicated admin route.
- Keep client onboarding clean and focused on token input + Stripe onboarding link.
- Preserve existing API contracts and auth flow.

## Proposed Changes
### Frontend
- Create a new `/admin` route that renders:
  - Admin login form
  - Admin dashboard after login (same components as today)
- Update `/onboard` to render only the client token onboarding flow.
- Ensure JWT token is stored in `sessionStorage` as `adminToken` (no change).
- Optional: add nav links between `/admin` and `/onboard`.

### Backend
- No API changes expected.
- Confirm `/api/v1/auth/login`, `/api/v1/clients`, `/api/v1/accounts`, and `/api/v1/clients/:id` remain admin-only.

## Acceptance Criteria
- Visiting `/admin` shows admin login when logged out; shows admin dashboard when logged in.
- Visiting `/onboard` shows only the client token onboarding UI.
- Admin login still works and stores JWT in `sessionStorage`.
- Client onboarding still works with token links like `/onboard?token=...`.

## Notes / Risks
- Ensure routes are updated anywhere onboarding links are generated.
- Keep CORS and `FRONTEND_ORIGIN` aligned for the new routes.
