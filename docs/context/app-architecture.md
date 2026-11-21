# App architecture and layout

Payment portal and marketing site in one repo. Fastify API in `backend/`, React/Vite site in `front/`. Full detail: [docs/ARCHITECTURE.md](../ARCHITECTURE.md), [docs/BACKEND.md](../BACKEND.md), [docs/FRONTEND.md](../FRONTEND.md). This file is the map; read it first.

## Layout
- `backend/src/index.ts`: process entry. Loads the root `.env` (non-production only) before importing anything else, runs migrations only when `NODE_ENV` is not `production`, calls `verifyDatabaseSchema()`, starts the background workers, then listens.
- `backend/src/app.ts`: `buildServer()`. Registers CORS, Helmet, raw-body, optional Swagger, then every route module under `/api/v1`. Connected-account invoicing routes register only when `CONNECT_INVOICING` is exactly `true`; Cerebo routes only when `CEREBO_ENABLED` is `true`.
- `backend/src/routes/`: one file per area (`payments`, `connect`, `connect-client`, `clients`, `groups`, `products`, `settings`, `contact`, `auth`, webhooks, `health`, `metrics`; `connect-invoicing/` is split into modules).
- `backend/src/lib/`: business logic and integration helpers. Routes stay thin; look here for behavior.
- `backend/src/db/`: Drizzle client and `schema.ts`. `backend/src/cerebo/` is a separate module with its own schema, routes and `services/`.
- `front/src/`: `pages/`, `components/` (`admin/`, `motion/`), `api/` (fetch wrappers), `hooks/` (TanStack Query), `contexts/`, `content/` (data the pages render), `seo/`. Routes are listed in `front/src/routes.js`.
- `front/scripts/`: build-time prerender and build verification (`prerender.mjs`, `verify-build.mjs`).
- `backup/`: database backup image used by the production compose stack.
- `observability/`: log aggregation config for the dev stack.

## Two auth modes
- Client routes: `X-Api-Key` header (lookup by SHA-256, verified with bcrypt).
- Admin routes: JWT bearer from `POST /api/v1/auth/login`; the admin UI signs in through the self-hosted Nextcloud identity.

## Background workers
`index.ts` starts several pollers/reconcilers (sales lead, client onboarding, billing requests, contact Stripe sync, portal mirror, billing mirror, Stripe-id write-back) plus a periodic prune of processed `webhook_events`. Most are feature-flagged off by default; each has its own file in `backend/src/lib/*-sync.ts`. Work is also kicked from the writes that need it. Rollout steps per flag are in [docs/BACKEND.md](../BACKEND.md).

## Things that surprise
- The marketing site and the portal ship as one frontend; marketing pages are prerendered at build time, `/docs` is a redirect to an external guide, not a page.
- Redis is optional; without `REDIS_URL` rate limiting is in-memory.
- Nextcloud and Stripe are faked in tests (`backend/src/__tests__/helpers/`); nothing in the test suite needs real access.
