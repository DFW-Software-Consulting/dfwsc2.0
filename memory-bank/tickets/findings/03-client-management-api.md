# Ticket 03: Client Management API

## Goal
Add admin-only endpoints to list clients and manage tokens.

## Scope
- List clients.
- Use existing token creation endpoint.

## Requirements
- `GET /api/v1/clients` (admin only)
  - Returns list: `id`, `name`, `email`, `stripeAccountId`, `status`, `createdAt`.
- Ensure `POST /api/v1/accounts` requires admin JWT.
- Optional: block token creation for inactive clients.

## Acceptance Criteria
- Admin can list clients.
- Unauthorized requests are rejected.

## Notes
- Sorting + filtering can be added later if needed.
