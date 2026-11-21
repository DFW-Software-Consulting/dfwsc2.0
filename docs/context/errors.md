# Error log
Entries go newest first.

## Docker stack is not running (pre-push hook)
- Cause: the pre-push hook runs coverage inside the dev `api` container of the current directory; Compose names a project after its directory, so a stack started in another checkout or worktree is not found.
- Fix: run `make up` from the worktree being pushed, or push with `SKIP_DOCKER_TESTS=1` after running the tests another way.
- Date: 2026-11-07

## Auth rate-limit tests fail locally
- Cause: a gitignored `backend/.env` is loaded during tests and leaks variables (for example `REDIS_URL`, `TRUST_PROXY`) that `vitest.config.ts` does not pin.
- Fix: delete or rename `backend/.env`; use the root `.env` for local development.
- Date: 2026-11-07

## Production API ignores METRICS_TOKEN / TRUST_PROXY / DB_POOL_MAX settings
- Cause: the production compose file did not forward these runtime variables to the `api` container.
- Fix: forward them in `docker-compose.prod.yml` (commit fb90c94); do the same for any new runtime variable.
- Date: 2026-11-07
