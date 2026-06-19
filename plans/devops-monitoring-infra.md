# Plan: DevOps, Monitoring & Infrastructure

## Goal
Harden Docker configuration, add monitoring/alerting, implement backup strategy, set up CI/CD, and add resource limits.

## Current State
- Nginx runs as root (`front/Dockerfile:14-21`)
- No resource limits on any service
- No monitoring, metrics, or alerting
- No error tracking (Sentry, etc.)
- No CI/CD pipeline
- No database backup strategy
- Dev containers run as root (`docker-compose.dev.yml:4,53`)
- Production API exposed to all interfaces (`docker-compose.prod.yml:38`)
- Migrations run inside Dockerfile CMD (`backend/Dockerfile:30`)
- No custom Docker networks — all services on default bridge

---

## Step 1: Harden Dockerfiles

### 1a: Frontend Dockerfile — non-root nginx

**File:** `front/Dockerfile`

```dockerfile
FROM nginx:alpine AS production

COPY --from=builder /app/build-dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Run as non-root
RUN chown -R nginx:nginx /usr/share/nginx/html /etc/nginx/conf.d
USER nginx

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

### 1b: Backend Dockerfile — remove migration from CMD

**File:** `backend/Dockerfile`

```dockerfile
# BEFORE (line 30)
CMD ["sh", "-c", "npm run db:migrate && npm run start"]

# AFTER — migrations handled by separate migrator service
CMD ["node", "dist/index.js"]
```

**Verification:** `docker run backend-image` → starts without running migrations. Nginx container runs as non-root.

---

## Step 2: Add resource limits to all services

**File:** `docker-compose.prod.yml`

```yaml
services:
  api:
    # ... existing config ...
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M
        reservations:
          cpus: "0.5"
          memory: 256M

  migrator:
    # ... existing config ...
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 256M
```

**File:** `docker-compose.base.yml` (dev)

```yaml
  api:
    # ... existing ...
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M

  db:
    # ... existing ...
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 1G
```

**Verification:** `docker stats` → all containers respect their limits. Memory leak in API → container OOM-kills instead of host crash.

---

## Step 3: Add custom Docker networks

**File:** `docker-compose.base.yml`

```yaml
services:
  # ... services unchanged ...

networks:
  frontend:
    driver: bridge
  backend:
    driver: bridge

# Update service network assignments:
  web:
    networks:
      - frontend
    # ...

  api:
    networks:
      - frontend
      - backend
    # ...

  db:
    networks:
      - backend
    # ...

  mailhog:
    networks:
      - backend
    # ...
```

**Verification:** `docker network ls` → shows `frontend` and `backend` networks. Web cannot reach DB directly.

---

## Step 4: Set up database backups

### 4a: Create backup script

**File:** New `scripts/backup-db.sh`

```bash
#!/bin/bash
set -euo pipefail

BACKUP_DIR="/backups/postgres"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/stripe_portal_${TIMESTAMP}.sql.gz"
RETENTION_DAYS=30

mkdir -p "$BACKUP_DIR"

# Dump and compress
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U postgres stripe_portal | gzip > "$BACKUP_FILE"

# Upload to S3 (if configured)
if [ -n "${AWS_S3_BACKUP_BUCKET:-}" ]; then
  aws s3 cp "$BACKUP_FILE" "s3://${AWS_S3_BACKUP_BUCKET}/backups/$(basename "$BACKUP_FILE")"
fi

# Clean old local backups
find "$BACKUP_DIR" -name "*.sql.gz" -mtime +${RETENTION_DAYS} -delete

echo "Backup complete: ${BACKUP_FILE}"
```

### 4b: Add scheduled task

**File:** `docker-compose.prod.yml`

```yaml
  backup:
    image: postgres:17
    volumes:
      - ./scripts/backup-db.sh:/backup.sh
      - pgbackups:/backups/postgres
    environment:
      PGPASSWORD: ${POSTGRES_PASSWORD}
    command: ["bash", "/backup.sh"]
    restart: "no"
    networks:
      - backend
```

Or use Coolify's scheduled task feature:

```
# Cron: daily at 2 AM
0 2 * * * bash /path/to/backup-db.sh
```

**Verification:** Run backup script → `.sql.gz` file created. Restore from backup → data intact.

---

## Step 5: Add monitoring and metrics

### 5a: Add Prometheus metrics endpoint

**File:** New `backend/src/routes/metrics.ts`

```typescript
import type { FastifyInstance } from "fastify";
import { db } from "../db/client";
import { clients, webhookEvents } from "../db/schema";

