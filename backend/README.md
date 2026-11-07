# DFWSC Backend

Fastify + TypeScript API for the DFW Software Consulting payment portal: Stripe Connect onboarding and Checkout payments, client API keys, admin login through Nextcloud, and optional Nextcloud/Stripe background jobs. Entry points are `src/index.ts` (process start, migrations in non-production, background jobs) and `src/app.ts` (server and route registration).

## Requirements

- Node.js >=22.12
- PostgreSQL 17
- A Stripe account with Connect enabled
- Redis (optional): when `REDIS_URL` is set, rate limits are shared across replicas; otherwise they are per-process

## Where things are documented

| Topic | Document |
|-------|----------|
| Environment variables and feature flags | [docs/ENVIRONMENT.md](../docs/ENVIRONMENT.md) |
| Routes, auth, rate limits, background jobs | [docs/BACKEND.md](../docs/BACKEND.md) (route map in section 7) |
| Schema, migrations, boot-time schema check | [docs/DATABASE.md](../docs/DATABASE.md) |
| Stripe Connect flows, fees, webhook behavior | [docs/STRIPE.md](../docs/STRIPE.md) |
| Integrator guide for payments and invoicing | [CLIENT_INTEGRATION.md](../CLIENT_INTEGRATION.md) |
| Production deployment | [docs/COOLIFY_DEPLOYMENT.md](../docs/COOLIFY_DEPLOYMENT.md) |
| Hooks, CI, tests | [docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md) |

`API_BASE_URL` is required in production: without it, `/app-config.js` and the Connect callback and refresh links answer 500.

## Source layout

| Path | Contents |
|------|----------|
| `src/routes/` | HTTP routes, registered under `/api/v1` in `src/app.ts` |
| `src/lib/` | Stripe, mailer, auth, rate limiting, circuit breakers, Nextcloud and sync jobs |
| `src/db/` | Drizzle schema and client |
| `src/cerebo/` | Optional workspace API, served only when `CEREBO_ENABLED=true` |
| `src/scripts/` | One-off scripts (for example `backfill-billing-customers.ts`) |
| `scripts/` | `reset-test-data.ts` (also `npm run reset:test-data`) |
| `drizzle/` | Generated SQL migrations; commit them with schema changes |

## Running locally

The recommended path is the Docker dev stack from the repository root (`make up-build`; see the root [README.md](../README.md)). To run the API directly:

```bash
cp ../.env.example ../.env      # the API reads the repo-root .env outside production
npm install
npm run dev                     # http://localhost:4242
```

`.env.example` sets `DATABASE_URL` to the Compose host `db`; point it at your own PostgreSQL when running outside Compose. Outside production the API applies pending migrations at start. In production the `migrator` service in `docker-compose.prod.yml` runs `npm run db:migrate` before `api` starts.

### Database commands

```bash
npm run db:generate   # generate a migration from schema changes
npm run db:migrate    # apply migrations
npm run db:studio     # Drizzle Studio
npm run db:push       # push schema without migrations (dev only)
```

`drizzle.config.ts` does not read `.env`: export `DATABASE_URL` in your shell before running these. It covers both `src/db/schema.ts` and `src/cerebo/schema.ts`.

### Tests and lint

```bash
npm test                  # Vitest; requires DATABASE_URL
npm run test:coverage     # enforces coverage thresholds
npm run lint              # Biome
```

Backend tests need a reachable PostgreSQL. From the repository root, `make test-back` runs them in the dev container and `make coverage` runs them with coverage.

To replay Stripe events locally, use the Stripe CLI (`npm run stripe:listen`, or `stripe trigger payment_intent.succeeded`).

## Admin login

Admin login is checked against Nextcloud; there are no local admin accounts. `POST /api/v1/auth/login` verifies the Nextcloud username and password and requires membership of a group in `ADMIN_NEXTCLOUD_GROUPS` (default `dfwsc-admins,managers`).

- Create the groups and add members **before** deploying.
- Accounts with two-factor login must use a Nextcloud app password.
- There is no local fallback: if Nextcloud is down, login answers `503` (payments are unaffected).
- Logins are limited per IP (5 / 15 min) and per username (10 / 15 min), because Nextcloud throttles failed logins by source IP.
- Details: [docs/BACKEND.md](../docs/BACKEND.md), "Admin login (Nextcloud)".
