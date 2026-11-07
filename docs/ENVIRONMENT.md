# Environment Variables and Feature Flags

This is the reference for every environment variable the portal reads. Other docs link here instead of repeating variable lists.

Sources: `backend/src/lib/env.ts` (boot validation), `backend/src/lib/config.ts`, and every `process.env` read under `backend/src`; `docker-compose.prod.yml`, `docker-compose.base.yml` and `docker-compose.dev.yml` (what each stack passes to the containers); `front/Dockerfile`; `backup/scripts`; `.env.example` (the local template).

## How to read the tables

- **Required** means the process refuses to start (or the named feature cannot work) without it.
- **Default** is the value used when the variable is unset or empty. A dash means no default.
- **Prod compose** says whether `docker-compose.prod.yml` forwards the variable to the container:
  - `Yes` - forwarded as `${NAME}` with no default. If the variable is not set in Coolify, the container receives an empty string, which the code treats as unset (see "Empty strings" below).
  - `Yes, default X` - forwarded as `${NAME:-X}`.
  - `Fixed` - the compose file sets a literal value; a Coolify variable of the same name has no effect.
  - **No** - the code reads it, but the compose file does not forward it. Setting it in Coolify has **no effect in production today**, because the container only receives variables listed in the compose file. These are current behavior, not mistakes in this document.
- Boolean feature flags are strictly `true`. Any other value (`1`, `TRUE`, `yes`) leaves the feature off. The Nextcloud-backed flags trim whitespace first; `ENABLE_SWAGGER`, `CONNECT_INVOICING` and `CEREBO_ENABLED` compare the raw value (`backend/src/app.ts:208,227,243`).

### Empty strings

Compose passes an unset `${NAME}` as an empty string. `validateEnv()` skips empty values for optional variables (`backend/src/lib/env.ts`, the `if (value)` checks), and the loaders compare against `"true"` or fall back to defaults, so an empty string behaves as unset. One exception: `SMTP_FROM` is read with `??` in `backend/src/lib/mailer.ts:61`, so an empty `SMTP_FROM` is used as an empty sender instead of falling back to `SMTP_USER@SMTP_HOST`. Always set it in production.

## 1. Core API

Validated at boot by `validateEnv()` (called from `buildServer()` in `backend/src/app.ts`). A missing required variable throws `Missing required environment variables: ...` and the API does not start.

