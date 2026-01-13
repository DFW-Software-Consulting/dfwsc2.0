# Ticket 04: `/onboard` UI Update

## Goal
Make `/onboard` a shared page for employee login + client token entry, with an admin dashboard after login.

## Scope
- Frontend UI/UX on `/onboard`.
- Admin dashboard view toggled after login.

## Requirements
- `/onboard` layout with two sections:
  - **Employee login** (username + password).
  - **Client onboarding** (token entry, existing behavior).
- After login, replace login card with dashboard:
  - Client list (name, email, status, stripeAccountId).
  - Create new client + generate token (calls `POST /api/v1/accounts`).
  - Deactivate client (calls `PATCH /api/v1/clients/:id`).
- JWT stored in `sessionStorage`.

## Acceptance Criteria
- Client token flow unchanged for customers.
- Employee login leads to dashboard without route change.
- Dashboard actions call backend APIs with `Authorization: Bearer <jwt>`.

## Notes
- Include copy-to-clipboard for token and onboarding link.
