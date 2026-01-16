# Code Review Follow-up: Migrations in Docker Compose

**Created:** 2026-01-14
**Priority:** Medium

## Summary

Ensure dev environments run migrations on startup or avoid setting `NODE_ENV=production` in dev compose to prevent schema drift.

## Tasks

- [ ] Decide which compose file is for local dev vs prod and set `NODE_ENV` accordingly.
- [ ] Optionally add an explicit migration step to the `api` service startup.
- [ ] Document the expected workflow for migrations.

## References
- `docker-compose.yml:8`
- `backend/src/server.ts:15`
