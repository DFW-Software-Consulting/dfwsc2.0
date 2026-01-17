---
title: "Compose Migrations – Plan"
phase: Plan
date: "2026-01-16T21:00:00Z"
owner: "claude-agent"
parent_research: "memory-bank/tickets/2026-01-14_review-findings/07-compose-migrations.md"
git_commit_at_plan: "382b369"
tags: [plan, compose-migrations, docker, drizzle]
---

## Goal

**Singular Focus**: Ensure local development environments run database migrations automatically on startup by correcting `NODE_ENV` in the default `docker-compose.yml`.

**Non-goals**:
- Changing production deployment workflows
- Modifying the migration logic in server.ts
- Adding new migration services to dev compose

## Scope & Assumptions

**In Scope**:
- Change `NODE_ENV` from `production` to `development` in `docker-compose.yml`
- Update inline documentation/comments if present

**Out of Scope**:
- `docker-compose.prod.yml` (already correct)
- `docker-compose.dev.yml` (already correct)
- `backend/docker-compose.prod.yml` (has migrator service, production workflow)
- Adding new migration scripts or services

**Assumptions**:
- `docker-compose.yml` is the primary file developers use for local development
- The existing migration logic in `backend/src/index.ts:17-18` is correct and tested
- Schema verification (`verifyDatabaseSchema()`) will catch drift if migrations don't run

## Deliverables (DoD)

1. **`docker-compose.yml`** updated with `NODE_ENV: development`
2. **One integration test** verifying migrations run in development mode (optional - existing schema-check provides coverage)

## Readiness (DoR)

- [x] Research document reviewed
- [x] Docker compose files analyzed
- [x] Migration code paths understood
- [x] Git state captured (382b369)

## Milestones

| ID | Milestone | Description |
|----|-----------|-------------|
| M1 | Configuration Fix | Update docker-compose.yml NODE_ENV |
| M2 | Validation | Verify migrations run on container startup |

## Work Breakdown (Tasks)

| Task ID | Summary | Owner | Dependencies | Milestone |
|---------|---------|-------|--------------|-----------|
| T1 | Change `NODE_ENV: production` to `NODE_ENV: development` in `docker-compose.yml:9` | agent | none | M1 |
| T2 | Rebuild and verify migrations run on startup via container logs | agent | T1 | M2 |

### Task Details

#### T1: Update docker-compose.yml NODE_ENV

**Acceptance Criteria**:
- `docker-compose.yml` line 9 reads `NODE_ENV: development`
- No other changes to the file

**Files/Interfaces**:
- `docker-compose.yml:9`

#### T2: Validation via container logs

**Acceptance Criteria**:
- `docker-compose up -d --build api` succeeds
- Container logs show: "Database migrations executed (noop if already up to date)"
- Container logs show schema verification passing

**Files/Interfaces**:
- Docker container logs (no file changes)

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Trigger |
|------|--------|------------|------------|---------|
| Developers may have relied on production-like behavior | Low | Low | This is the documented expected behavior per CLAUDE.md | User reports issues |
| Existing data in pgdata volume | None | N/A | Migrations are idempotent (noop if up to date) | N/A |

## Test Strategy

**No new test file required.**

Validation approach:
- Rebuild containers with `docker-compose up -d --build`
- Check logs for migration execution message
- Existing `verifyDatabaseSchema()` provides runtime validation

## References

- Research: `memory-bank/tickets/2026-01-14_review-findings/07-compose-migrations.md`
- Migration logic: `backend/src/index.ts:17-18`
- Migration runner: `backend/src/lib/migrate.ts:10`
- Schema check: `backend/src/lib/schema-check.ts:35-58`
- Target file: `docker-compose.yml:9`

## Alternative Option

**Add explicit migration step to api service startup** (NOT recommended):

This would involve changing `docker-compose.yml` command to:
```yaml
command: sh -c "npm run db:migrate && npm run start"
```

**Why not chosen**:
- Requires `drizzle-kit` in production image (bloat)
- Existing code already handles this via NODE_ENV check
- Simpler to fix the root cause (wrong NODE_ENV)

---

## Final Gate

| Item | Value |
|------|-------|
| Plan Path | `memory-bank/plan/2026-01-16_21-00-00_compose-migrations.md` |
| Milestones | 2 |
| Tasks | 2 |
| Tests | 0 (validation via logs) |
| Next Command | `/ce-ex "memory-bank/plan/2026-01-16_21-00-00_compose-migrations.md"` |
