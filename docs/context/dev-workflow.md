# Dev workflow, hooks and CI

Authoritative detail: [docs/DEVELOPMENT.md](../DEVELOPMENT.md) and [CLAUDE.md](../../CLAUDE.md). Env var names: [docs/ENVIRONMENT.md](../ENVIRONMENT.md) and `.env.example`.

## Commands
- `make up-build` then `make up`: dev stack (api, web, db, redis, mailhog, stripe-cli, loki, alloy) from `docker-compose.base.yml` plus `docker-compose.dev.yml`. The dev file is an override and does not work alone. See `Makefile` for all targets.
- `make test-back` runs backend tests in the running `api` container; `make test-front` runs frontend tests on the host; `make coverage` enforces thresholds from `backend/vitest.config.ts`.
- Single backend test: `docker compose -f docker-compose.base.yml -f docker-compose.dev.yml exec api npx vitest run <file>`.
- `npm run lint` (Biome) at root; CI also runs `npx eslint src` in `front/`, which the pre-push hook does not, so run `cd front && npm run lint` for frontend changes.
- `npm run db:generate` / `db:migrate` call the backend drizzle scripts; `drizzle-kit` needs `DATABASE_URL` exported in the shell.

## Hooks (Husky, `.husky/`)
Active only after `npm install` at the root of the checkout. A fresh worktree has no hooks until then, so CI is the first gate.
- pre-commit: no commits on `main`, no `.env` staged, no conflict markers, no staged file over 500 KB, `package.json` changes need the lockfile, secretlint, a schema change needs a migration, no `console.log`/`debugger`, no `.only`/`.skip`, Biome auto-fix on staged files, mirror check, backend type-check when backend TypeScript is staged.
- commit-msg: commitlint, Conventional Commits, header at most 100 chars.
- pre-push: refuses a force-push to `main`, runs coverage in the running dev `api` container of the same directory, lint, type-check, frontend build and tests, prod compose build.
- Skips exist (`SKIP_MIGRATION_CHECK`, `ALLOW_CONSOLE`, `SKIP_TYPECHECK`, `SKIP_DOCKER_TESTS`, `SKIP_DOCKER_BUILD`); use only when the reason is real.

## Agent instruction mirrors
`CLAUDE.md`, `.claude/CLAUDE.md`, `AGENTS.md`, `Qwen.md`, `Gemini.md` must be byte-identical (pre-commit, pre-push and CI `docs-sync` all check). Edit `CLAUDE.md`, then copy it to the others (command in `CLAUDE.md`, helper `.claude/sync-docs.sh`).

## CI (`.github/workflows/ci.yml`)
Jobs: lint, typecheck, test (Postgres 17, migrate, coverage), build, prod-compose-build, secrets, commitlint, source-guards, docs-sync, fallow (dead-code, baselines in `fallow-baselines/`). Dependency audits are non-blocking. An advisory review workflow also runs on PRs and never fails them.

## Gotchas
- A gitignored `backend/.env` is read during tests (`backend/src/lib/env.ts`) and leaks variables that `vitest.config.ts` does not pin; delete it if auth rate-limit tests fail. Use the root `.env` for dev.
- Run `npm ci` at root, `backend/` and `front/` in a new worktree before committing.
- Large localhost cookies can give HTTP 431 from dev servers.
- Backend tests run serially and need a real Postgres via `DATABASE_URL`.
