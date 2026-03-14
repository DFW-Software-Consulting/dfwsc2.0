# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
Payment portal for DFW Software Consulting clients integrating Stripe Connect. Clients onboard via Stripe Express accounts and process payments through the platform.

## Monorepo Structure
- `backend/` — Fastify/TypeScript API server
- `front/` — React frontend
- Root `package.json` delegates to workspace subdirectories

## Commands

### Dev stack (Docker — preferred for all backend work)
```sh
make up           # Start dev stack (api, web, db, mailhog, stripe-cli)
make up-build     # Build + start
make down         # Stop
make down-v       # Stop + remove volumes (destroys pgdata)
make logs         # Tail API logs
make sh           # Shell into API container
make test         # Run backend tests inside running container
make test-up      # Start stack then run backend tests
```

### Running tests
```sh
# Backend (must be inside container or with DATABASE_URL set):
make test
# Single test file:
docker compose -f docker-compose.base.yml -f docker-compose.dev.yml exec api npx vitest run src/__tests__/app.test.ts

# Frontend:
cd front && npm test        # or npx vitest
```

### Database migrations
```sh
npm run db:generate   # Generate migration from schema changes
npm run db:migrate    # Apply migrations
```

### Swagger UI
Available at `http://localhost:4242/docs` in dev. Disabled when `ENABLE_SWAGGER=false` or `NODE_ENV=production`.

## Architecture

### Request auth — two separate schemes
- **Client routes** (`POST /payments/create`): `X-Api-Key` header. Auth uses a two-field strategy — `apiKeyLookup` (SHA256 hash for O(1) DB lookup) + `apiKeyHash` (bcrypt for verification). A legacy fallback iterates all clients with null `apiKeyLookup` for backward compatibility.
- **Admin routes**: JWT Bearer token obtained from `POST /api/v1/auth/login`. Token must carry `role: "admin"` claim.

### Payment flow — USE_CHECKOUT toggle
`USE_CHECKOUT` env var switches between two Stripe payment modes:
- `false` (default): Creates a **PaymentIntent** via Stripe Connect. Returns `clientSecret` for frontend Elements.
- `true`: Creates a **Checkout Session**. Returns a `url` for redirect. Requires `lineItems` in request body.

Both modes use `application_fee_amount` from `DEFAULT_PROCESS_FEE_CENTS` and require an `Idempotency-Key` header.

### Onboarding flow
1. Admin calls `POST /api/v1/accounts` or `POST /api/v1/onboard-client/initiate` → creates client record + `onboardingTokens` row (status: `pending`) + returns API key (only time it's shown plaintext).
2. Client visits frontend `/onboard?token=...` → frontend calls `GET /api/v1/onboard-client?token=...` → creates Stripe Express account + account link, transitions token to `in_progress`, stores CSRF `state` with 30-min expiry.
3. Stripe redirects to `GET /api/v1/connect/callback?client_id=...&state=...&account=...` → validates state, links `stripeAccountId` to client, marks token `completed` in a DB transaction.
4. `GET /api/v1/connect/refresh?token=...` regenerates an account link for incomplete onboarding sessions.

### Rate limiting
In-memory sliding-window rate limiter (`lib/rate-limit.ts`). Not Redis-backed — not suitable for multi-instance deployments. Admin/onboard routes: 10 req/min per IP. Payment routes: 20 req/min per Stripe account ID (falls back to IP).

### Database schema (Drizzle ORM, PostgreSQL 17)
Three tables:
- `clients` — `id`, `name`, `email`, `apiKeyHash`, `apiKeyLookup`, `stripeAccountId`, `status` (active/inactive)
- `onboarding_tokens` — `clientId` (FK→clients), `token`, `status`, `state`, `stateExpiresAt`
- `webhook_events` — idempotency table for Stripe webhook deduplication

### Environment variables
Required: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `FRONTEND_ORIGIN`, `USE_CHECKOUT`, `DATABASE_URL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`.

Optional: `API_BASE_URL`, `DEFAULT_PROCESS_FEE_CENTS`, `SMTP_FROM`, `ENABLE_SWAGGER`, `JWT_EXPIRY` (default `1h`).

Bootstrap mode (skip admin creds on first run): set `ALLOW_ADMIN_SETUP=true` + `ADMIN_SETUP_TOKEN`.

### Full API route map
All routes prefixed `/api/v1` except `/docs`.

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/v1/health` | none |
| POST | `/api/v1/auth/login` | none |
| POST | `/api/v1/accounts` | admin JWT + rate limit |
| POST | `/api/v1/onboard-client/initiate` | admin JWT + rate limit |
| GET | `/api/v1/onboard-client` | rate limit |
| GET | `/api/v1/connect/refresh` | rate limit |
| GET | `/api/v1/connect/callback` | none (state CSRF) |
| POST | `/api/v1/payments/create` | API key + rate limit |
| GET | `/api/v1/reports/payments` | admin JWT |
| GET | `/api/v1/clients` | admin JWT |
| PATCH | `/api/v1/clients/:id` | admin JWT |
| POST | `/api/v1/webhooks/stripe` | Stripe signature |

## Docker Environment
- `api`: port 4242
- `web`: port 8080
- `db`: PostgreSQL, port 5432 (localhost only in prod)
- `mailhog`: SMTP testing, UI port 8025
- `stripe-cli`: webhook forwarding in dev
