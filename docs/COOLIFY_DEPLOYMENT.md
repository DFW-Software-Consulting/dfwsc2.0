# Coolify Deployment Guide for DFWSC Payment Portal

This guide explains how to deploy the DFW Software Consulting payment portal to Coolify as separate services while maintaining the monorepo structure.

## Overview

The application deploys to Coolify as two independent resources, plus a database:
1. **Database** - PostgreSQL (Coolify-managed or an external instance — there is no `db` service in `docker-compose.prod.yml`)
2. **Backend** - a Coolify **Docker Compose** resource built from `docker-compose.prod.yml`, which runs four containers: `migrator`, `api`, `redis`, and `backup` (see below)
3. **Frontend** - a **separate** Coolify **Nginx** application serving the built React app with API proxying — it is not one of the services in `docker-compose.prod.yml` and deploys/scales independently of the backend

All resources can be deployed independently on Coolify while sharing the same monorepo.

## Service Configuration

### 1. Database Service
- **Type**: PostgreSQL (Use Coolify's managed PostgreSQL or an external/custom instance)
- **Not in the Compose file**: `docker-compose.prod.yml` has no `db` service — provision this separately and point the Backend's `DATABASE_URL` at it
- **Port**: 5432 (internal only)
- **Environment Variables**:
  - POSTGRES_USER=postgres
  - POSTGRES_PASSWORD=postgres
  - POSTGRES_DB=stripe_portal
- **Storage**: Enable persistent volume for data directory
- **Healthcheck**: `pg_isready -U postgres -d stripe_portal`

### 2. Backend Service (API)
- **Source**: `./backend` directory, deployed as a Coolify **Docker Compose** resource pointing at `docker-compose.prod.yml`
- **Containers**: that compose file defines four services:
  - `migrator` - runs `npm run db:migrate` once against `DATABASE_URL`, then exits; `api` will not start until this completes successfully
  - `api` (container name `dfwsc-api`) - the Fastify server, `node dist/index.js`, port 4242
  - `redis` - backs rate limiting and circuit-breaker state; `api`'s `REDIS_URL` defaults to `redis://redis:6379`, the in-stack service, so it rarely needs to be set explicitly
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
  USE_CHECKOUT=true
  DEFAULT_PROCESS_FEE_CENTS=100
  SMTP_HOST=your_smtp_host
  SMTP_PORT=your_smtp_port
  SMTP_USER=your_smtp_user
  SMTP_PASS=your_smtp_password
  SMTP_FROM=noreply@yourdomain.com
  API_BASE_URL=https://your-backend-domain.com
  ALLOW_ADMIN_SETUP=false  # Set to true only during initial admin setup
  ```
- **Startup Command**: `node dist/index.js` (handled by Dockerfile). DB migrations run automatically on each deploy via the `migrator` service above — no separate manual migration step is needed.
- **Dependencies**: Database must be reachable via `DATABASE_URL` before deploying; within the compose stack, `api` also depends on `migrator` (completed) and `redis` (started) automatically
- **Healthcheck**: `curl -f http://localhost:4242/api/v1/health || exit 1` (the compose file itself uses an equivalent `wget` healthcheck)

### 3. Frontend Service (React + Nginx)
- **Deployment**: a **separate** Coolify Nginx application, independent of the backend's Compose stack — it is not a service in `docker-compose.prod.yml` and is deployed/scaled on its own
- **Source**: `./front` directory
- **Build**: Multi-stage `front/Dockerfile` (already exists — see below)
- **Port**: 80 (expose as HTTP/HTTPS via Coolify)
- **Environment Variables** (minimal):
  - VITE_API_URL=/api/v1 (optional, used during build if needed)
- **Configuration**: Uses existing `front/nginx.conf` which:
  - Serves React static files from root path (`/`)
  - Proxies `/api/*` requests to the API container by its internal Docker name (`dfwsc-api:4242`) — this requires the frontend container to be attached to the same Docker network as the backend stack
- **Dependencies**: Backend service must be reachable (both for the internal nginx proxy above and for any direct/cross-origin API calls the SPA makes)
- **Healthcheck**: `curl -f http://localhost || exit 1`

## Dockerfiles

### Backend Dockerfile (already exists)
The backend/Dockerfile is already optimized for production:
```dockerfile
FROM node:20-alpine AS base
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
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG VITE_API_URL=/api/v1
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build

FROM nginx:alpine AS production
COPY --from=builder /app/build-dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

RUN chown -R nginx:nginx /usr/share/nginx/html /etc/nginx/conf.d /var/cache/nginx \
    && sed -i 's#pid .*nginx\.pid;#pid /tmp/nginx.pid;#' /etc/nginx/nginx.conf

USER nginx

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
```

## Nginx Configuration
The existing `front/nginx.conf` is already configured correctly:
- Serves React app from root
- Proxies `/api/*` to the API container by its internal Docker name (`dfwsc-api:4242`) — requires the frontend container to share a Docker network with the backend stack
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
   - Point it at `docker-compose.prod.yml` — this single resource brings up `migrator`, `api`, `redis`, and `backup` together
   - Add all environment variables from the list above
   - Set dependency on Database being reachable (`DATABASE_URL`)
   - Healthcheck is already defined per-service in the compose file
   - Save and deploy

3. **Create Frontend Service** (separate Coolify Nginx application — not part of `docker-compose.prod.yml`)
   - Set source to your repository
   - Set build context to `./front`
   - Use the existing `front/Dockerfile`
   - Add minimal environment variables (VITE_API_URL=/api/v1 if needed)
   - Attach it to the same Docker network as the backend stack so its nginx proxy can reach `dfwsc-api:4242`
   - Add healthcheck: `curl -f http://localhost || exit 1`
   - Save and deploy

### Phase 2: Configuration & Testing
1. **Verify Database Connection**
   - Check backend logs for successful connection and migration completion

2. **Test API Endpoints**
   - Access backend health: `https://[backend-service].coolify.app/api/v1/health`
   - Access Swagger docs: `https://[backend-service].coolify.app/docs/`

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
- Within the Backend resource, `docker-compose.prod.yml`'s own `depends_on` already orders `migrator` (must complete) and `redis` (must start) before `api` — no extra Coolify configuration is needed for that internal ordering

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
- `docker-compose.prod.yml` - Compose source for the Backend resource (`migrator`, `api`, `redis`, `backup`)
- `front/Dockerfile` - Frontend build (already exists)
- `front/nginx.conf` - Already configured for API proxying
- `scripts/backup-db.sh` - Nightly DB backup script, run by the `backup` service
- `backend/.env` - Reference for environment variable names (use values, don't commit file)
- `docker-compose.base.yml` / `docker-compose.dev.yml` - Local dev stack reference for service relationships

This setup gives you the benefits of both worlds:
- **Development**: Monorepo simplicity with atomic commits and shared tooling
- **Deployment**: Microservice flexibility with independent scaling, fault isolation, and deployment