| Variable | Required | Default | Purpose | Prod compose |
|----------|----------|---------|---------|--------------|
| `NODE_ENV` | No | - | `production` skips `.env` loading and dev auto-migration (`backend/src/index.ts:6,36`); `test` silences the logger. | Yes, default `production` |
| `PORT` | No | `4242` | API listen port (`backend/src/index.ts:58`). | Yes, default `4242` |
| `HOST` | No | `0.0.0.0` | API listen address (`backend/src/index.ts:59`). | **No** |
| `DATABASE_URL` | **Yes** | - | PostgreSQL connection string. Also used by `drizzle-kit` and the migrator. A password containing `/`, `@` or `:` must be percent-encoded. | Yes (api, migrator, backup) |
| `DB_POOL_MAX` | No | `10` | `pg` pool size (`backend/src/db/client.ts:7`, `DEFAULT_DB_POOL_MAX` in `constants.ts`). | **No** |
| `STRIPE_SECRET_KEY` | **Yes** | - | Platform Stripe secret key. `backend/src/lib/stripe.ts:3` also throws at import time if it is missing. | Yes |
| `STRIPE_WEBHOOK_SECRET` | **Yes** | - | Signing secret for `POST /api/v1/webhooks/stripe` (`backend/src/routes/webhooks.ts:473`). | Yes |
| `FRONTEND_ORIGIN` | **Yes** | - | Comma-separated CORS allow-list. The first entry (trailing slash removed) is also the base for Checkout and onboarding redirects (`resolveFrontendOrigin` in `config.ts`). | Yes |
| `JWT_SECRET` | **Yes** | - | Signs admin JWTs. At least 32 characters or boot fails (`MIN_JWT_SECRET_LENGTH`). | Yes |
| `JWT_EXPIRY` | No | `1h` | Lifetime of admin JWTs (`backend/src/lib/auth.ts:231`, `routes/auth.ts:84`). | Yes |
| `SMTP_HOST` | **Yes** | - | SMTP server. | Yes |
| `SMTP_PORT` | **Yes** | - | SMTP port. Port `465` uses implicit TLS; any other port does not (`mailer.ts`, `secure = port === 465`). | Yes |
| `SMTP_USER` | **Yes** | - | SMTP username. | Yes |
| `SMTP_PASS` | **Yes** | - | SMTP password. | Yes |
| `SMTP_FROM` | No | `SMTP_USER@SMTP_HOST` | From address for outgoing mail. Also the fallback recipient for the contact form and a displayed setting. | Yes |
| `CONTACT_INBOX` | No | `SMTP_FROM` | Recipient of `POST /api/v1/contact`. Must be a valid email address or the route answers 500 `CONFIGURATION_ERROR` (`config.ts`, `resolveContactInboxEmail`). | Yes |
| `API_BASE_URL` | Yes in production | - | Public base URL of the API (for example `https://api.dfwsc.com`). Used to build Stripe onboarding callback and refresh links. In production an unset value is a 500 `CONFIGURATION_ERROR` at request time; outside production the code falls back to the request `Host` and `X-Forwarded-*` headers (`config.ts`, `resolveServerBaseUrl`). `GET /app-config.js` answers 500 whenever it is unset, in every environment (`backend/src/routes/config.ts`). | Yes |
| `DEFAULT_PROCESS_FEE_CENTS` | No | `0` | Platform processing fee in cents, used when the `default_fee_cents` setting is not stored in the database (`stripe-billing.ts:209`, `routes/settings.ts:49`). | Yes |
| `DEFAULT_PAYMENT_SUCCESS_URL` | No | - | Checkout success redirect used after client and group URLs and before the `FRONTEND_ORIGIN` fallback. Must be `http(s)`; `session_id={CHECKOUT_SESSION_ID}` is appended if missing. | **No** |
| `DEFAULT_PAYMENT_CANCEL_URL` | No | - | Checkout cancel redirect, same precedence. | **No** |
| `ADMIN_NEXTCLOUD_GROUPS` | No | `dfwsc-admins,managers` | Comma-separated Nextcloud group ids allowed to sign in to the admin panel (`backend/src/lib/admin-login.ts:95`). Admin login also needs the Nextcloud service account in section 3; without it login answers 503. | Yes, default `dfwsc-admins,managers` |
| `REDIS_URL` | No | - | Enables Redis-backed rate limiting. Unset or unreachable: per-process in-memory buckets, with a warning at boot (`backend/src/lib/rate-limit.ts:21`). | **Fixed**: `redis://dfwsc-redis:6379`. A Coolify `REDIS_URL` is ignored. |

### Admin login and the `admins` table

There are no local admin accounts, and `ADMIN_USERNAME`, `ADMIN_PASSWORD` and `ALLOW_ADMIN_SETUP` are not read anywhere. Remove them from any environment that still has them.

## 2. Proxy, client IP and operations

| Variable | Required | Default | Purpose | Prod compose |
|----------|----------|---------|---------|--------------|
| `TRUST_PROXY` | No | `loopback,linklocal,uniquelocal` | Which proxies Fastify trusts for `X-Forwarded-For`. Accepts `true`, `false`, or a comma-separated list of IPs, CIDRs or named ranges. A bare number (the old hop-count form) is rejected: the default list is used and a warning is logged (`backend/src/app.ts:25-60,113`). | **No** (the default applies) |
| `CLOUDFLARE_IP_RANGES` | No | Built-in Cloudflare ranges (`client-ip.ts`) | Comma-separated CIDRs whose connections may supply the client address through `CF-Connecting-IP`. `none` disables that path. An invalid entry throws at startup. IPv6 clients are rate limited per /64. | **No** (the built-in list applies) |
| `METRICS_TOKEN` | No | - | Bearer token for `GET /api/v1/metrics`. Unset means the route answers 404 (`backend/src/routes/metrics.ts:44`). | **No**: in production `/metrics` is always 404 today |
| `ENABLE_SWAGGER` | No | off | Exactly `true` registers Swagger UI at `/docs` (`app.ts:208`). There is no production guard in code. | **No**: Swagger is off in production |

