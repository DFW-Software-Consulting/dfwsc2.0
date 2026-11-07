# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
Payment portal for DFW Software Consulting clients integrating Stripe Connect.

## Core Documentation
- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) — System Overview and Entry Point.
- [BACKEND.md](./docs/BACKEND.md) — API, Logic, and Auth.
- [FRONTEND.md](./docs/FRONTEND.md) — React, State, and Routing.
- [DATABASE.md](./docs/DATABASE.md) — Schema and Migrations.
- [STRIPE.md](./docs/STRIPE.md) — Connect, Webhooks, and Payments.
- [STYLES.md](./docs/STYLES.md) — Styling and UI Patterns.
- [ENVIRONMENT.md](./docs/ENVIRONMENT.md) — Every env var and feature flag.
- [DEVELOPMENT.md](./docs/DEVELOPMENT.md) — Git hooks, CI, and the CLAUDE.md mirrors.
- [README.md](./README.md) — Quickstart and Setup (also indexes the remaining docs).

## Commands

### Dev stack (Docker — preferred for all backend work)
```sh
make up           # Start dev stack (api, web, db, redis, mailhog, stripe-cli, loki, promtail)
make up-build     # Build + start
make down         # Stop
make down-v       # Stop + remove volumes (destroys pgdata)
make logs         # Tail API logs
make sh           # Shell into API container
make test         # Run ALL tests (frontend local + backend in container)
make test-back    # Run backend tests inside the dev container
make test-up      # Start stack then run all tests (backend in container + frontend local)
make coverage     # Backend tests with coverage; thresholds 87 statements / 79 branches / 82 functions / 87 lines
```

### Running tests
```sh
# Backend (must be inside container or with DATABASE_URL set):
make test-back
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

## Architectural Overview (High-Level)
For full details, see [ARCHITECTURE.md](./docs/ARCHITECTURE.md).

### Request auth
- **Client routes**: `X-Api-Key` header (Lookup: SHA256; Verification: bcrypt).
- **Admin routes**: JWT Bearer token obtained from `POST /api/v1/auth/login`.

### Payment flow
All payments use Stripe Checkout redirects (`POST /payments/create` requires `lineItems` and returns a hosted `url`), with `application_fee_amount` support. `Idempotency-Key` is required (400 without it), the response is `{ url, sessionId }`, an admin JWT must also send `workspace` and `clientId`, and a client without an active connected account or active `card_payments` capability gets 409 (`ACCOUNT_NOT_CONNECTED` / `CARD_PAYMENTS_NOT_ACTIVE`). The former Stripe Elements / PaymentIntent mode and its `USE_CHECKOUT` toggle have been removed.

### Environment variables
Required: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `FRONTEND_ORIGIN`, `DATABASE_URL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `JWT_SECRET`. `API_BASE_URL` is also required in production (an unset value makes `/app-config.js` and the Connect callback links answer 500). The full list, defaults, and feature flags are in [ENVIRONMENT.md](./docs/ENVIRONMENT.md).

### Mirror files
`AGENTS.md`, `Gemini.md`, `Qwen.md` and `.claude/CLAUDE.md` must stay byte-identical to `CLAUDE.md`. Edit `CLAUDE.md` only, then run:
```sh
cp CLAUDE.md AGENTS.md && cp CLAUDE.md Gemini.md && cp CLAUDE.md Qwen.md && cp CLAUDE.md .claude/CLAUDE.md
```
Details of the hook and CI checks are in [DEVELOPMENT.md](./docs/DEVELOPMENT.md).

