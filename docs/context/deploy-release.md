# Deploy and release

Authoritative detail: the deployment guide in `docs/` (it has production specifics; keep those out of public PRs and out of this folder), [docs/BACKUP.md](../BACKUP.md), [docs/ENVIRONMENT.md](../ENVIRONMENT.md).

## Shape
- Deployed by the hosting platform from `main`; a merge to `main` deploys. The API is briefly unavailable while containers are replaced.
- Two independently deployed pieces: the backend stack from `docker-compose.prod.yml`, and the frontend as an nginx image built from `front/Dockerfile` that proxies `/api/` to the API.
- Prod compose services: `migrator` (runs migrations once, API waits for it), `api`, a Redis instance, and a `backup` image (`backup/`) that dumps the database on a cron schedule, optionally uploading to object storage.
- The database is provisioned outside the compose file (PostgreSQL 17); point `DATABASE_URL` at it.
- Backend image: multi-stage `backend/Dockerfile` on Node 24, production target runs as a non-root user with `node dist/index.js`.

## Release checklist for changes
1. Schema change: include the generated migration; it runs through the `migrator` on deploy (see [db-migrations.md](db-migrations.md)).
2. New env var: add it to `.env.example` (pre-commit warns otherwise), to `docs/ENVIRONMENT.md`, and forward it to the `api` service in `docker-compose.prod.yml`. Missing forwarding was a real bug (see [errors.md](errors.md)).
3. Production requires `API_BASE_URL`; unset gives 500 on `/app-config.js` and Connect callback links.
4. Feature-flagged integrations: deploy with the flag off, configure, then turn on and redeploy.
5. Frontend deploys can leave stale chunks in open tabs; the app has recovery for this (`front/src/utils/preloadRecovery.js`) and nginx must not cache asset 404s.

## Behind a proxy
Client IP for rate limiting comes from a trusted-proxy header only when the connection is from configured proxy ranges (`TRUST_PROXY`, related vars in ENVIRONMENT.md; tests in `backend/src/__tests__/trust-proxy.test.ts`, `client-ip.test.ts`).
