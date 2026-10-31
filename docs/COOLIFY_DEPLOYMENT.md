# Coolify Deployment Guide for DFWSC Payment Portal

This guide explains how to deploy the DFW Software Consulting payment portal to Coolify as separate services while maintaining the monorepo structure.

## Overview

The application deploys to Coolify as two independent resources, plus a database:
1. **Database** - PostgreSQL (Coolify-managed or an external instance — there is no `db` service in `docker-compose.prod.yml`)
2. **Backend** - a Coolify **Docker Compose** resource built from `docker-compose.prod.yml`, which runs four containers: `migrator`, `api`, `dfwsc-redis`, and `backup` (see below)
3. **Frontend** - a **separate** Coolify **Nginx** application serving the built React app with API proxying — it is not one of the services in `docker-compose.prod.yml` and deploys/scales independently of the backend

All resources can be deployed independently on Coolify while sharing the same monorepo.

## Service Configuration

### 1. Database Service
- **Type**: PostgreSQL (Use Coolify's managed PostgreSQL or an external/custom instance)
- **Not in the Compose file**: `docker-compose.prod.yml` has no `db` service — provision this separately and point the Backend's `DATABASE_URL` at it
- **Port**: 5432 (internal only)
- **Environment Variables**:
  - POSTGRES_USER=postgres
  - POSTGRES_PASSWORD=<generate a strong random value with `openssl rand -hex 32`, which is safe to place in `DATABASE_URL`; never use a default such as `postgres`. A password with a `/`, `@` or `:` in it (as `openssl rand -base64 32` often produces) must be percent-encoded in the URL, or the migration and the API fail to start>
  - **Existing databases**: the Postgres image reads `POSTGRES_PASSWORD` only when it initialises an empty data directory, so changing the variable alone rotates nothing. To replace a default password, run `ALTER ROLE postgres PASSWORD '<new password>';` and update `DATABASE_URL` in the same change.
  - POSTGRES_DB=stripe_portal
- **Storage**: Enable persistent volume for data directory
- **Healthcheck**: `pg_isready -U postgres -d stripe_portal`

### 2. Backend Service (API)
- **Source**: `./backend` directory, deployed as a Coolify **Docker Compose** resource pointing at `docker-compose.prod.yml`
- **Containers**: that compose file defines four services:
  - `migrator` - runs `npm run db:migrate` once against `DATABASE_URL`, then exits; `api` will not start until this completes successfully
  - `api` (reachable as `dfwsc-api` via a network alias on Coolify's `coolify` network; Coolify ignores `container_name`) - the Fastify server, `node dist/index.js`, port 4242
  - `dfwsc-redis` - backs rate limiting and circuit-breaker state; the service itself is named `dfwsc-redis` and sits only on the stack's `backend` network, and `docker-compose.prod.yml` sets the API's `REDIS_URL` to `redis://dfwsc-redis:6379`. The plain name `redis` is not used because the `api` service also sits on Coolify's shared `coolify` network, where Coolify's own control-plane Redis (password-protected) answers to `redis` too. A network alias would not help, since Coolify ignores custom network aliases; the unique service name is what makes it resolve. The Coolify `REDIS_URL` variable is **not read** by the API in production; it is not interpolated into the compose file, so it can be deleted, and leaving a stale value there does nothing. To use an external Redis instead, edit the `REDIS_URL` line in `docker-compose.prod.yml`.
  - `backup` - runs `scripts/backup-db.sh` on a nightly cron schedule (`0 2 * * *`) into the `postgres_backups` volume, optionally pushing to S3 if `AWS_S3_BACKUP_BUCKET` is set
- **Build**: Use existing Dockerfile (multi-stage production build)
- **Port**: 4242 (expose for internal communication)
- **Environment Variables**:
  ```
  STRIPE_SECRET_KEY=your_stripe_secret_key
  STRIPE_WEBHOOK_SECRET=your_stripe_webhook_secret
  DATABASE_URL=<postgres-connection-url>
  FRONTEND_ORIGIN=https://your-frontend-domain.com
  JWT_SECRET=your_jwt_secret_minimum_32_chars
  DEFAULT_PROCESS_FEE_CENTS=100
  SMTP_HOST=your_smtp_host
  SMTP_PORT=your_smtp_port
  SMTP_USER=your_smtp_user
  SMTP_PASS=your_smtp_password
  SMTP_FROM=noreply@yourdomain.com
  API_BASE_URL=https://your-backend-domain.com
  # Admin panel login: Nextcloud groups allowed to sign in (comma-separated; default shown)
  ADMIN_NEXTCLOUD_GROUPS=dfwsc-admins,managers
  # Optional: Nextcloud New Lead automation (docs/BACKEND.md §9); off unless enabled
  NEXTCLOUD_BASE_URL=https://cloud.example.com
  NEXTCLOUD_USERNAME=dfwsc-admin
  NEXTCLOUD_APP_PASSWORD=your_nextcloud_app_password
  SALES_AUTOMATION_ENABLED=false
  SALES_LEAD_FORM_ID=12
  SALES_PIPELINE_TABLE_ID=8
  SALES_ADDRESSBOOK_PATH=dfwsc-sales_shared_by_messyginger0804
  SALES_LEADS_FOLDER=DFWSC Sales/Leads
  SALES_POLL_INTERVAL_MS=120000
  # Optional: client onboarding (docs/BACKEND.md §10); off unless enabled
  CLIENT_ONBOARDING_ENABLED=false
  CLIENT_ONBOARDING_FORM_ID=2
  CLIENT_ONBOARDING_PROJECTS_TABLE_ID=6
  CLIENT_ONBOARDING_PIPELINE_TABLE_ID=8
  CLIENT_ONBOARDING_ADDRESSBOOK_PATH=dfwsc-sales_shared_by_messyginger0804
  CLIENT_ONBOARDING_CLIENTS_FOLDER=clients
  CLIENT_ONBOARDING_COLLECTIVE_ID=1
  CLIENT_ONBOARDING_WEBHOOK_SECRET=at_least_32_random_characters
  CLIENT_ONBOARDING_POLL_INTERVAL_MS=300000
  # Optional: per-project Nextcloud Teams, wikis and folder shares (docs/BACKEND.md section 10); off by default
  CLIENT_ONBOARDING_PROJECT_TEAMS=false
  CLIENT_ONBOARDING_TEAM_ADMINS=user-id-one,user-id-two
  # Optional: create/link a Stripe Customer on the platform account per client (docs/BACKEND.md section 10); off by default
  CLIENT_ONBOARDING_BILLING_CUSTOMER=false
  # Optional: push edits of a client's Nextcloud contact card to its billing Stripe Customer (docs/BACKEND.md section 11); off by default
  CONTACT_STRIPE_SYNC=false
  CONTACT_STRIPE_SYNC_INTERVAL_MS=120000
  # Optional: read-only "Portal Accounts" Nextcloud Table with portal client status (docs/BACKEND.md section 12); off by default
  PORTAL_MIRROR=false
  ```
- **Admin login (Nextcloud)**: the admin panel signs users in against Nextcloud; there are no local admin accounts, and `ADMIN_USERNAME`, `ADMIN_PASSWORD` and `ALLOW_ADMIN_SETUP` are no longer read (remove them from Coolify). Before deploying this change:
  1. **Create the Nextcloud groups first and put members in them.** The defaults are `dfwsc-admins` and `managers` (override with `ADMIN_NEXTCLOUD_GROUPS`, comma-separated, exact ids). A user whose Nextcloud account is in none of them gets 403 "This Nextcloud account isn't authorized for the admin panel".
  2. **`NEXTCLOUD_BASE_URL`, `NEXTCLOUD_USERNAME` and `NEXTCLOUD_APP_PASSWORD` must be set** (HTTPS only). The service account must be a Nextcloud admin: it reads each user's groups with `GET /ocs/v2.php/cloud/users/{id}/groups`. Without them login answers 503 "Admin login is unavailable".
  3. **Accounts with two-factor login must sign in with a Nextcloud app password** (Settings → Security → Devices & sessions), not the account password.
  - **No local fallback.** If Nextcloud is down, slow or its breaker is open, admin login answers 503 until it recovers. Payments, webhooks and API-key routes do not depend on Nextcloud and are unaffected. Admin JWTs already issued stay valid until they expire (`JWT_EXPIRY`, default 1h); tokens issued before this change (whose `sub` was an `admins` row id) also keep working until then.
  - **Brute-force note.** Nextcloud throttles failed logins by source IP, and every check comes from the API server, so unthrottled guessing here would also slow the service account's own automation calls (forms, contacts, files). `POST /auth/login` is therefore limited to 5 requests per 15 minutes per client IP and 10 per 15 minutes per username (case-insensitive). Nextcloud's own throttle (HTTP 429) is reported as 503.
  - The `admins` table is left in the database for now and is no longer read or written; a later change drops it.
- **Startup Command**: `node dist/index.js` (handled by Dockerfile). DB migrations run automatically on each deploy via the `migrator` service above — no separate manual migration step is needed.
- **Dependencies**: Database must be reachable via `DATABASE_URL` before deploying; within the compose stack, `api` also depends on `migrator` (completed) and `dfwsc-redis` (started) automatically
- **Healthcheck**: `curl -f http://localhost:4242/api/v1/health || exit 1` (the compose file itself uses an equivalent `wget` healthcheck)

### 3. Frontend Service (React + Nginx)
- **Deployment**: a **separate** Coolify Nginx application, independent of the backend's Compose stack — it is not a service in `docker-compose.prod.yml` and is deployed/scaled on its own
- **Source**: `./front` directory
- **Build**: Multi-stage `front/Dockerfile` (already exists — see below)
- **Port**: 80 (expose as HTTP/HTTPS via Coolify)
- **Environment Variables** (minimal):
  - `VITE_API_URL=/api/v1` (optional, used during build if needed)
  - `VITE_ANALYTICS_SRC` and `VITE_ANALYTICS_DOMAIN` (optional; configure as
    Docker **build arguments**, not runtime-only variables). The image derives
    the analytics origin from the script URL and limits CSP script and event
    connections to that origin.
- **Configuration**: Uses existing `front/nginx.conf` which:
  - Serves React static files from root path (`/`)
  - Proxies `/api/*` requests to the API container by its network alias (`dfwsc-api:4242`) — the `api` service joins the external `coolify` network with that alias in `docker-compose.prod.yml`, and the frontend container is on that network by default
- **Dependencies**: Backend service must be reachable (both for the internal nginx proxy above and for any direct/cross-origin API calls the SPA makes)
- **Healthcheck**: `curl -f http://localhost || exit 1`

## Dockerfiles

### Backend Dockerfile (already exists)
The backend/Dockerfile is already optimized for production:
```dockerfile
FROM node:22-alpine AS base
WORKDIR /app

FROM base AS builder
ENV NODE_ENV=development

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json ./
COPY drizzle.config.ts ./drizzle.config.ts
COPY drizzle ./drizzle
COPY src ./src

RUN npm run build:server

FROM base AS production
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/build-dist ./dist
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder /app/drizzle ./drizzle

USER node

CMD ["node", "dist/index.js"]
```

### Frontend Dockerfile (already exists)
`front/Dockerfile` already exists in the repo; it builds the Vite app and serves it via nginx running as a non-root user (required so the container doesn't crash-loop on `/var/cache/nginx` / `/run/nginx.pid` permissions):
```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG VITE_API_URL=/api/v1
ARG VITE_ANALYTICS_SRC=
ARG VITE_ANALYTICS_DOMAIN=
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_ANALYTICS_SRC=$VITE_ANALYTICS_SRC
ENV VITE_ANALYTICS_DOMAIN=$VITE_ANALYTICS_DOMAIN

RUN npm run build

RUN ANALYTICS_ORIGIN="$(node -e 'const source = process.env.VITE_ANALYTICS_SRC; if (!source) process.exit(0); const url = new URL(source); if (!/^https?:$/.test(url.protocol)) throw new Error("VITE_ANALYTICS_SRC must use http or https"); process.stdout.write(url.origin);')" \
    && sed "s|__ANALYTICS_ORIGIN__|${ANALYTICS_ORIGIN}|g" nginx.conf > nginx.production.conf

FROM nginx:alpine AS production
COPY --from=builder /app/build-dist /usr/share/nginx/html
COPY --from=builder /app/nginx.production.conf /etc/nginx/conf.d/default.conf

RUN chown -R nginx:nginx /usr/share/nginx/html /etc/nginx/conf.d /var/cache/nginx \
    && sed -i 's#pid .*nginx\.pid;#pid /tmp/nginx.pid;#' /etc/nginx/nginx.conf

USER nginx

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
```

## Nginx Configuration
The existing `front/nginx.conf` is already configured correctly:
- Serves React app from root
- Proxies `/api/*` to the API container by its network alias (`dfwsc-api:4242`) — the `api` service joins the external `coolify` network with that alias, which the frontend container is on by default
- Includes security headers and compression

## Deployment Sequence

### Phase 1: Infrastructure Setup
1. **Create Database Service**
   - Choose PostgreSQL 17
   - Set environment variables: POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB
   - Enable persistent storage
   - Save and wait for service to become healthy

2. **Create Backend Service** (Coolify "Docker Compose" resource type)
   - Set source to your repository
   - Point it at `docker-compose.prod.yml` — this single resource brings up `migrator`, `api`, `dfwsc-redis`, and `backup` together
   - Add all environment variables from the list above
   - Set dependency on Database being reachable (`DATABASE_URL`)
   - Healthcheck is already defined per-service in the compose file
   - Save and deploy

3. **Create Frontend Service** (separate Coolify Nginx application — not part of `docker-compose.prod.yml`)
   - Set source to your repository
   - Set build context to `./front`
   - Use the existing `front/Dockerfile`
   - Add minimal build arguments (`VITE_API_URL=/api/v1` if needed). For
     analytics, pass both `VITE_ANALYTICS_SRC` and `VITE_ANALYTICS_DOMAIN` as
     build arguments; redeploy after changing either because Vite bakes them
     into the static assets.
   - Leave it on Coolify's default `coolify` network; the backend's `api` service joins that network as `dfwsc-api`, so the nginx proxy can reach `dfwsc-api:4242`
   - Add healthcheck: `curl -f http://localhost || exit 1`
   - Save and deploy

### Phase 2: Configuration & Testing
1. **Verify Database Connection**
   - Check backend logs for successful connection and migration completion

2. **Test API Endpoints**
   - Access backend health: `https://[backend-service].coolify.app/api/v1/health`
   - Swagger UI (`/docs`) is off unless `ENABLE_SWAGGER=true` is set on the API, and `docker-compose.prod.yml` does not pass that variable. There is no production guard in the code: if you set it, the UI is served in production, so leave it unset

3. **Test Frontend**
   - Access frontend: `https://[frontend-service].coolify.app`
   - Verify React app loads correctly
   - Test API proxy: Check network tab for requests to `/api/*` reaching backend

4. **End-to-End Testing**
   - Test admin login and setup
   - Test client onboarding flow
   - Test payment processing (with Stripe test keys)
   - Verify email delivery
   - Test webhook handling

## Coolify-Specific Recommendations

### Service Dependencies
- Use Coolify's dependency management to ensure resources start in correct order:
  - Database → Backend → Frontend
- Within the Backend resource, `docker-compose.prod.yml`'s own `depends_on` already orders `migrator` (must complete) and `dfwsc-redis` (must start) before `api` — no extra Coolify configuration is needed for that internal ordering

### Environment Management
- Use Coolify's built-in secrets management for:
  - STRIPE_SECRET_KEY
  - STRIPE_WEBHOOK_SECRET
  - JWT_SECRET
  - Database passwords
  - SMTP credentials
- Store non-sensitive configuration in environment variables

### Monitoring & Logging
- Enable log aggregation for all services
- Set up resource monitoring (CPU, memory, disk)
- Configure alerting for service failures

### Backup Strategy
- The Backend resource already includes a `backup` service (`docker-compose.prod.yml`) that runs `scripts/backup-db.sh` nightly via its own cron (`0 2 * * *`), writing gzipped `pg_dump` output to the `postgres_backups` volume; set `AWS_S3_BACKUP_BUCKET` to also push backups to S3
- If using Coolify's managed PostgreSQL, also enable its automatic backups for redundancy
- If using self-hosted/external PostgreSQL, ensure `postgres_backups` sits on persistent storage and periodically run a restore drill — an untested backup is not a backup
- Consider backing up uploaded files if you add file storage later

### SSL/TLS
- Coolify automatically handles SSL termination
- No need to configure SSL in your services
- Access via HTTPS://your-domain.com

## Troubleshooting

### Common Issues
1. **Database Connection Failures**
   - Verify DATABASE_URL uses correct service name
   - Check that database service is healthy before starting backend
   - Confirm username/password/database name match

2. **API Proxy Not Working**
   - Verify nginx.conf is being used in frontend service
   - Check that backend service is healthy and accessible
   - Ensure frontend service depends on backend service

3. **Build Failures**
   - Check that all dependencies are in package.json
   - Verify node_modules are not being excluded incorrectly
   - Check build output for specific error messages

4. **Environment Variable Issues**
   - Double-check variable names match exactly
   - Verify secrets are properly injected
   - Check for extra spaces or quotes in values

5. **`Rate limiter Redis error` / `NOAUTH Authentication required` in the API log**
   - The API is talking to a Redis other than the stack's own, usually Coolify's control-plane Redis reached through the short name `redis` on the shared `coolify` network. Limits still work through the in-memory fallback, but are no longer shared or persistent.
   - Confirm `docker-compose.prod.yml` points `REDIS_URL` at `redis://dfwsc-redis:6379`, and that `docker exec <api container> getent hosts dfwsc-redis` returns an address on the stack's `backend` network.
   - Any hostname the `api` service uses must be unique across everything on the `coolify` network; give shared-network services an explicit alias rather than relying on the compose service name.

## Maintenance

### Updates
1. Push changes to your repository
2. Coolify will detect changes based on your monitor paths configuration
3. Each service will rebuild and redeploy if its source changed
4. Services will restart in dependency order

### Scaling
- Scale frontend independently based on web traffic
- Scale backend based on API usage
- Database scaling handled by Coolify's PostgreSQL offering

### Environment Promotion
- Use the same configuration for dev/staging/prod
- Only change environment variable values
- Consider using Coolify's environment promotion features

## Files Reference

Key files for Coolify deployment:
- `backend/Dockerfile` - Production backend build
- `docker-compose.prod.yml` - Compose source for the Backend resource (`migrator`, `api`, `dfwsc-redis`, `backup`)
- `front/Dockerfile` - Frontend build (already exists)
- `front/nginx.conf` - Already configured for API proxying
- `scripts/backup-db.sh` - Nightly DB backup script, run by the `backup` service
- `backend/.env` - Reference for environment variable names (use values, don't commit file)
- `docker-compose.base.yml` / `docker-compose.dev.yml` - Local dev stack reference for service relationships

This setup gives you the benefits of both worlds:
- **Development**: Monorepo simplicity with atomic commits and shared tooling
- **Deployment**: Microservice flexibility with independent scaling, fault isolation, and deployment
