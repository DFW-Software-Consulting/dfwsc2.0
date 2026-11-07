# Coolify Deployment Guide for DFWSC Payment Portal

This guide explains how the DFW Software Consulting payment portal deploys to Coolify as separate resources from one monorepo. Every environment variable is documented in [ENVIRONMENT.md](./ENVIRONMENT.md); this guide does not repeat them.

Statements marked **Production setup** describe the live deployment as confirmed by the owner. They cannot be derived from the repository, so check them against Coolify before relying on them. Everything else is read from the files named next to it.

## Overview

The application deploys to Coolify as two independent resources, plus a database:
1. **Database** - PostgreSQL (Coolify-managed or an external instance). There is no `db` service in `docker-compose.prod.yml`.
2. **Backend** - a Coolify **Docker Compose** resource built from `docker-compose.prod.yml`, which runs four containers: `migrator`, `api`, `dfwsc-redis` and `backup` (see below).
3. **Frontend** - a **separate** Coolify application serving the nginx image built from `front/Dockerfile`, with `/api/` proxied to the API. It is not one of the services in `docker-compose.prod.yml` and deploys independently of the backend.

### Production setup

- The frontend is served at `dfwsc.com`; the API at `api.dfwsc.com`. No Netlify or other host is involved.
- Requests travel Cloudflare, then Coolify's Traefik proxy, then the container. The address the API sees as `request.ip` is therefore a Cloudflare edge address, not the visitor. The client address used for rate limiting comes from the `CF-Connecting-IP` header, honored only when the connection comes from a Cloudflare range (`backend/src/lib/client-ip.ts`; `TRUST_PROXY` and `CLOUDFLARE_IP_RANGES` in [ENVIRONMENT.md](./ENVIRONMENT.md) section 2).
- A merge to `main` deploys both applications automatically. The API is unavailable for a short time (about 30 seconds) while its containers are replaced.
- Coolify ignores network aliases declared in compose files. That is why the Redis service is named `dfwsc-redis` (see below).

## Service Configuration