Dev note: `docker-compose.base.yml` sets `ENABLE_SWAGGER: 'false'` as a literal in the `api` service, and compose `environment:` wins over `env_file`, so the dev stack cannot enable Swagger from `.env` without editing the compose file.

## 3. Nextcloud service account

One shared service account used by every Nextcloud integration and by admin login. All three values are required together, and the URL must be `https://` (`backend/src/lib/nextcloud.ts:25-35`). Nextcloud calls go through their own circuit breaker, so an outage does not affect payments.

| Variable | Required | Default | Purpose | Prod compose |
|----------|----------|---------|---------|--------------|
| `NEXTCLOUD_BASE_URL` | Yes for admin login and any flag below | - | Nextcloud base URL, HTTPS only. | Yes |
| `NEXTCLOUD_USERNAME` | Same | - | Service account user id. For admin login it must be a Nextcloud admin (it reads each user's groups). | Yes |
| `NEXTCLOUD_APP_PASSWORD` | Same | - | App password for that account (not the login password). | Yes |

## 4. Feature flags and background jobs

Every flag below defaults to off. A flag that is on but misconfigured logs the problems once and leaves its job off; it never stops the API from serving (`backend/src/index.ts`, `start*` calls after `server.listen`). Operational detail for each feature is in [BACKEND.md](./BACKEND.md) sections 9-16 and [STRIPE.md](./STRIPE.md).

| Flag | What it turns on | Needs besides the Nextcloud account | Prod compose |
|------|------------------|-------------------------------------|--------------|
| `CONNECT_INVOICING` | Registers the `/api/v1/customers` and invoice routes (connected-account invoicing). Each client also needs `invoicing_enabled`. Anything other than `true` answers 404. | - | Yes, default `false` |
| `CEREBO_ENABLED` | Registers the `/api/v1/cerebo/*` API. Its tables are created by the normal migrations either way. | - | Yes, default `false` |
| `SALES_AUTOMATION_ENABLED` | New Lead poller, plus the website contact form submitting leads to the New Lead form. | `SALES_LEAD_FORM_ID`, `SALES_PIPELINE_TABLE_ID`, `SALES_ADDRESSBOOK_PATH`, `SALES_LEADS_FOLDER` | Yes, default `false` |
| `CLIENT_ONBOARDING_ENABLED` | Client onboarding poller (Convert Won Lead to Client form). | `CLIENT_ONBOARDING_FORM_ID`, `..._PROJECTS_TABLE_ID`, `..._PIPELINE_TABLE_ID`, `..._COLLECTIVE_ID`, `..._ADDRESSBOOK_PATH`, `..._CLIENTS_FOLDER` | Yes, default `false` |
| `CLIENT_ONBOARDING_PROJECT_TEAMS` | Per-project Nextcloud Team, wiki and folder share. | `CLIENT_ONBOARDING_TEAM_ADMINS` (at least one user id) | Yes, default `false` |
| `CLIENT_ONBOARDING_BILLING_CUSTOMER` | Finds or creates a Stripe Customer on the platform account for each New Client submission. | `CLIENT_ONBOARDING_ENABLED` | Yes, default `false` |
| `CONTACT_STRIPE_SYNC` | Pushes edits of a client's Nextcloud contact card to its billing Stripe Customer. | `CLIENT_ONBOARDING_ADDRESSBOOK_PATH` | Yes, default `false` |
| `PORTAL_MIRROR` | Read-only "Portal Accounts" Nextcloud Table. Also kicked by many write paths (`kickJob("portalMirror")`). | - (`PORTAL_ACCOUNTS_TABLE_ID` only for a hand-made table) | Yes, default `false` |
| `BILLING_MIRROR` | Read-only "Client Billing" Nextcloud Table. Uses `PORTAL_MIRROR_INTERVAL_MS` and `PORTAL_MIRROR_BATCH` for its loop. | - | Yes, default `false` |
| `STRIPE_ID_WRITEBACK` | Writes each billing client's Stripe Customer id onto its Client Projects row and contact card. | `CLIENT_ONBOARDING_PROJECTS_TABLE_ID`, `CLIENT_ONBOARDING_ADDRESSBOOK_PATH` (not `CLIENT_ONBOARDING_ENABLED`) | Yes, default `false` |
| `BILLING_REQUESTS_ENABLED` | "New invoice" form creating real Stripe invoices and plans on the platform account. | `BILLING_REQUESTS_FORM_ID` | Yes, default `false` |

Jobs that can be triggered by a write elsewhere in the API (`kickJob`, `backend/src/lib/coalesced-runner.ts`): `salesLead`, `billingMirror`, `portalMirror`, `stripeIdWriteback`. A kick is a no-op when the job is off.

### Sales lead automation

| Variable | Default | Purpose | Prod compose |
|----------|---------|---------|--------------|
| `SALES_LEAD_FORM_ID` | - | Nextcloud Forms id of the New Lead form. Positive integer. | Yes |
| `SALES_PIPELINE_TABLE_ID` | - | Nextcloud Table id of the sales pipeline. Positive integer. | Yes |
| `SALES_ADDRESSBOOK_PATH` | - | One address book collection name as the service account sees it (no `/`). | Yes |
| `SALES_LEADS_FOLDER` | - | Folder path for lead folders, relative to the service account's files root. No `.` or `..`. | Yes |
| `SALES_POLL_INTERVAL_MS` | `120000` | Poll interval; minimum `30000`. | Yes, default `120000` |
| `SALES_LEAD_WEBHOOK_SECRET` | - | Bearer secret for `POST /api/v1/webhooks/nextcloud/sales-lead`, at least 32 characters. Unset: the endpoint answers 404 and only the poll runs. | Yes |

### Client onboarding

| Variable | Default | Purpose | Prod compose |
|----------|---------|---------|--------------|
| `CLIENT_ONBOARDING_FORM_ID` | - | Forms id of the Convert Won Lead to Client form. | Yes |
| `CLIENT_ONBOARDING_PROJECTS_TABLE_ID` | - | Client Projects table id. Also used by `STRIPE_ID_WRITEBACK`. | Yes |
| `CLIENT_ONBOARDING_PIPELINE_TABLE_ID` | - | Pipeline table id. | Yes |
| `CLIENT_ONBOARDING_COLLECTIVE_ID` | - | Collective id for project wikis. | Yes |
| `CLIENT_ONBOARDING_ADDRESSBOOK_PATH` | - | Address book collection name. Also used by `CONTACT_STRIPE_SYNC` and `STRIPE_ID_WRITEBACK`. | Yes |
| `CLIENT_ONBOARDING_CLIENTS_FOLDER` | - | Folder for client folders, relative to the files root. | Yes |
| `CLIENT_ONBOARDING_WEBHOOK_SECRET` | - | Bearer secret for `POST /api/v1/webhooks/nextcloud/client-onboarding`, at least 32 characters. Unset: 404, poll only. | Yes |
| `CLIENT_ONBOARDING_POLL_INTERVAL_MS` | `300000` | Safety-net poll; minimum `30000`. | Yes, default `300000` |
| `CLIENT_ONBOARDING_TEAM_ADMINS` | - | Comma-separated Nextcloud user ids added to every project team as admins. | Yes |

### Mirrors, sync and write-back

| Variable | Default | Purpose | Prod compose |
|----------|---------|---------|--------------|
| `CONTACT_STRIPE_SYNC_INTERVAL_MS` | `120000` | Contact sync interval; minimum `10000`. | Yes, default `120000` |
| `PORTAL_MIRROR_INTERVAL_MS` | `60000` | Mirror loop interval (shared with `BILLING_MIRROR`); minimum `10000`, maximum 24 h. | Yes, default `60000` |
| `PORTAL_MIRROR_BATCH` | `25` | Rows handled per cycle (shared with `BILLING_MIRROR`); 1 to 100. | Yes, default `25` |
| `PORTAL_MIRROR_SHARE_GROUPS` | `dfwsc-admins,managers` | Nextcloud groups given read-only access to the Portal Accounts table. | Yes, same default |
| `PORTAL_MIRROR_INCLUDE_ARCHIVED` | `false` | `true` shows archived clients. | Yes, default `false` |
| `PORTAL_ACCOUNTS_TABLE_ID` | - | Fallback: use a hand-made table instead of one the API creates and shares. | Yes |
| `BILLING_MIRROR_SHARE_GROUPS` | `dfwsc-admins,managers` | Groups given read-only access to the Client Billing table. | Yes, same default |
| `BILLING_SWEEP_INTERVAL_MS` | `3600000` | Full re-read of every Stripe Customer; minimum 60 s, maximum 7 days. | Yes, default `3600000` |
| `STRIPE_ID_WRITEBACK_INTERVAL_MS` | `300000` | Reconcile interval; minimum `60000`, maximum 24 h. | Yes, default `300000` |
| `STRIPE_ID_WRITEBACK_DRY_RUN` | live | `true`, `1` or `yes`: log planned writes, write nothing. `false`, `0`, `no` or **empty/unset**: live writes. Any other value is treated as a dry run and warned (`stripe-id-writeback-sync.ts`, `parseDryRun`). | Yes, default `false` (live) |

Because an unset or empty `STRIPE_ID_WRITEBACK_DRY_RUN` means live writes, switching `STRIPE_ID_WRITEBACK` on without first setting `STRIPE_ID_WRITEBACK_DRY_RUN=true` writes to Nextcloud on the first cycle.

### Billing requests and Stripe billing webhook

| Variable | Default | Purpose | Prod compose |
|----------|---------|---------|--------------|
| `BILLING_REQUESTS_FORM_ID` | - | Forms id of the New invoice form. | Yes |
| `BILLING_REQUESTS_WEBHOOK_SECRET` | - | Bearer secret for `POST /api/v1/webhooks/nextcloud/billing-request`, at least 32 characters. Unset: 404, poll only. | Yes |
| `BILLING_REQUESTS_POLL_INTERVAL_MS` | `300000` | Poll interval; minimum `30000`, maximum 24 h. | Yes, default `300000` |
| `BILLING_REQUESTS_ALLOWED_GROUPS` | `dfwsc-admins,managers` | Groups whose members may submit (checked by the API in addition to the form's own restriction). | Yes, same default |
| `BILLING_REQUESTS_SHARE_GROUPS` | `dfwsc-admins,managers` | Groups with read-only access to the "Billing Requests" table. | Yes, same default |
| `BILLING_REQUESTS_MAX_AGE_HOURS` | `72` | Older submissions are marked Expired and not billed (unless Stripe objects already exist for them). 1 to 8760. | Yes, default `72` |
| `BILLING_MAX_AMOUNT_CENTS` | `2500000` | Largest amount per invoice or per plan payment. 1 to 100000000. | Yes, default `2500000` |
| `BILLING_AUTO_SEND` | `true` | `false` leaves one-off invoices as drafts. Any value other than `true` or `false` is a config problem. | Yes, default `true` |
| `BILLING_DEFAULT_DAYS_UNTIL_DUE` | `7` | Days an invoice or plan payment stays due. 1 to 365. | Yes, default `7` |
| `STRIPE_BILLING_WEBHOOK_SECRET` | - | Signing secret of the account-level Stripe endpoint `POST /api/v1/webhooks/stripe-billing` (`routes/webhooks-billing.ts:61`). Read per request; unset means the endpoint answers 404. Independent of `BILLING_REQUESTS_ENABLED`. | Yes |

## 5. Frontend build

The frontend is a static Vite build; `VITE_*` values are baked in at build time, so changing one needs a rebuild and redeploy. Vite reads the root `.env` for local development (`envDir: '../'` in `front/vite.config.js:35`). There is no separate `front/.env`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `VITE_API_URL` | `/api/v1` (Docker build arg) | Prefix for API calls (`front/src/api/client.js:8`). The production image keeps the relative default so requests go through the nginx `/api/` proxy. `.env.example` sets `http://localhost:4242/api/v1` for local dev. |
| `VITE_ANALYTICS_SRC` | empty | URL of a Plausible-compatible script. Unset: analytics is a complete no-op. When set, the Docker build derives its origin and writes it into the nginx CSP (`front/Dockerfile`). Must be `http` or `https`. |
| `VITE_ANALYTICS_DOMAIN` | empty | Site domain passed to the analytics script. Set it together with `VITE_ANALYTICS_SRC`. |

Pass the Docker ones as build arguments (`ARG` in `front/Dockerfile`), not runtime variables.

## 6. Backup service

Read by `backup/scripts/*` in the `backup` container. Full behavior, restore drills and healthcheck: [BACKUP.md](./BACKUP.md).

| Variable | Default | Purpose | Prod compose |
|----------|---------|---------|--------------|
| `DATABASE_URL` | - | **Required.** Database to dump. | Yes |
| `BACKUP_SCHEDULE` | `0 2 * * *` | Cron schedule. | Yes, same default |
| `BACKUP_RETENTION_DAYS` | `30` | Local retention; `0` keeps forever. | Yes, default `30` |
| `BACKUP_S3_BUCKET` | - | Upload bucket. Falls back to the legacy `AWS_S3_BACKUP_BUCKET`. | Yes |
| `BACKUP_S3_PREFIX` | `backups/` | Key prefix in the bucket. | Yes, default `backups/` |
| `BACKUP_REQUIRE_REMOTE` | - | `yes`, `1` or `true` makes a run fail when no bucket is configured. | Yes |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | - | S3 credentials. | Yes |
| `AWS_DEFAULT_REGION` | `us-east-1` | S3 region. | Yes, default `us-east-1` |
| `AWS_ENDPOINT_URL_S3` | - | S3-compatible endpoint. Falls back to the legacy `AWS_S3_ENDPOINT`. | Yes |
| `BACKUP_HEARTBEAT_MAX_AGE` | `90000` | Healthcheck fails when the last success is older than this many seconds. | Yes, default `90000` |

Not forwarded by the compose file (only for the scripts' own tuning or one-off runs): `BACKUP_DIR`, `BACKUP_HEARTBEAT_PATH`, `BACKUP_LOCK_FILE`, `RESTORE_CONFIRM`, `RESTORE_NONINTERACTIVE` (the last two are passed by `make backup-restore`).

## 7. Local development and tests

| Variable | Where | Purpose |
|----------|-------|---------|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | `.env`, dev `db` service | Credentials of the local Postgres container (defaults `postgres` / `postgres` / `stripe_portal`). |
| `POSTGRES_HOST`, `POSTGRES_PORT` | `docker-compose.dev.yml` | Used to build `DATABASE_URL` for the dev API container when `DATABASE_URL` is not set (defaults `db`, `5432`). |
| `STRIPE_DEVICE_NAME` | `stripe-cli` service | Device name for `stripe listen` (default `dfwsc-dev`). |
| `MAILHOG_ENABLED` | dev stack (set to `true` by `docker-compose.base.yml`) | Listed in `.env.example` (commented); no code or test reads it. |
| `ENV_EXAMPLE_PATH` | `docker-compose.dev.yml` | Path to the mounted `.env.example` for `backend/src/__tests__/env-example.test.ts`. |
| `NODE_OPTIONS` | dev stack | Raises the Node heap and the HTTP header size limit (large localhost cookies otherwise cause 431). |

The backend test run pins its own values in `backend/vitest.config.ts` (`NODE_ENV=test`, dummy Stripe keys, `JWT_SECRET`, `FRONTEND_ORIGIN`, SMTP); only `DATABASE_URL` comes from the environment. See [DEVELOPMENT.md](./DEVELOPMENT.md).

## 8. Prod compose forwarding at a glance

Read by the code but **not** forwarded by `docker-compose.prod.yml`, so unsettable in the Coolify deployment without a compose change: `METRICS_TOKEN`, `TRUST_PROXY`, `CLOUDFLARE_IP_RANGES`, `DEFAULT_PAYMENT_SUCCESS_URL`, `DEFAULT_PAYMENT_CANCEL_URL`, `DB_POOL_MAX`, `HOST`, `ENABLE_SWAGGER`.

Set by the compose file itself regardless of Coolify: `REDIS_URL`.

Variables in a Coolify environment that the stack does not use at all: `USE_CHECKOUT` (removed from code), `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ALLOW_ADMIN_SETUP`, and any `REDIS_URL`.

## 9. Local template

`.env.example` at the repository root is the template for local development (`cp .env.example .env`). A pre-commit warning flags new `process.env.NAME` uses that are not present as `NAME=` lines in it (`.husky/pre-commit` step 10). It documents the optional variables in commented form; this file is the authoritative list.
