# DFW Software Consulting - Payment Portal

Monorepo with a React frontend (marketing site, onboarding and admin pages) and a Fastify API for Stripe Connect payments and client onboarding.

## Project Structure

```
dfwsc2.0/
├── front/                    # React + Vite frontend
│   ├── src/                  # pages, components, api, hooks, seo, styles
│   ├── scripts/              # prerender and build verification
│   ├── vite.config.js
│   ├── Dockerfile            # Builds with Vite, serves with nginx
│   └── nginx.conf            # Clean URLs, /api proxy, security headers
│
├── backend/                  # Fastify API
│   ├── src/
│   │   ├── routes/           # HTTP routes (/api/v1/*)
│   │   ├── lib/              # Stripe, mailer, auth, Nextcloud jobs, rate limiting
│   │   ├── db/               # Drizzle schema and client
│   │   ├── cerebo/           # Optional workspace API (CEREBO_ENABLED)
│   │   └── scripts/          # One-off operational scripts
│   ├── drizzle/              # SQL migrations
│   └── Dockerfile
│
├── backup/                   # Scheduled Postgres backup image (prod stack)
├── observability/            # Promtail config (dev stack logging)
├── fallow-baselines/         # Dead-code gate baselines used by CI
├── scripts/                  # Repo-level scripts (legacy backup-db.sh, manual/)
├── docs/                     # Reference documentation (see below)
├── plans/ reviews/ reports/  # Planning and review notes
│
├── docker-compose.base.yml   # Services shared by dev and prod
├── docker-compose.dev.yml    # Dev override (use together with base)
├── docker-compose.prod.yml   # Standalone prod stack
├── Makefile                  # Primary task runner
└── package.json              # Root scripts
```

## Tech Stack

| Layer | Stack |
|-------|-------|
| Frontend | React 18, Vite 8, React Router 7, TanStack Query v5, TailwindCSS v4, three.js (Home and Team only) |
| Backend | Node.js >=22.12, Fastify 5, TypeScript, Drizzle ORM |
| Data | PostgreSQL 17; Redis (optional, used when `REDIS_URL` is set) |
| Integrations | Stripe Connect, Nodemailer (SMTP), Nextcloud (admin login and optional automations) |
| Tooling | Biome, Vitest 5, Husky, Docker Compose |

## Development

### Prerequisites
- Node.js >=22.12.0
- Docker with Compose (preferred) or a local PostgreSQL 17

### Docker dev stack (preferred)

```bash
cp .env.example .env     # fill in Stripe keys and SMTP settings
make up-build            # or: make up
```

`make` runs `docker compose -f docker-compose.base.yml -f docker-compose.dev.yml`. Use that pair of files if you call Compose directly; `docker-compose.dev.yml` alone is only an override.

| Service | URL |
|---------|-----|
| Web UI (Vite) | http://localhost:5173 |
| API | http://localhost:4242 |
| Mailhog | http://localhost:8025 |
| Loki (Promtail ships container logs to it) | http://localhost:3100 |

The stack also runs PostgreSQL, Redis and the Stripe CLI, which forwards webhooks to `/api/v1/webhooks/stripe`. The dev API container applies migrations on start.

Common targets: `make down`, `make down-v` (also deletes the database volume), `make logs`, `make sh`. Run `make help` for the full list, including the prod and `backup-*` targets.

### Without Docker

1. `npm run install:all`
2. `cp .env.example .env`. The API loads this root `.env` outside production, and the frontend reads it too (Vite `envDir` is the repo root). `.env.example` points `DATABASE_URL` at the host `db`; change it to your own host (for example `localhost`) when PostgreSQL runs outside Compose.
3. `npm run dev:backend` (port 4242) and `npm run dev:frontend` (port 5173). Outside production the API applies pending migrations at start.
4. To run Drizzle commands directly (`npm run db:generate`, `npm run db:migrate`), export `DATABASE_URL` in your shell first: `backend/drizzle.config.ts` does not read `.env`.