### 1. Database Service
- **Type**: PostgreSQL 17 (Coolify's managed PostgreSQL or an external/custom instance; the dev stack, CI and the backup image all use major 17).
- **Not in the Compose file**: provision it separately and point the Backend's `DATABASE_URL` at it.
- **Port**: 5432 (internal only).
- **Credentials**:
  - `POSTGRES_USER=postgres`
  - `POSTGRES_PASSWORD=<generate a strong random value with `openssl rand -hex 32`, which is safe to place in `DATABASE_URL`; never use a default such as `postgres`. A password with a `/`, `@` or `:` in it (as `openssl rand -base64 32` often produces) must be percent-encoded in the URL, or the migration and the API fail to start>`
  - **Existing databases**: the Postgres image reads `POSTGRES_PASSWORD` only when it initialises an empty data directory, so changing the variable alone rotates nothing. To replace a default password, run `ALTER ROLE postgres PASSWORD '<new password>';` and update `DATABASE_URL` in the same change.
  - `POSTGRES_DB=stripe_portal`
- **Storage**: persistent volume for the data directory.
- **Healthcheck**: `pg_isready -U postgres -d stripe_portal`

### 2. Backend Service (API)
- **Source**: the repository root, deployed as a Coolify **Docker Compose** resource pointing at `docker-compose.prod.yml` (the `api` and `migrator` services build from `./backend`).
- **Containers**: the compose file defines four services:
  - `migrator` - builds the `builder` target of `backend/Dockerfile`, runs `npm run db:migrate` once against `DATABASE_URL`, then exits (`restart: "no"`). `api` will not start until it completes successfully.
  - `api` - the Fastify server (`node dist/index.js`, port 4242, published only on `127.0.0.1:4242` of the host). It also joins Coolify's external `coolify` network under the alias `dfwsc-api` (Coolify ignores `container_name`), which is how the frontend's nginx reaches it.
  - `dfwsc-redis` - `redis:7-alpine`, backing rate limiting and circuit-breaker state. It sits only on the stack's `backend` network, and the compose file fixes the API's `REDIS_URL` to `redis://dfwsc-redis:6379`. The plain name `redis` is not used because the `api` service also sits on Coolify's shared `coolify` network, where Coolify's own control-plane Redis (password-protected) answers to `redis` too. A network alias would not help, since Coolify ignores custom network aliases; the unique service name is what makes it resolve. A `REDIS_URL` set in Coolify is not read: it is not interpolated into the compose file, so it can be deleted. To use an external Redis instead, edit the `REDIS_URL` line in `docker-compose.prod.yml`.
  - `backup` - built from `./backup` (`backup/Dockerfile`: Alpine with `pg_dump`, `aws-cli` and `supercronic`). `backup/scripts/scheduler.sh` runs `backup.sh` on `BACKUP_SCHEDULE` (default `0 2 * * *`) under a file lock, writing gzipped dumps to the `postgres_backups` volume and uploading to S3 when `BACKUP_S3_BUCKET` is set. Variables, restore drills and the healthcheck: [BACKUP.md](./BACKUP.md).
- **Build**: `backend/Dockerfile`, multi-stage on `node:22-alpine`; the `production` target installs production dependencies only, runs as the `node` user and starts `node dist/index.js`.
- **Environment variables**: add them in Coolify on the Backend resource. The complete list, with required/default/purpose per variable, is in [ENVIRONMENT.md](./ENVIRONMENT.md). The minimum to start the API is:

  | Variable | Notes |
  |----------|-------|
  | `DATABASE_URL` | Connection URL of the database above. |
  | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Live keys in production. |
  | `JWT_SECRET` | At least 32 characters. |
  | `FRONTEND_ORIGIN` | The site origin, for example `https://dfwsc.com`; comma-separated list allowed. |
  | `API_BASE_URL` | Required in production, for example `https://api.dfwsc.com`. Without it onboarding links and `/app-config.js` answer 500. |
  | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Outgoing mail. Set `SMTP_FROM` explicitly. |
  | `CONTACT_INBOX` | Recipient of the website contact form (falls back to `SMTP_FROM`). |
  | `NEXTCLOUD_BASE_URL`, `NEXTCLOUD_USERNAME`, `NEXTCLOUD_APP_PASSWORD` | Required for admin login and for every Nextcloud feature flag. |

  Feature flags (`SALES_AUTOMATION_ENABLED`, `CLIENT_ONBOARDING_ENABLED`, `BILLING_REQUESTS_ENABLED`, `CONNECT_INVOICING`, `CEREBO_ENABLED` and the mirror and sync flags) all default to off. Their prerequisites, and a rollout warning for `STRIPE_ID_WRITEBACK_DRY_RUN`, are in [ENVIRONMENT.md](./ENVIRONMENT.md) section 4; the features themselves are in [BACKEND.md](./BACKEND.md) sections 9-16.
- **Admin login (Nextcloud)**: the admin panel signs users in against Nextcloud; there are no local admin accounts, and `ADMIN_USERNAME`, `ADMIN_PASSWORD` and `ALLOW_ADMIN_SETUP` are not read (remove them from Coolify). Before relying on it:
  1. **Create the Nextcloud groups first and put members in them.** The defaults are `dfwsc-admins` and `managers` (override with `ADMIN_NEXTCLOUD_GROUPS`, comma-separated, exact ids). A user whose Nextcloud account is in none of them gets 403 "This Nextcloud account isn't authorized for the admin panel".
  2. **`NEXTCLOUD_BASE_URL`, `NEXTCLOUD_USERNAME` and `NEXTCLOUD_APP_PASSWORD` must be set** (HTTPS only). The service account must be a Nextcloud admin: it reads each user's groups with `GET /ocs/v2.php/cloud/users/{id}/groups`. Without them login answers 503 "Admin login is unavailable".
  3. **Accounts with two-factor login must sign in with a Nextcloud app password** (Settings, Security, Devices & sessions), not the account password.
  - **No local fallback.** If Nextcloud is down, slow or its breaker is open, admin login answers 503 until it recovers. Payments, webhooks and API-key routes do not depend on Nextcloud and are unaffected. Admin JWTs already issued stay valid until they expire (`JWT_EXPIRY`, default 1h).
  - **Brute-force note.** Nextcloud throttles failed logins by source IP, and every check comes from the API server, so unthrottled guessing here would also slow the service account's own automation calls. `POST /auth/login` is therefore limited to 5 requests per 15 minutes per client IP, and to 10 failed attempts per 15 minutes per username (case-insensitive). Nextcloud's own throttle (HTTP 429) is reported as 503.
  - The `admins` table is still in the schema but is no longer read or written.
- **Startup Command**: `node dist/index.js`. Migrations run on each deploy through the `migrator` service; no manual step is needed. In production the API itself does not migrate; at boot it only verifies that the expected tables exist and exits if one is missing (`backend/src/lib/schema-check.ts`, [DATABASE.md](./DATABASE.md)).
- **Dependencies**: the database must be reachable through `DATABASE_URL` before deploying; inside the stack, `api` waits for `migrator` (completed) and `dfwsc-redis` (started).
- **Healthcheck**: defined in the compose file as `wget -qO- http://127.0.0.1:4242/api/v1/health` (every 10 s, 5 retries, 10 s start period). The image is Alpine and has `wget` but not `curl`, so use `wget` for any check you add. The endpoint returns 200 with `database: "connected"`, or 503 when the database is unreachable.

### 3. Frontend Service (React + Nginx)
- **Deployment**: a **separate** Coolify application, independent of the backend's Compose stack. It is not a service in `docker-compose.prod.yml` and is deployed and scaled on its own.
- **Source**: the `./front` directory, built with `front/Dockerfile`.
- **Build**: multi-stage. The builder runs `npm run build` (Vite client build plus a prerender step for the marketing pages), then `scripts/verify-build.mjs`, which fails the image build if a prerendered page nginx routes to is missing, then renders `nginx.conf` into the production config. The final stage is `nginx:alpine` running as the non-root `nginx` user with its pid file in `/tmp`. Read `front/Dockerfile` for the exact steps.
- **Port**: 80 (exposed as HTTP/HTTPS by Coolify).
- **Build arguments** (not runtime variables; see [ENVIRONMENT.md](./ENVIRONMENT.md) section 5):
  - `VITE_API_URL` (default `/api/v1`; keep the default so calls go through the nginx proxy).
  - `VITE_ANALYTICS_SRC` and `VITE_ANALYTICS_DOMAIN` (optional, set together). The image derives the analytics origin from the script URL and limits the CSP script and connection sources to it. Redeploy after changing either, because Vite bakes them into the static assets.
- **Dependencies**: the API must be reachable on the `coolify` network as `dfwsc-api:4242`.
- **Healthcheck**: configure an HTTP check on `/` in Coolify. It is not defined in the repository.

## Dockerfiles

The Dockerfiles are the source of truth; they are not copied here because the copies drifted.

| File | Image | Notes |
|------|-------|-------|
| `backend/Dockerfile` | `api` (target `production`) and `migrator` (target `builder`) | `node:22-alpine`; the builder compiles TypeScript to `build-dist`; production keeps `drizzle/` and `drizzle.config.ts` so `drizzle-kit migrate` can run. |
| `front/Dockerfile` | Frontend | Build args for `VITE_*`, `verify-build` step, CSP origin substitution with a check that no placeholder remains, non-root nginx. |
| `backup/Dockerfile` | `backup` | Alpine 3.21 with `postgresql17-client`, `aws-cli`, `supercronic`, `tini`; non-root `backup` user. |

## Nginx Configuration

`front/nginx.conf` is rendered at build time (`__ANALYTICS_ORIGIN__` replaced) and does the following:

- **Prerendered marketing pages**: `/`, `/pricing`, `/team` and `/privacy` are served from the files the build prerenders (`index.html`, `pricing.html`, `team.html`, `privacy.html`). A trailing slash on the last three redirects (301) to the clean path. Keep this list in sync with `PUBLIC_ROUTES` in `front/src/seo/meta.js`.
- **Client-rendered routes**: `/admin`, `/demos`, `/onboard`, `/payment-success`, `/payment-cancel`, `/onboarding-success`, `/regenerate-key` and `/request-key-regeneration` get the SPA shell `spa.html`, sent with `X-Robots-Tag: noindex, nofollow`.
- **Real 404s**: any other path that is not a real file returns the `404.html` page with status 404 and `noindex`, not the app. Static files such as `robots.txt`, `sitemap.xml` and `llms.txt` are served as files.
- **`/docs`**: `/docs` and `/docs.html` redirect (301) to a Nextcloud Collective page on `cloud.dfwsc.com`.
- **Caching**: `/assets/*` is `public, max-age=31536000, immutable` only when served successfully; a missing asset returns a plain-text 404 with `no-store` (so a stale tab after a deploy gets an error, not HTML), and every 404 is `no-store`. `*.html` and `theme-init.js` are `no-cache`.
- **API proxy**: `/api/` is proxied to `http://dfwsc-api:4242` (the compose alias on the `coolify` network), resolved at request time through Docker's resolver, with `X-Forwarded-For`, `X-Real-IP` and `X-Forwarded-Proto` set. Timeouts: connect 10 s, read 30 s, send 10 s; request bodies up to 10 MB.
- **Security headers**: `nosniff`, `X-Frame-Options: DENY`, referrer and permissions policies, HSTS (two years, include subdomains) and a Content-Security-Policy. The CSP `connect-src` hardcodes `https://api.dfwsc.com` besides `'self'`, so serving the site against another API host needs an `nginx.conf` change.
- **Compression**: gzip for text, JSON, XML and SVG.

## Deployment Sequence

### Phase 1: Infrastructure Setup
1. **Create Database Service**
   - Choose PostgreSQL 17.
   - Set `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`.
   - Enable persistent storage.
   - Save and wait for the service to become healthy.

2. **Create Backend Service** (Coolify "Docker Compose" resource type)
   - Set the source to your repository.
   - Point it at `docker-compose.prod.yml`. This single resource brings up `migrator`, `api`, `dfwsc-redis` and `backup` together.
   - Add the environment variables from the table above, plus any feature flags you want ([ENVIRONMENT.md](./ENVIRONMENT.md)).
   - Make sure the external `coolify` network exists on the host (Coolify creates it).
   - Healthchecks are already defined per service in the compose file.
   - Save and deploy.

3. **Create Frontend Service** (separate Coolify application, not part of `docker-compose.prod.yml`)
   - Set the source to your repository.
   - Set the build context to `./front` and use `front/Dockerfile`.
   - Add the build arguments (`VITE_API_URL=/api/v1` if you set it at all; the analytics pair only if you use analytics).
   - Leave it on Coolify's default `coolify` network; the backend's `api` service joins that network as `dfwsc-api`, so the nginx proxy can reach `dfwsc-api:4242`.
   - Save and deploy.

### Phase 2: Configuration & Testing
1. **Verify Database Connection**
   - Check the `migrator` logs for completed migrations and the `api` logs for a successful start. If a required table is missing, the API exits at boot.

2. **Test API Endpoints**
   - Health: `https://<api-domain>/api/v1/health` returns `{"status":"ok","database":"connected",...}`.
   - Swagger UI (`/docs` on the API) is off unless `ENABLE_SWAGGER` is exactly `true` on the API. `docker-compose.prod.yml` does not pass that variable, so it is off in this deployment. There is no production guard in the code: if you add it to the compose file, the UI is served in production.
   - `/api/v1/metrics` answers 404 unless `METRICS_TOKEN` is set. The compose file forwards it, so setting `METRICS_TOKEN` in Coolify (and redeploying) enables the route.

3. **Test Frontend**
   - Open the frontend domain and confirm the pages load.
   - Test the API proxy: the network tab should show `/api/*` requests answered by the backend.

4. **Register webhooks** (payments are not reconciled without the first one)

   | Endpoint (on the API host) | Secret variable | Behavior when the secret is unset |
   |----------------------------|-----------------|-----------------------------------|
   | `POST /api/v1/webhooks/stripe` | `STRIPE_WEBHOOK_SECRET` (required at boot) | API does not start. |
   | `POST /api/v1/webhooks/stripe-billing` | `STRIPE_BILLING_WEBHOOK_SECRET` | Endpoint answers 404. |
   | `POST /api/v1/webhooks/nextcloud/sales-lead` | `SALES_LEAD_WEBHOOK_SECRET` | 404; the poller still runs. |
   | `POST /api/v1/webhooks/nextcloud/client-onboarding` | `CLIENT_ONBOARDING_WEBHOOK_SECRET` | 404; the poller still runs. |
   | `POST /api/v1/webhooks/nextcloud/billing-request` | `BILLING_REQUESTS_WEBHOOK_SECRET` | 404; the poller still runs. |

   - `/webhooks/stripe` is the Stripe Connect endpoint. It handles `account.updated`, the `checkout.session.*` events, `payment_intent.succeeded|payment_failed|canceled`, `charge.refunded`, `charge.dispute.created`, `application_fee.refunded`, `payout.paid|failed`, the `invoice.*` events used by connected-account invoicing, `customer.subscription.updated|paused|resumed|deleted` and `subscription_schedule.canceled` (`backend/src/routes/webhooks.ts:298-466`). Which events to subscribe to and how to register the endpoint: [STRIPE.md](./STRIPE.md).
   - `/webhooks/stripe-billing` is an **account-level** (platform) endpoint, separate from the Connect one. It handles customer, subscription, subscription-schedule and `invoice.*` events for DFWSC's own billing customers and ignores any event that carries a connected `account` (`backend/src/routes/webhooks-billing.ts:20-42,82`).
   - The three Nextcloud endpoints are called by Nextcloud's webhook listener on a form submission, with `Authorization: Bearer <secret>`. Secrets must be at least 32 characters (`openssl rand -hex 32`). They only trigger an immediate poll cycle; see [BACKEND.md](./BACKEND.md) sections 9, 10 and 14.

5. **End-to-End Testing**
   - Sign in to the admin panel with a Nextcloud account that is in one of the `ADMIN_NEXTCLOUD_GROUPS` (there is no setup step or local admin account).
   - Test the client onboarding flow.
   - Test payment processing (with Stripe test keys).
   - Verify email delivery.
   - Test webhook handling (Stripe CLI or a test-mode endpoint).

## Coolify-Specific Recommendations

### Service Dependencies
- Deploy order: Database, then Backend, then Frontend. The frontend only needs the backend reachable at request time.
- Within the Backend resource, `docker-compose.prod.yml`'s own `depends_on` already orders `migrator` (must complete) and `dfwsc-redis` (must start) before `api`; no extra Coolify configuration is needed.

### Environment Management
- Use Coolify's secrets for `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_BILLING_WEBHOOK_SECRET`, `JWT_SECRET`, `DATABASE_URL`, `SMTP_PASS`, `NEXTCLOUD_APP_PASSWORD`, the `*_WEBHOOK_SECRET` values and `AWS_SECRET_ACCESS_KEY`.
- **Only variables listed in `docker-compose.prod.yml` reach the containers.** Setting any other variable in Coolify does nothing. The ones the code reads but the compose file does not forward are `HOST` and `ENABLE_SWAGGER`; making one effective requires adding it to the compose file. `METRICS_TOKEN`, `TRUST_PROXY`, `CLOUDFLARE_IP_RANGES`, `DEFAULT_PAYMENT_SUCCESS_URL`, `DEFAULT_PAYMENT_CANCEL_URL` and `DB_POOL_MAX` are forwarded, so a value defined in Coolify takes effect on the next deploy. See [ENVIRONMENT.md](./ENVIRONMENT.md) section 8.
- A variable that is forwarded but unset in Coolify arrives as an empty string, which the code treats as unset (except `SMTP_FROM`; set it).

### Monitoring & Logging
- `GET /api/v1/metrics` exposes sync and circuit-breaker state, and needs `METRICS_TOKEN` set in Coolify (see above).
- The API logs structured JSON to stdout, which Coolify's log view shows. The Loki and Promtail services exist only in the dev stack.
- Set up resource monitoring (CPU, memory, disk) and alerting for service failures in Coolify. The `backup` container's own healthcheck fails when the last successful backup is older than `BACKUP_HEARTBEAT_MAX_AGE`.

### Backup Strategy
- The Backend resource includes the `backup` service described above: nightly gzipped `pg_dump` into the `postgres_backups` volume, optionally uploaded to S3 (`BACKUP_S3_BUCKET` and the `AWS_*` credentials; `BACKUP_REQUIRE_REMOTE` makes a missing bucket a failure). Without a bucket, backups exist only on that Docker volume on the same host.
- If using Coolify's managed PostgreSQL, also enable its automatic backups for redundancy.
- Run a restore drill periodically ([BACKUP.md](./BACKUP.md)); an untested backup is not a backup.

### SSL/TLS
- Coolify's proxy terminates TLS; no certificate handling is needed in the services.
- Cloudflare sits in front of Coolify (**Production setup**); nginx sends HSTS itself.

## Troubleshooting

### Common Issues
1. **Database Connection Failures**
   - The database is not part of the compose stack. Verify `DATABASE_URL` points at a host reachable from the containers (an external host or a Coolify database's internal address), not at a compose service name.
   - Check that the database is healthy before deploying the backend.
   - Confirm username, password and database name match; percent-encode special characters in the password.
   - If `migrator` fails, `api` never starts; read the `migrator` logs first.

2. **API Proxy Not Working** (`/api/*` returns 502 or 504 on the frontend domain)
   - The frontend's nginx proxies to `dfwsc-api:4242`. That name exists only while the `api` container is running and attached to the `coolify` network with the alias `dfwsc-api` (`docker-compose.prod.yml`, `api.networks.coolify.aliases`). From the frontend container, `getent hosts dfwsc-api` must return an address.
   - Confirm both applications are on the same `coolify` network, and that `api` is healthy.
   - During a backend deploy the alias disappears briefly, so a short burst of 502 is expected (**Production setup**).

3. **Build Failures**
   - Frontend: `scripts/verify-build.mjs` fails the image build when a prerendered page is missing; read its output. A `__ANALYTICS_ORIGIN__` placeholder left in the rendered nginx config also fails the build.
   - Backend: dependencies come from `npm ci`, so `package.json` and `package-lock.json` must agree.
   - Check the build output for the specific error.

4. **Environment Variable Issues**
   - Variable names must match exactly, with no extra spaces or quotes.
   - If a variable has no effect, check whether `docker-compose.prod.yml` forwards it (see Environment Management).
   - A flag set to anything but `true` stays off. A flag that is on but misconfigured is logged once at startup and its job stays off; look for the problem list in the `api` logs.

5. **`Rate limiter Redis error` / `NOAUTH Authentication required` in the API log**
   - The API is talking to a Redis other than the stack's own, usually Coolify's control-plane Redis reached through the short name `redis` on the shared `coolify` network. Limits still work through the in-memory fallback, but are no longer shared or persistent.
   - Confirm `docker-compose.prod.yml` points `REDIS_URL` at `redis://dfwsc-redis:6379`, and that `docker exec <api container> getent hosts dfwsc-redis` returns an address on the stack's `backend` network.
   - Any hostname the `api` service uses must be unique across everything on the `coolify` network; give shared-network services a unique service name rather than a generic one.

6. **Every visitor shares one rate-limit bucket, or limits trigger too early**
   - The API must see the real client address. Behind Cloudflare that comes from `CF-Connecting-IP`, honored only for connections from the built-in Cloudflare ranges. If Cloudflare publishes ranges that are missing from `backend/src/lib/client-ip.ts`, set `CLOUDFLARE_IP_RANGES` (the compose file forwards it).

## Maintenance

### Updates
1. Push changes to your repository.
2. **Production setup**: a merge to `main` deploys both applications automatically (the API with a brief interruption). The repository holds no Coolify deployment configuration, so the trigger, watched paths and branch are set in Coolify.
3. Within the backend resource, `migrator` runs first and `api` starts after it succeeds.

### Scaling
- The frontend is static and scales independently of the backend.
- More than one `api` replica shares rate-limit counters only through Redis (`dfwsc-redis` in the stack); without it every replica keeps its own counters.
- Database scaling is handled by the PostgreSQL provider.

### Environment Promotion
- Keep the same variable names in every environment and change only the values. The repository defines one production compose file; any staging environment is configured separately in Coolify.

## Files Reference

Key files for Coolify deployment:
- `backend/Dockerfile` - API and migrator image
- `docker-compose.prod.yml` - Compose source for the Backend resource (`migrator`, `api`, `dfwsc-redis`, `backup`)
- `front/Dockerfile` - Frontend image
- `front/nginx.conf` - Static serving, redirects, caching, security headers and API proxy
- `backup/` - Backup image (`Dockerfile`, `scripts/scheduler.sh`, `backup.sh`, `restore.sh`, `healthcheck.sh`); see [BACKUP.md](./BACKUP.md)
- `.env.example` (repository root) - Template of environment variable names for local development; there is no `backend/.env`. Production values live in Coolify.
- [ENVIRONMENT.md](./ENVIRONMENT.md) - Reference for every variable and feature flag
- `docker-compose.base.yml` / `docker-compose.dev.yml` - Local dev stack ([DEVELOPMENT.md](./DEVELOPMENT.md))
- `scripts/backup-db.sh` - Older standalone backup script. The `backup` service does not run it; the comment at the top of the file still says it does, which is out of date.