export default async function metricsRoute(fastify: FastifyInstance) {
  fastify.get("/metrics", async (_request, reply) => {
    const [clientCount] = await db.select({ count: count() }).from(clients);
    const [webhookCount] = await db.select({ count: count() }).from(webhookEvents);
    const [unprocessedWebhooks] = await db
      .select({ count: count() })
      .from(webhookEvents)
      .where(isNull(webhookEvents.processedAt));

    const metrics = [
      `# HELP dfwsc_clients_total Total number of clients`,
      `# TYPE dfwsc_clients_total gauge`,
      `dfwsc_clients_total ${clientCount.count}`,
      `# HELP dfwsc_webhooks_total Total webhook events received`,
      `# TYPE dfwsc_webhooks_total counter`,
      `dfwsc_webhooks_total ${webhookCount.count}`,
      `# HELP dfwsc_webhooks_unprocessed Unprocessed webhook events`,
      `# TYPE dfwsc_webhooks_unprocessed gauge`,
      `dfwsc_webhooks_unprocessed ${unprocessedWebhooks.count}`,
    ].join("\n");

    return reply.type("text/plain").send(metrics);
  });
}
```

Register in `app.ts`:

```typescript
import metricsRoutes from "./routes/metrics";
server.register(metricsRoutes, { prefix: "/api/v1" });
```

### 5b: Add Prometheus + Grafana to Docker Compose

**File:** `docker-compose.prod.yml`

```yaml
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus_data:/prometheus
    ports:
      - "127.0.0.1:9090:9090"
    networks:
      - backend
    restart: unless-stopped

  grafana:
    image: grafana/grafana:latest
    volumes:
      - grafana_data:/var/lib/grafana
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_PASSWORD:-admin}
    networks:
      - backend
    restart: unless-stopped
```

**New file:** `prometheus.yml`

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: "dfwsc-api"
    static_configs:
      - targets: ["api:4242"]
    metrics_path: "/api/v1/metrics"
```

**Verification:** `curl http://localhost:9090/api/v1/query?query=dfwsc_clients_total` → returns client count. Grafana dashboard shows metrics.

---

## Step 6: Add error tracking (Sentry)

**File:** `backend/src/app.ts`

```bash
npm install @sentry/node
```

```typescript
// In app.ts, before registering routes:
import * as Sentry from "@sentry/node";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0.1,
  });
}

// In the error handler:
server.setErrorHandler((error, request, reply) => {
  Sentry.captureException(error, { extra: { requestId: request.id } });
  // ... existing handling
});
```

Add `SENTRY_DSN` to `docker-compose.prod.yml` environment.

**Verification:** Trigger an unhandled error → appears in Sentry dashboard with request ID.

---

## Step 7: Add alerting

### 7a: Health check monitoring

Use UptimeRobot, Pingdom, or Healthchecks.io to ping `GET /api/v1/health` every 5 minutes. Configure Slack/PagerDuty webhook on failure.

### 7b: Sentry alert rules

Configure Sentry alerts for:
- Error rate > 5 per minute
- New error type not seen before
- P95 latency > 5 seconds

### 7c: Prometheus alerting (optional)

**New file:** `alertmanager.yml`

```yaml
route:
  receiver: slack
receivers:
  - name: slack
    slack_configs:
      - api_url: ${SLACK_WEBHOOK_URL}
        channel: "#alerts"
        title: "{{ .GroupLabels.alertname }}"
        text: "{{ .CommonAnnotations.description }}"
```

**Verification:** Kill the API container → UptimeRobot sends alert within 5 minutes. Trigger error → Sentry notification.

---

## Step 8: Set up CI/CD pipeline

**File:** New `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run lint

  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run typecheck

  test:
    runs-on: ubuntu-latest
    services:
      db:
        image: postgres:17
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: stripe_portal_test
        ports:
          - 5432:5432
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run test
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/stripe_portal_test

  build:
    runs-on: ubuntu-latest
    needs: [lint, typecheck, test]
    steps:
      - uses: actions/checkout@v4
      - run: docker compose -f docker-compose.prod.yml build
```

**File:** New `.github/workflows/deploy.yml`

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    needs: build
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to production
        run: |
          # SSH to server and pull latest
          ssh ${{ secrets.DEPLOY_HOST }} "cd /opt/dfwsc && git pull && docker compose -f docker-compose.prod.yml up -d --build"
```

**Verification:** Push to main → CI runs lint, typecheck, test, build. All green → deploy.

---

## Step 9: Fix production API port binding

**File:** `docker-compose.prod.yml`

```yaml
# BEFORE (line 38)
ports:
  - "4242:4242"

# AFTER — bind to localhost only (behind reverse proxy)
ports:
  - "127.0.0.1:4242:4242"
```

**Verification:** `netstat -tlnp` → port 4242 only on 127.0.0.1, not 0.0.0.0.

---

## Verification Plan
1. `docker stats` → all containers respect resource limits
2. `docker network ls` → shows `frontend` and `backend` networks
3. `scripts/backup-db.sh` → creates `.sql.gz` file
4. `curl http://localhost:9090/api/v1/query?query=dfwsc_clients_total` → returns count
5. Trigger error → appears in Sentry dashboard
6. Kill API → UptimeRobot alerts within 5 minutes
7. Push to main → CI pipeline runs
8. `netstat -tlnp` → port 4242 on 127.0.0.1 only

## Risks
- Adding Prometheus/Grafana increases production resource requirements
- CI/CD pipeline needs GitHub secrets configured (DEPLOY_HOST, SENTRY_DSN, etc.)
- Backup script needs S3 credentials if using cloud backup
- Custom networks change service discovery — verify all `depends_on` still work