For the frontend, `VITE_API_URL` defaults to `/api/v1` in the Docker build. For a dev server without the Compose proxy, set `VITE_API_URL=http://localhost:4242/api/v1` in `.env`. `VITE_ANALYTICS_SRC` and `VITE_ANALYTICS_DOMAIN` are optional.

### Building

```bash
npm run build     # frontend (output front/build-dist), then backend (TypeScript)
npm start         # start the compiled API
```

### Testing

| Command | What it does |
|---------|--------------|
| `make test-up` | Starts the dev stack, then runs backend tests in the container and frontend tests locally |
| `make test-back` | Backend tests in the running dev container |
| `make test-front` or `cd front && npm test` | Frontend tests |
| `make coverage` | Backend tests with coverage thresholds |
| `npm run test` | Root script. Exits unless `DATABASE_URL` is set, then runs backend tests followed by frontend tests |

Lint and format: `npm run lint`, `npm run lint:fix`, `npm run format` (Biome). Hooks, CI jobs and the CLAUDE.md mirror rule are in [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

## Production

The prod stack (`make prod`, `docker-compose.prod.yml`) runs four services: `migrator` (applies migrations, then exits), `api`, `dfwsc-redis`, and `backup` (scheduled Postgres dumps). There is no bundled web container: the frontend is a separate nginx image built from `front/Dockerfile`. The `api` service joins the external `coolify` network under the alias `dfwsc-api`, which is where the frontend's nginx proxies `/api/`. Topology and deploy steps are in [docs/COOLIFY_DEPLOYMENT.md](./docs/COOLIFY_DEPLOYMENT.md).

- Health: `GET /api/v1/health` returns 200, or 503 when the database is unreachable.
- Logs: `make logs-prod` for the API (`make logs` in dev).

## API

All routes are under `/api/v1`, except `GET /app-config.js` (served at the root). The complete route map, with auth, rate limits and feature-flag gating for each route, is in [docs/BACKEND.md section 7](./docs/BACKEND.md#7-api-route-map). Auth is either an `X-Api-Key` header (client routes) or an admin JWT from `POST /api/v1/auth/login`.

Main entry points:

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| POST | `/api/v1/auth/login` | Admin login against Nextcloud; returns a JWT | Public |
| POST | `/api/v1/onboard-client/initiate` | Create a client and email its onboarding link | Admin |
| POST | `/api/v1/onboard-client` | Exchange `{ token }` for a Stripe onboarding `{ url }` | Public (10/min per IP) |
| POST | `/api/v1/payments/create` | Create a Stripe Checkout payment; returns `{ url, sessionId }`. Requires an `Idempotency-Key` header and `lineItems`; an admin JWT must also send `workspace` and `clientId`. Answers 409 when the client's connected account is missing or lacks active `card_payments` | API key or Admin |
| GET | `/api/v1/payments/session/:sessionId` | Payment status by Checkout session id | Public (30/min per IP) or API key |
| POST | `/api/v1/webhooks/stripe` | Stripe webhooks | Stripe signature |
| GET | `/api/v1/health` | Health check (database connectivity) | Public |

Routes behind feature flags: `/customers` and `/invoices` need `CONNECT_INVOICING=true`; `/cerebo/*` needs `CEREBO_ENABLED=true`. Integrators should start with [CLIENT_INTEGRATION.md](./CLIENT_INTEGRATION.md).

### Admin authentication

Admin login is checked against Nextcloud. `POST /api/v1/auth/login` takes a Nextcloud username and password, verifies them with the Nextcloud OCS API, and issues a JWT when the account belongs to one of the groups in `ADMIN_NEXTCLOUD_GROUPS` (default `dfwsc-admins,managers`). There are no local admin accounts. Before deploying: create those groups and add members, and set `NEXTCLOUD_BASE_URL`, `NEXTCLOUD_USERNAME` and `NEXTCLOUD_APP_PASSWORD` (the service account must be a Nextcloud admin). Accounts with two-factor login must sign in with a Nextcloud app password. There is no local fallback: if Nextcloud is down, admin login answers 503 (payments are unaffected). Logins are rate limited per IP and per username because Nextcloud throttles failures by source IP. See [docs/BACKEND.md](./docs/BACKEND.md) (Admin login) and [docs/COOLIFY_DEPLOYMENT.md](./docs/COOLIFY_DEPLOYMENT.md).

## Environment Variables

Copy `.env.example` to `.env`. Minimum for a working API:

```env
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
FRONTEND_ORIGIN=http://localhost:5173
API_BASE_URL=http://localhost:4242      # required in production
DATABASE_URL=postgresql://user:pass@localhost:5432/stripe_portal
SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
JWT_SECRET=<at least 32 characters>
```

Every variable, its default, the feature flags (Nextcloud automations, mirrors, invoicing, Cerebo) and which ones the prod compose file forwards are listed in [docs/ENVIRONMENT.md](./docs/ENVIRONMENT.md).

## Frontend Routes

Routes are defined in `front/src/routes.js`. `/`, `/pricing`, `/team` and `/privacy` are prerendered at build time and indexable. The rest are client-rendered from `spa.html` and served with `noindex`.

| Route | Page |
|-------|------|
| `/`, `/pricing`, `/team`, `/privacy` | Marketing pages (prerendered) |
| `/demos` | Unlisted sample-sites page |
| `/onboard#token=<token>` | Client Stripe onboarding |
| `/admin` | Admin dashboard (Nextcloud login) |
| `/payment-success`, `/payment-cancel` | Checkout return pages |
| `/onboarding-success` | Return page after Stripe onboarding |
| `/regenerate-key`, `/request-key-regeneration` | API key regeneration |
| any other path | 404 page |

`/docs` is not a React route: nginx redirects it (301) to the developer guide on Nextcloud. See [docs/FRONTEND.md section 3](./docs/FRONTEND.md#3-routes-routesjs-rendered-by-appjsx).

## Documentation

| File | What it covers |
|------|----------------|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | System overview, flows, tech stack |
| [docs/BACKEND.md](./docs/BACKEND.md) | Auth, rate limiting, route map, Nextcloud integrations, background jobs |
| [docs/FRONTEND.md](./docs/FRONTEND.md) | React, state, routing, prerendering |
| [docs/DATABASE.md](./docs/DATABASE.md) | Schema, Drizzle, migrations |
| [docs/STRIPE.md](./docs/STRIPE.md) | Stripe Connect, webhooks, payment flows |
| [docs/STYLES.md](./docs/STYLES.md) | Tailwind v4, theme, UI patterns |
| [docs/ENVIRONMENT.md](./docs/ENVIRONMENT.md) | Env vars and feature flags |
| [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) | Git hooks, CI, CLAUDE.md mirrors |
| [docs/BACKUP.md](./docs/BACKUP.md) | Database backups and restore |
| [docs/COOLIFY_DEPLOYMENT.md](./docs/COOLIFY_DEPLOYMENT.md) | Production deployment on Coolify |
| [API_DOCS.md](./API_DOCS.md) | API reference for integrators |
| [CLIENT_INTEGRATION.md](./CLIENT_INTEGRATION.md) | Integrator guide: payments and invoicing |

## Troubleshooting

- **CORS errors**: `FRONTEND_ORIGIN` must match the UI origin (local vs Docker).
- **Database connection failures**: check `DATABASE_URL` and container health (`make ps`, then `make logs`; the `db` service logs via `docker compose -f docker-compose.base.yml -f docker-compose.dev.yml logs -f db`).
- **Stripe webhook signature errors**: `STRIPE_WEBHOOK_SECRET` must match the Stripe CLI or dashboard endpoint.
- **`/app-config.js` or onboarding links return 500 in production**: set `API_BASE_URL`.

## License

ISC

## Author

DFW Software Consulting - Jeremy Ashley
