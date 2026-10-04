# Stripe Payment Portal (MVP)

Minimal Stripe Connect API for onboarding Express accounts, creating payments with platform fees, and recording webhook activity. This branch removes all custom invoice/refund handling, local ledgers, and non-essential routes so the service focuses on the Stripe source of truth.

## Requirements

- Node.js v18+
- PostgreSQL 17
- Stripe account with Connect enabled

## Environment Variables

Create a `.env` file based on `.env.example`.

| Variable | Required | Description |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | ✅ | Stripe API key used for all server-side requests. |
| `STRIPE_WEBHOOK_SECRET` | ✅ | Signing secret for `/webhooks/stripe`. |
| `FRONTEND_ORIGIN` | ✅ | Origin allowed by CORS and used for Checkout redirects. |
| `DEFAULT_PROCESS_FEE_CENTS` | ❌ | Platform fee applied when the request omits `applicationFeeAmount`. Must be a non-negative integer. |
| `DATABASE_URL` | ✅ | PostgreSQL connection string used by Drizzle. |
| `PORT` | ❌ | Server port (defaults to `4242`). |
| `API_BASE_URL` | ❌ | Public URL for the API. When unset, the service infers it from the request host. |
| `SMTP_HOST` | ✅ | SMTP server used to email onboarding tokens. |
| `SMTP_PORT` | ✅ | Port for the SMTP server (`587` for STARTTLS, `465` for SMTPS). |
| `SMTP_USER` | ✅ | Username/login for the SMTP server. |
| `SMTP_PASS` | ✅ | Password/API key for the SMTP server. |
| `SMTP_FROM` | ❌ | Friendly from address used in onboarding emails. Defaults to `SMTP_USER` when omitted. |
| `ADMIN_USERNAME` | ❌ | Username for the first admin, created at startup only when the `admins` table is empty. Remove it from the environment once the admin is confirmed. |
| `ADMIN_PASSWORD` | ❌ | Plaintext password for the first admin (at least 12 characters in production). The server hashes it with bcrypt when it creates the admin, so do not supply a pre-computed hash: the hash string itself would become the password. Once any admin exists it is ignored, and the server logs a startup warning while it is still set. Remove it from the environment once the admin is confirmed. |
| `JWT_SECRET` | ✅ | Secret key for signing JWT tokens. Must be minimum 32 characters. Generate with: `openssl rand -base64 32` |
| `JWT_EXPIRY` | ❌ | JWT token expiration time. Defaults to `1h`. Supported formats: `1h`, `30m`, `7d`, `24h`. |
| `ALLOW_ADMIN_SETUP` | ❌ | When `true`, an admin created from `ADMIN_USERNAME`/`ADMIN_PASSWORD` at startup is left unconfirmed: log in, then choose permanent credentials with `POST /api/v1/auth/confirm-bootstrap`. When not `true`, that admin is created already confirmed. It does not enable `POST /api/v1/auth/setup`, which always returns `410 Gone`. |

## Database Schema

| Table | Columns |
| --- | --- |
| `clients` | `id`, `name`, `email`, `stripe_account_id`, `created_at`, `updated_at` |
| `webhook_events` | `id`, `stripe_event_id`, `type`, `payload`, `processed_at`, `created_at` |
| `onboarding_tokens` | `id`, `client_id`, `token`, `status`, `email`, `created_at`, `updated_at` |

The database only stores the connected account mapping and raw webhook payloads. All payment state lives in Stripe.

## Routes

| Method & Path | Purpose | Role |
| --- | --- | --- |
| `GET /api/v1/health` | Health check. | Public |
| `POST /api/v1/auth/login` | Admin login endpoint. Returns JWT token for authentication. Rate limited to 5 requests per 15 minutes. | Public |
| `GET /api/v1/auth/setup/status` | Bootstrap status. Returns `{ adminConfigured, requiresSetup }`. | Public |
| `POST /api/v1/auth/setup` | Deprecated. Always returns `410 Gone`. | Public |
| `POST /api/v1/auth/confirm-bootstrap` | Replace the bootstrap admin's username and password with permanent credentials. | Admin (JWT) |
| `GET /api/v1/clients` | List all clients with their status and Stripe account information. | Admin (JWT) |
| `PATCH /api/v1/clients/:id` | Update client status (`active` or `inactive`). Soft-deletes clients without removing from database. | Admin (JWT) |
| `POST /api/v1/accounts` | Create a client record and onboarding token. | Admin |
| `POST /api/v1/onboard-client/initiate` | Email onboarding link to a client. | Admin |
| `GET /api/v1/onboard-client` | Exchange onboarding token for a Stripe onboarding link. | Public |
| `GET /api/v1/connect/callback` | Stripe onboarding return URL. Persists the `account` query parameter to the client record and redirects to the frontend success page. | Public |
| `POST /api/v1/payments/create` | Create a Checkout Session for a client's connected account. Requires an `Idempotency-Key` header and a `lineItems` array; returns `{ url, sessionId }`. | Admin or Client |
| `GET /api/v1/payments/session/:sessionId` | Confirm a payment by Checkout session ID (status and amounts). Rate limited: 30 requests per minute per IP, or 600 per minute per client when `X-Api-Key` is sent; 30 distinct rejected keys per minute per IP (the same bad key counts once). | Public, or API key |
| `POST /api/v1/webhooks/stripe` | Verify the Stripe signature, store the raw event payload, mark the event as processed, and log basic status updates. | Stripe |
| `GET /api/v1/reports/payments` | List PaymentIntents for a client's connected account with Stripe pagination parameters. | Admin |

