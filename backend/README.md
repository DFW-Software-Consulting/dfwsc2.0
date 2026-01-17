# Stripe Payment Portal (MVP)

Minimal Stripe Connect API for onboarding Express accounts, creating payments with platform fees, and recording webhook activity. This branch removes all custom invoice/refund handling, local ledgers, and non-essential routes so the service focuses on the Stripe source of truth.

## Requirements

- Node.js v18+
- PostgreSQL 14+
- Stripe account with Connect enabled

## Environment Variables

Create a `.env` file based on `env.example`.

| Variable | Required | Description |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | ✅ | Stripe API key used for all server-side requests. |
| `STRIPE_WEBHOOK_SECRET` | ✅ | Signing secret for `/webhooks/stripe`. |
| `FRONTEND_ORIGIN` | ✅ | Origin allowed by CORS and used for Checkout redirects. |
| `USE_CHECKOUT` | ✅ | `true` to use Checkout Sessions, `false` to create PaymentIntents directly. |
| `DEFAULT_PROCESS_FEE_CENTS` | ❌ | Platform fee applied when the request omits `applicationFeeAmount`. Must be a non-negative integer. |
| `DATABASE_URL` | ✅ | PostgreSQL connection string used by Drizzle. |
| `PORT` | ❌ | Server port (defaults to `4242`). |
| `API_BASE_URL` | ❌ | Public URL for the API. When unset, the service infers it from the request host. |
| `SMTP_HOST` | ✅ | SMTP server used to email onboarding tokens. |
| `SMTP_PORT` | ✅ | Port for the SMTP server (`587` for STARTTLS, `465` for SMTPS). |
| `SMTP_USER` | ✅ | Username/login for the SMTP server. |
| `SMTP_PASS` | ✅ | Password/API key for the SMTP server. |
| `SMTP_FROM` | ❌ | Friendly from address used in onboarding emails. Defaults to `SMTP_USER` when omitted. |
| `ADMIN_USERNAME` | ✅ | Username for admin login to access client management endpoints. |
| `ADMIN_PASSWORD` | ✅ | Password for admin authentication. Supports plain text (dev) or bcrypt hash (production). |
| `JWT_SECRET` | ✅ | Secret key for signing JWT tokens. Must be minimum 32 characters. Generate with: `openssl rand -base64 32` |
| `JWT_EXPIRY` | ❌ | JWT token expiration time. Defaults to `1h`. Supported formats: `1h`, `30m`, `7d`, `24h`. |

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
| `GET /api/v1/clients` | List all clients with their status and Stripe account information. | Admin (JWT) |
| `PATCH /api/v1/clients/:id` | Update client status (`active` or `inactive`). Soft-deletes clients without removing from database. | Admin (JWT) |
| `POST /api/v1/accounts` | Create a client record and onboarding token. | Admin |
| `POST /api/v1/onboard-client/initiate` | Email onboarding link to a client. | Admin |
| `GET /api/v1/onboard-client` | Exchange onboarding token for a Stripe onboarding link. | Public |
| `GET /api/v1/connect/callback` | Stripe onboarding return URL. Persists the `account` query parameter to the client record and redirects to the frontend success page. | Public |
| `POST /api/v1/payments/create` | Create a PaymentIntent or Checkout Session for a client's connected account. Requires an `Idempotency-Key` header. | Admin or Client |
| `POST /api/v1/webhooks/stripe` | Verify the Stripe signature, store the raw event payload, mark the event as processed, and log basic status updates. | Stripe |
| `GET /api/v1/reports/payments` | List PaymentIntents for a client's connected account with Stripe pagination parameters. | Admin |

Non-listed endpoints from earlier versions have been removed (invoices, refunds, ledgers, customer CRUD, etc.).

## Payments and Fees

- The caller supplies the desired `application_fee_amount` for each payment request.
- When `USE_CHECKOUT=false`, the API creates a PaymentIntent with automatic payment methods and returns the `client_secret`.
- When `USE_CHECKOUT=true`, the API creates a Checkout Session with platform fees applied via `payment_intent_data.application_fee_amount` and returns the hosted session URL.
- Idempotency is enforced via the standard `Idempotency-Key` request header on write routes.

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

Use Drizzle CLI to manage schema changes.

```bash
npm run db:generate
npm run db:migrate
```

### Tests

```bash
npm test
```

Vitest runs the unit suite, including route guards, validation, and webhook signature verification. The suite now mocks
MailHog’s HTTP API and Nodemailer transports, so it can run without Docker or external services.

To replay Stripe’s core webhook events against a local server, run the helper script after authenticating with the Stripe
CLI:

```bash
make test-stripe
```

Update the `CONNECTED_ACCT` placeholder in `test-stripe-events.sh` with a real test-mode connected account ID before
triggering the connected account event set.
