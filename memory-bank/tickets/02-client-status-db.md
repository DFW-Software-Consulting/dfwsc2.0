# Ticket 02: Client Status (Soft Delete)

## Goal
Add soft-delete support for clients.

## Scope
- DB schema update to include status field.
- API endpoint to mark client inactive.

## Requirements
- Add `status` to `clients` table (`active` | `inactive`).
- Default to `active` for new clients.
- Migration + schema update.
- Admin-only `PATCH /api/v1/clients/:id` to set status.

## Acceptance Criteria
- New clients default to `active`.
- Inactive clients are persisted as such.
- Endpoint rejects non-admin requests.

## Notes
- Decide whether inactive clients are hidden or shown with status on list API.
