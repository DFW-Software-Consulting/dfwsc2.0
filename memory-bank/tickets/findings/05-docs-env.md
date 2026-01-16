# Ticket 05: Docs + Env Updates

## Goal
Update docs and templates to reflect admin auth + new endpoints.

## Scope
- Env templates.
- API documentation.

## Requirements
- Update `backend/env.example` and docs to include:
  - `ADMIN_USERNAME`
  - `ADMIN_PASSWORD`
  - `JWT_SECRET`
- Update API docs with:
  - `POST /api/v1/auth/login`
  - `GET /api/v1/clients`
  - `PATCH /api/v1/clients/:id`
- Document admin dashboard flow in frontend docs if applicable.

## Acceptance Criteria
- Docs and env templates match implementation.

