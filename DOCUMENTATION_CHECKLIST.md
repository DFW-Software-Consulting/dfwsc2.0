# Documentation Checklist

Use this checklist to confirm each project section is documented and current. Mark items as complete once reviewed.

## Repository Overview
- [x] Project summary, repo layout, and tech stack documented in `README.md`.
- [x] Key API routes and frontend routes documented in `README.md`.
- [x] Contributing guidelines (branching, PR expectations, code style) documented in a top-level guide (suggest `CONTRIBUTING.md`).
- [x] Release/versioning process documented (suggest `RELEASE.md` or `backend/documentation/CHANGELOG.md` updates).

## Local Development
- [x] Local dev prerequisites and setup documented in `README.md`.
- [x] Backend local dev steps documented in `backend/README.md`.
- [x] Frontend local dev steps documented in `front/README.md`.
- [x] Troubleshooting section for common local issues (ports, CORS, DB auth) documented (suggest `README.md`).

## Environment Configuration
- [x] Backend env variables documented in `backend/README.md`.
- [x] Detailed env setup and security notes documented in `backend/documentation/docs/env_setup.md`.
- [x] Frontend env variable documented in `README.md` and `front/README.md`.
- [x] Consolidated env matrix by environment (dev/stage/prod) documented (suggest `backend/documentation/docs/env_setup.md`).

## Docker & Containers
- [x] Docker dev stack documented in `README.md`.
- [x] Docker production deployment documented in `backend/documentation/docs/deployment.md`.
- [x] Container service list (api/web/db/mailhog) documented in `AGENTS.md`.
- [x] Document expected container healthchecks/logging locations for each service (suggest `README.md`).

## Backend API
- [x] API routes overview documented in `README.md` and `backend/README.md`.
- [x] Detailed API reference documented in `backend/documentation/docs/api.md`.
- [x] Route-specific behavior documented in `backend/documentation/src/routes/`.
- [x] Document API error format conventions and pagination style in `backend/documentation/docs/api.md`.

## Authentication & Authorization
- [x] Admin JWT auth documented in `backend/README.md` and `backend/documentation/docs/env_setup.md`.
- [x] API key usage noted in `backend/documentation/docs/api.md`.
- [x] Document token storage and refresh/expiry handling for the frontend UI (suggest `front/README.md`).

## Stripe Integration
- [x] Stripe setup documented in `backend/documentation/docs/stripe_setup.md`.
- [x] Stripe client module documented in `backend/documentation/src/lib/stripe.md`.
- [x] Payments flow documented in `backend/documentation/src/routes/payments.md`.
- [x] Document required Stripe dashboard settings for Connect/Checkout in one place (suggest `backend/documentation/docs/stripe_setup.md`).

## Webhooks
- [x] Webhook endpoint documented in `backend/documentation/src/routes/webhooks.md`.
- [x] Webhook replay/testing documented in `backend/documentation/docs/testing.md`.
- [x] Document webhook event handling policy (idempotency, retries, alerting) (suggest `backend/documentation/src/routes/webhooks.md`).

## Email / SMTP
- [x] SMTP setup documented in `backend/documentation/docs/email_setup.md`.
- [x] Mailer module documented in `backend/documentation/src/lib/mailer.md`.
- [x] Document email templates/content ownership (where to update copy, branding) (suggest `backend/documentation/docs/email_setup.md`).

## Database
- [x] Schema documented in `backend/documentation/db/schema.md`.
- [x] Migrations workflow documented in `backend/documentation/db/migrations.md`.
- [x] Document backup/restore expectations for production data (suggest `backend/documentation/docs/deployment.md`).

## Frontend
- [x] Frontend dev and admin dashboard flow documented in `front/README.md`.
- [x] Frontend architecture overview (routing, key pages, data fetching, API client) documented (suggest `front/README.md`).
- [x] UI build/deploy workflow documented (nginx config, Vite build outputs) (suggest `front/README.md`).

## Testing
- [x] Backend tests documented in `backend/README.md` and `backend/documentation/docs/testing.md`.
- [x] Frontend tests documented in `front/README.md`.
- [x] End-to-end test strategy and required test data documented (suggest `backend/documentation/docs/testing.md`).

## Security
- [x] JWT storage risks documented in `backend/documentation/docs/security.md`.
- [x] Document CSP/headers, rate limiting, and secret handling in a consolidated security guide (suggest `backend/documentation/docs/security.md`).

## Operations & Monitoring
- [x] Logging/monitoring expectations (what to alert on, where logs live) documented (suggest `backend/documentation/docs/deployment.md`).
- [x] Incident response and rollback steps documented (suggest `backend/documentation/docs/deployment.md`).

## Documentation Maintenance
- [x] Documentation index and structure documented in `backend/documentation/README.md`.
- [x] Documentation changelog tracked in `backend/documentation/CHANGELOG.md`.
- [x] Define doc ownership and update cadence (suggest `backend/documentation/README.md`).
