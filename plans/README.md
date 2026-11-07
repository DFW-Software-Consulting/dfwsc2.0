# Plans

Design plans written for earlier work. They are historical records, not current documentation. Current documentation is in [docs/](../docs/). Status below is as of 2026-11-07.

| Plan | Status | Notes |
|------|--------|-------|
| [cerebo.md](./cerebo.md) | Active | Phase 1 shipped behind `CEREBO_ENABLED` (default off). Phases 2 to 4 not started. Whether Cerebo stays is an owner decision. |

Finished and superseded plans were removed on 2026-11-07 and remain in git history.

## Open follow-ups (from removed plans)

- Admin JWT in an httpOnly cookie (from `frontend-architecture.md`, Step 7): still open. `POST /auth/login` returns the token in the JSON body and the client keeps it in React state (`front/src/contexts/AuthContext.jsx`). It is no longer in `sessionStorage`, and admin login now goes through Nextcloud (`docs/BACKEND.md`).
- CHECK constraints on `processing_fee_percent` and `processing_fee_cents` of `clients` and `client_groups` (from `database-schema-indexes.md`, Step 5): still open. `backend/src/db/schema.ts` (lines 30-31, 83-84) has no CHECK on them, and no migration in `backend/drizzle/` adds one. The planned rules were percent in (0, 100], cents >= 0, and not both set.
- `buildOnboardingEmail` in `mailer.ts` (from `api-consistency.md`, Step 4c): still open, low value. `backend/src/lib/mailer.ts` has no such helper; the onboarding emails are still built inline in `backend/src/routes/connect.ts` (around lines 438 and 614).

