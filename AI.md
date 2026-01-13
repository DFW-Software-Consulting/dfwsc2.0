## DFWSC Stripe Payment Portal – AI Notes

### Purpose and Direction

This repository is the DFW Software Consulting payment portal. It exists to:

- onboard clients into Stripe Connect (Express)
- create and track payments on behalf of clients
- let admins manage client status (active/inactive)
- handle Stripe webhooks for onboarding and payment events
- serve the public marketing/landing site for the business

Moving forward, the app should keep the Stripe flow reliable, secure, and easy to operate. Any work should preserve the onboarding and payment funnels first, then improve admin visibility and reporting.

### Architecture

- Backend: Node.js + TypeScript with Fastify (in `backend/`)
- Database: PostgreSQL 14+ (Drizzle ORM)
- Frontend: React + Vite (in `front/`)
- Containerization: Docker / Docker Compose

### User-Facing Experience

- Landing site: Home, Pricing, Team
- Client onboarding page: token-based Stripe onboarding
- Payment success page

### Admin Capabilities

- Admin login with JWT
- Create clients and onboarding tokens
- Email onboarding links
- Enable/disable clients
- View Stripe payment intents for a client

### Key Services and Ports

- api: Fastify server (port 4242)
- web: React site (port 8080)
- db: Postgres (port 5432)
- mailhog: Mail testing (port 8025)

### Entry Points

- Backend server: `backend/src/server.ts`
- Fastify app: `backend/src/app.ts`
- Frontend router: `front/src/App.jsx`

### Important Endpoints

- `GET /api/v1/health` – health check
- `POST /api/v1/auth/login` – admin authentication
- `PATCH /api/v1/clients/:id` – update client status (admin only)
- `POST /api/v1/payments/create` – create payment
- `GET /api/v1/reports/payments` – list Stripe payment intents (admin only)
- `POST /api/v1/accounts` – create client and onboarding token (admin only)
- `POST /api/v1/onboard-client/initiate` – create client + email onboarding link (admin only)
- `GET /api/v1/onboard-client` – exchange token for Stripe onboarding link
- `POST /api/v1/webhooks/stripe` – Stripe webhooks

### Environment Notes

- Env files live in `.env` files at the repo root and `backend/`.
- Backend validates required vars in `backend/src/lib/env.ts`.
- Stripe keys and webhook secrets are required for API startup.

### Development Workflow

- Run via Docker Compose at the repo root.
- Rebuild: `docker-compose up -d --build`
- Logs: `docker-compose logs -f api`
- Shell into API container: `docker exec -it dfwsc20-api-1 /bin/sh`

### Database and Migrations

- Drizzle schema: `backend/src/db/schema.ts`
- DB connection: `backend/src/db/client.ts`
- Migrations run on startup in non-production (see `backend/src/server.ts`).

### Frontend Pages

- Landing site: `front/src/pages/Home.jsx`
- Pricing: `front/src/pages/Pricing.jsx`
- Team: `front/src/pages/Team.jsx`
- Client onboarding: `front/src/pages/OnboardClient.jsx`
- Payment success: `front/src/pages/PaymentSuccess.jsx`

### Testing

- Backend tests live in `backend/src/__tests__` and `backend/src/routes/*.test.ts`.
- Run tests in the Docker environment when possible.

### Guardrails for Changes

- Preserve the onboarding and payment flows; treat them as critical paths.
- Keep backend changes in `backend/`, frontend changes in `front/`.
- Avoid introducing new dependencies unless necessary.
- Prefer small, focused diffs.
- If auth or Stripe flow behavior is unclear, ask before changing.