Non-listed endpoints from earlier versions have been removed (invoices, refunds, ledgers, customer CRUD, etc.).

## Payments and Fees

- The caller supplies the desired `application_fee_amount` for each payment request.
- The API always creates a Checkout Session from the required `lineItems`, applies platform fees via `payment_intent_data.application_fee_amount`, and returns the hosted session URL and session ID.
- Idempotency is enforced via the standard `Idempotency-Key` request header on write routes. On `POST /api/v1/payments/create` keys are scoped per client and at most 218 characters, a key reused for a different payment returns `409 IDEMPOTENCY_KEY_REUSED`, and a key should not be reused more than 24 hours after its first use (Stripe stops honouring it). See `CLIENT_INTEGRATION.md` for the full error list.

Refunds are **not** exposed through this API. Handle all refunds directly in the Stripe Dashboard so Stripe remains the source of truth.

## Webhooks

`POST /webhooks/stripe` handles the following event types:

- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `charge.refunded`
- `payout.paid`
- `payout.failed`

Each event is saved in `webhook_events` (raw JSON) and marked processed after minimal logging.

## Running Locally

```bash
npm install
npm run dev
```

The development server listens on `http://localhost:4242` by default.

### Database Migrations

Use Drizzle Kit to generate and apply migrations.

**Local development:**
```bash
# Generate a new migration from schema changes
npm run db:generate

# Apply migrations to your local database
npm run db:migrate
```

**CI/CD Deployment:**
```bash
# In your deployment pipeline, run migrations before starting the server
npm run db:migrate
```

**Database management:**
```bash
# Open Drizzle Studio to view and manage data
npm run db:studio

# Push schema directly without migrations (dev only)
npm run db:push
```

Migration files are stored in the `./drizzle` directory and should be committed to version control.

### Tests

```bash
npm test
```

Vitest runs the unit suite, including route guards, validation, and webhook signature verification. The suite now mocks
MailHog’s HTTP API and Nodemailer transports, so it can run without Docker or external services.

To replay Stripe events, use the Stripe CLI directly:

```bash
stripe trigger payment_intent.succeeded
```

## Admin Bootstrap

The first admin is created from environment variables at startup. There is no browser-based credential setup or recovery flow: `POST /api/v1/auth/setup` always returns `410 Gone`.

### First-run steps

1. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` (plaintext, at least 12 characters in production), and `ALLOW_ADMIN_SETUP=true`.
2. Start the application. If the `admins` table is empty, one admin is created with the password hashed by bcrypt and left unconfirmed. If any admin already exists, nothing is created.
3. Open `/admin` and log in with those credentials. The login response reports `bootstrapPending: true` until the admin is confirmed.
4. Choose permanent credentials (the new password must also meet the password rules) with `POST /api/v1/auth/confirm-bootstrap`.
5. **Remove `ADMIN_USERNAME` and `ADMIN_PASSWORD` from the environment, set `ALLOW_ADMIN_SETUP=false`, and restart.**

### Security considerations

- `ADMIN_PASSWORD` is hashed as given. Never put a bcrypt hash in it; the hash string would become the password.
- Remove `ADMIN_USERNAME` and `ADMIN_PASSWORD` once the admin is confirmed. Bootstrap only seeds an empty `admins` table, so a leftover `ADMIN_PASSWORD` does not create a second admin, even if you renamed the admin when you confirmed. It is ignored, but a plaintext admin password has no reason to stay in the environment: while it is set and a confirmed admin exists, startup logs a warning, and names any active admin whose password is still the bootstrap one.
- `POST /api/v1/auth/confirm-bootstrap` requires an admin JWT and is rate limited to 3 requests per 15 minutes.
