# DFW Software Consulting — Payment Portal API Docs

This is the internal API for the DFWSC payment portal. It handles client onboarding through Stripe Connect and payment processing. This document covers everything you need to work with the API.

---

## Table of Contents

1. [Overview](#overview)
2. [Base URL & Environment Setup](#base-url--environment-setup)
3. [Authentication](#authentication)
4. [Rate Limits](#rate-limits)
5. [Error Format](#error-format)
6. [Endpoints](#endpoints)
   - [Health](#health)
   - [Admin Auth](#admin-auth)
   - [Client Onboarding](#client-onboarding)
   - [Stripe Connect](#stripe-connect)
   - [Payments](#payments)
   - [Reports](#reports)
   - [Clients](#clients)
   - [Groups](#groups)
   - [Webhooks](#webhooks)
   - [Configuration](#configuration)
   - [Products](#products)
   - [Settings](#settings)
7. [Flows](#flows)
   - [Onboarding a New Client](#onboarding-a-new-client)
   - [Processing a Payment](#processing-a-payment)
8. [Fee Calculation](#fee-calculation)
9. [Environment Variables Reference](#environment-variables-reference)

---

## Overview

The portal supports two types of users:

| User Type | How They Auth | What They Do |
|-----------|--------------|--------------|
| **Admin** | JWT Bearer token (login via `/auth/login`) | Manage clients, view reports, initiate onboarding |
| **Client** | API key (`X-Api-Key` header) | Create payments |

Clients are businesses that use the platform to accept payments through their own Stripe Express accounts. Admins manage the platform.

---

## Base URL & Environment Setup

- **Dev:** `http://localhost:4242`
- **All routes** are prefixed with `/api/v1` (except `/docs` and `/app-config.js`)
- **Swagger UI** (opt-in, dev only): `http://localhost:4242/docs` — requires `ENABLE_SWAGGER=true`. Note: the Docker dev stack pins `ENABLE_SWAGGER: 'false'` in `docker-compose.base.yml`'s api `environment:` block, which overrides `.env`, so enabling `/docs` in Docker requires changing that compose value (or an override file).

### Starting the dev stack

```sh
make up          # Start everything (API, frontend, DB, MailHog, Stripe CLI)
make logs        # Watch API logs
make down        # Stop everything
make down-v      # Stop + wipe the database
```

---

## Authentication

### Admin: JWT Bearer Token

Most admin endpoints require a JWT. Get one by logging in:

```
POST /api/v1/auth/login
```

Include it on all admin requests:

```
Authorization: Bearer <token>
```

Tokens expire in 1 hour by default (configurable via `JWT_EXPIRY`).

### Client: API Key

Clients authenticate with an API key passed in a header:

```
X-Api-Key: <api-key>
```

The API key is generated when a client is created and is only shown **once** in plaintext. Store it securely — it cannot be retrieved again.

---

## Rate Limits

Rate limiting is per-IP (or per Stripe account ID for payment routes).

| Endpoint | Limit |
|----------|-------|
| `POST /auth/login` | 5 req / 15 min |
| `POST /auth/setup` | 3 req / 15 min |
| `POST /auth/confirm-bootstrap` | 3 req / 15 min |
| `POST /accounts` | 10 req / min |
| `POST /onboard-client/initiate` | 10 req / min |
| `POST /onboard-client/resend` | 5 req / min |
| `GET /onboard-client` | 10 req / min |
| `GET /connect/refresh` | 10 req / min |
| `POST /payments/create` | 20 req / min |

**Rate limit exceeded response:**
```json
{ "error": "Too Many Requests" }
```
Status: `429`

---

## Error Format

All error responses include an `error` field with a human-readable message:

```json
{
  "error": "Human-readable message describing what went wrong",
  "requestId": "uuid"
}
```

Errors that reach the central error handler — thrown application errors, schema validation failures, and unexpected exceptions — also include a `requestId` (and thrown application errors include a `code` such as `NOT_FOUND` or `CONFLICT`). Guard- and handler-level errors (auth 401/403, rate-limit 429, inline validation 400s, and the 404 catch-all) return `{ "error": "..." }` only.

The `X-Request-Id` response header is set on every response and is the reliable way to correlate requests for debugging.

**Common status codes:**

| Code | Meaning |
|------|---------|
| 400 | Bad request — check your request body/params |
| 401 | Not authenticated — missing or invalid credentials |
| 403 | Forbidden — you're authenticated but don't have permission |
| 404 | Resource not found |
| 409 | Conflict — concurrent operation in progress |
| 429 | Too many requests — back off and retry |
| 500 | Server error |
| 502 | External service (Stripe) failed |

---

## Endpoints

### Health

#### `GET /api/v1/health`

No auth required. Use this to check if the API is running. Runs a real database query.

**Response `200`:**
```json
{
  "status": "ok",
  "database": "connected",
  "timestamp": "2024-03-14T10:30:00.000Z"
}
```

**Response `503`** (database unreachable):
```json
{
  "status": "error",
  "database": "disconnected",
  "timestamp": "2024-03-14T10:30:00.000Z"
}
```

---

### Admin Auth

#### `POST /api/v1/auth/login`

Get a JWT token for admin access.

**Request:**
```json
{
  "username": "admin",
  "password": "your-password"
}
```

**Response `200`:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": "1h"
}
```

**Errors:**
- `400` — Missing username or password
- `401` — Wrong credentials
- `429` — Rate limited

---

#### `GET /api/v1/auth/setup/status`

Check whether first-run admin setup is available.

**Response `200`:**
```json
{
  "adminConfigured": false,
  "requiresSetup": true
}
```

> This is only relevant for first-time deployment. Once an admin is configured and `setupConfirmed` is true, bootstrap will be complete.

---

#### `POST /api/v1/auth/setup`

First-run only. Initiates the initial admin account creation. Requires `ALLOW_ADMIN_SETUP=true` and no existing admin in the database.

**Headers (if `ADMIN_SETUP_TOKEN` is set):**
```
X-Setup-Token: <your-setup-token>
```

**Request:**
```json
{
  "username": "admin",
  "password": "at-least-12-chars"
}
```

Passwords must be at least 12 characters.

**Response `200`:**
```json
{
  "username": "admin",
  "instructions": [
    "1. Use the username and the password you just entered to log in.",
    "2. Follow the confirm-bootstrap flow to finalize your setup.",
    "3. (Recommended) Set ALLOW_ADMIN_SETUP=false in your environment."
  ]
}
```

> **Note:** The admin account is not fully active until confirmed via `/auth/confirm-bootstrap`.

---

#### `POST /api/v1/auth/confirm-bootstrap`

**Auth: Admin JWT**

Finalizes the admin account setup. Requires a Bearer token obtained by logging in with the bootstrap credentials first. Rate limited at 3 req / 15 min.

**Request:**
```json
{
  "username": "admin",
  "password": "at-least-12-chars"
}
```

Passwords must be at least 12 characters.

**Response `200`:**
```json
{
  "message": "Admin credentials confirmed"
}
```

**Errors:**
- `400` — Missing username/password, or bootstrap already confirmed, or no bootstrap admin found
- `401` — Missing or invalid Bearer token
- `429` — Rate limited

> **Setup Flow:** 1) On first deploy, the server seeds a bootstrap admin from `ADMIN_USERNAME`/`ADMIN_PASSWORD` (with `setupConfirmed=false` when `ALLOW_ADMIN_SETUP=true`) → 2) `POST /auth/login` with those bootstrap credentials — the response includes `bootstrapPending: true` → 3) `POST /auth/confirm-bootstrap` with the Bearer token and the final username/password to finalize setup → 4) log in with the confirmed credentials. (`/auth/setup` is legacy — it no longer persists credentials to the DB and returns `403` if any admin already exists.)

---

### Client Onboarding

#### `POST /api/v1/accounts`

**Auth: Admin JWT**

Creates a new client record and returns their credentials. Does **not** send an email — use `/onboard-client/initiate` if you want an email sent automatically.

**Request:**
```json
{
  "name": "Acme Corp",
  "email": "billing@acmecorp.com",
  "workspace": "client_portal",
  "groupId": "grp_123"
}
```

- `workspace` — required; the only allowed value is `"client_portal"`
- `groupId` — optional

**Response `201`:**
```json
{
  "name": "Acme Corp",
  "onboardingUrlHint": "http://localhost:5173/onboard?token=...",
  "apiKey": "64-hex-char-string",
  "clientId": "abc123",
  "workspace": "client_portal",
  "groupId": null
}
```

> **Important:** The `apiKey` is only shown here, one time. Copy and securely deliver it to the client. It cannot be retrieved again.

---

#### `POST /api/v1/onboard-client/initiate`

**Auth: Admin JWT**

Creates a new client and sends them an onboarding email with a link to connect their Stripe account.

**Request:**
```json
{
  "name": "Acme Corp",
  "email": "billing@acmecorp.com",
  "workspace": "client_portal",
  "groupId": "grp_123"
}
```

- `workspace` — required; the only allowed value is `"client_portal"`
- `groupId` — optional; must reference an existing group in the same workspace or the request fails with `400`

**Response `201`:**
```json
{
  "message": "Onboarding email sent successfully.",
  "clientId": "abc123",
  "apiKey": "64-hex-char-string",
  "groupId": null
}
```

The email contains a link like: `<FRONTEND_ORIGIN>/onboard?token=<token>`

---

#### `POST /api/v1/onboard-client/resend`

**Auth: Admin JWT**

Resends the onboarding email with a new token. The old token is revoked. Use this if a client lost their link or the token expired.

**Request** (provide one of `email` or `clientId`):
```json
{
  "email": "billing@acmecorp.com"
}
```
or:
```json
{
  "clientId": "abc123"
}
```

**Response `200`:**
```json
{
  "message": "New onboarding link sent successfully.",
  "clientId": "abc123"
}
```

---

#### `GET /api/v1/onboard-client?token=<token>`

No auth. Called by the frontend when a client visits their onboarding link.

Validates the token, creates a Stripe Express account (if not already created), and returns the Stripe account link URL.

**Response `200`:**
```json
{
  "url": "https://connect.stripe.com/setup/acct_..."
}
```

**Errors:**
- `404` — Token not found, already used, revoked, or expired
- `502` — Stripe API failure

---

### Stripe Connect

#### `GET /api/v1/connect/callback?client_id=...&state=...&account=...`

No auth. This is the redirect URL Stripe calls after a client completes onboarding. You don't call this manually — Stripe does.

After successful validation, the client's `stripeAccountId` is saved and the user is redirected to `<FRONTEND_ORIGIN>/onboarding-success`.

**Errors:**
- `400` — Missing or invalid parameters, expired state (30-min window)

---

#### `GET /api/v1/connect/refresh?token=<token>`

No auth. Regenerates a Stripe account link for an incomplete onboarding. Stripe calls this when an account link expires. Redirects (302) directly to the new Stripe account link.

---

### Payments

#### `POST /api/v1/payments/create`

**Auth: Client API key (`X-Api-Key`), or Admin JWT with a `clientId` in the body**

Creates a payment. The client must have completed Stripe onboarding (have a `stripeAccountId`) **and** have `chargesEnabled` — otherwise the request fails with `409` `{ "error": ..., "code": "ACCOUNT_NOT_CONNECTED" }`. Note that `chargesEnabled` is set asynchronously by the Stripe `account.updated` webhook after onboarding completes, so there can be a window where `stripeAccountId` exists but payments still return `409`.

For admin calls, pass `clientId` in the body (or `metadata.clientId`) along with a valid `workspace`; the `Idempotency-Key` header is only mandatory for `X-Api-Key` calls (auto-generated for admin calls).

**Required header:**
```
Idempotency-Key: <unique-string>
```

Use a unique key per payment attempt (e.g., a UUID). This prevents duplicate charges if the request is retried.

The behavior depends on the `USE_CHECKOUT` environment variable:

---

**PaymentIntent mode (`USE_CHECKOUT=false`)**

Use this when you want to embed a payment form in your own frontend using Stripe Elements.

**Request:**
```json
{
  "amount": 5000,
  "currency": "usd",
  "description": "Invoice #1234",
  "metadata": {
    "invoiceId": "1234"
  }
}
```

- `amount` — in cents (e.g., `5000` = $50.00)
- `currency` — ISO 4217 currency code (e.g., `"usd"`)
- `description` — optional
- `metadata` — optional key/value pairs passed to Stripe

**Response `201`:**
```json
{
  "clientSecret": "pi_xxx_secret_yyy",
  "paymentIntentId": "pi_xxx"
}
```

Pass `clientSecret` to `stripe.confirmPayment()` in your frontend.

---

**Checkout mode (`USE_CHECKOUT=true`)**

Use this for a hosted Stripe Checkout page — the user is redirected to Stripe to complete payment.

**Request:**
```json
{
  "amount": 5000,
  "currency": "usd",
  "description": "Invoice #1234",
  "metadata": { "invoiceId": "1234" },
  "lineItems": [
    {
      "price_data": {
        "currency": "usd",
        "product_data": { "name": "Web Development" },
        "unit_amount": 5000
      },
      "quantity": 1
    }
  ]
}
```

- `lineItems` — required in Checkout mode, must be non-empty

**Response `201`:**
```json
{
  "url": "https://checkout.stripe.com/pay/cs_..."
}
```

Redirect the user to this URL to complete payment. After payment, Stripe redirects to the client's configured `paymentSuccessUrl`, falling back to the client's group `paymentSuccessUrl`, then to `FRONTEND_ORIGIN/payment-success`. (The same three-tier chain applies to cancel URLs.)

**Common payment errors:**
- `400` — Missing or empty `Idempotency-Key`
- `400` — Missing `amount` or `currency` (PaymentIntent mode)
- `400` — Missing `lineItems` (Checkout mode)
- `401` — Missing or invalid API key
- `409` — Client's Stripe account is not connected/charges-enabled (`code: "ACCOUNT_NOT_CONNECTED"`)

---

### Reports

#### `GET /api/v1/reports/payments`

**Auth: Admin JWT**

Retrieve payment history for a client or group.

**Query params** (`workspace` required; one of `clientId` or `groupId` required):

| Param | Type | Description |
|-------|------|-------------|
| `workspace` | string | Required — must be `client_portal`; missing/invalid returns `400` "workspace query parameter is required (client_portal)." |
| `clientId` | string | Get payments for a specific client |
| `groupId` | string | Get aggregated payments for all clients in a group |
| `limit` | number | 1–100, limits results |
| `starting_after` | string | Stripe PaymentIntent ID for cursor-based pagination |
| `ending_before` | string | Stripe PaymentIntent ID for cursor-based pagination |

> `starting_after`/`ending_before` apply only to `clientId` queries — they are ignored for `groupId` queries (cursors are per-Stripe-account; only `limit` is applied per account, so a group response can contain up to `limit` × number-of-connected-clients rows).

**Response `200` (by client):**
```json
{
  "clientId": "abc123",
  "data": [
    {
      "id": "pi_xxx",
      "amount": 5000,
      "status": "succeeded",
      "created": 1710000000,
      "currency": "usd"
    }
  ],
  "hasMore": false
}
```

**Response `200` (by group):**
```json
{
  "groupId": "grp_123",
  "data": [...],
  "hasMore": false
}
```

In group mode, each payment row additionally includes `clientId` and `clientName`.

**Errors:**
- `400` — Missing/invalid `workspace`, neither `clientId` nor `groupId` provided, `limit` out of range, invalid `groupId` ("Invalid groupId."), or a `clientId` that does not belong to the selected workspace
- `404` — Client not found, or client has no linked Stripe account

---

### Clients

#### `GET /api/v1/clients`

**Auth: Admin JWT**

List clients in a workspace.

**Query params:**
- `workspace` (required) — the only accepted value is `client_portal`
- `groupId` (optional) — filter to clients in a specific group

**Response `200`:**
```json
[
  {
    "id": "abc123",
    "name": "Acme Corp",
    "email": "billing@acmecorp.com",
    "stripeAccountId": "acct_xxx",
    "status": "active",
    "workspace": "client_portal",
    "groupId": "grp_123",
    "processingFeePercent": "2.50",
    "processingFeeCents": null,
    "createdAt": "2024-03-14T10:30:00Z"
  }
]
```

**Errors:**
- `400` — `workspace` missing/invalid ("workspace query parameter is required (client_portal).")
- `400` — `groupId` does not belong to the selected workspace ("groupId does not belong to the selected workspace.")

> `GET /api/v1/clients/:id` requires the same `workspace` query param.

---

#### `PATCH /api/v1/clients/:id`

**Auth: Admin JWT**

Update a client's configuration. All fields are optional — only send what you want to change.

**Request:**
```json
{
  "status": "active",
  "groupId": "grp_123",
  "paymentSuccessUrl": "https://acmecorp.com/payment-success",
  "paymentCancelUrl": "https://acmecorp.com/payment-cancel",
  "processingFeePercent": 2.5,
  "processingFeeCents": null
}
```

**Field rules:**
- `status` — `"active"` or `"inactive"`
- `groupId` — existing group ID, or `null` to remove from group
- `paymentSuccessUrl` / `paymentCancelUrl` — must be HTTPS
- `processingFeePercent` — greater than 0 and at most 100 (use `null` to clear), cannot be set alongside `processingFeeCents`
- `processingFeeCents` — non-negative integer in cents, cannot be set alongside `processingFeePercent`

**Response `200`:** Updated client object (same shape as GET response)

**Errors:**
- `400` — Invalid values (bad URL, both fee fields set, etc.)
- `404` — Client not found

---

### Groups

Groups let you organize clients and apply shared fee/URL defaults.

#### `POST /api/v1/groups`

**Auth: Admin JWT**

**Request:**
```json
{
  "name": "Enterprise Clients",
  "workspace": "client_portal"
}
```

- `workspace` — required; missing/invalid returns `400` "workspace is required (client_portal)."

**Response `201`:**
```json
{
  "id": "grp_abc",
  "name": "Enterprise Clients",
  "workspace": "client_portal",
  "status": "active",
  "processingFeePercent": null,
  "processingFeeCents": null,
  "paymentSuccessUrl": null,
  "paymentCancelUrl": null,
  "createdAt": "2024-03-14T10:30:00Z",
  "updatedAt": "2024-03-14T10:30:00Z"
}
```

---

#### `GET /api/v1/groups`

**Auth: Admin JWT**

Returns groups for the given workspace (same shape as POST response, as array). Requires the `workspace` query param, e.g. `GET /api/v1/groups?workspace=client_portal` — returns `400` "workspace query parameter is required (client_portal)." if missing. All group responses (including PATCH) include the `workspace` field.

---

#### `PATCH /api/v1/groups/:id`

**Auth: Admin JWT**

All fields optional:

```json
{
  "name": "New Group Name",
  "status": "active",
  "processingFeePercent": 3.0,
  "processingFeeCents": null,
  "paymentSuccessUrl": "https://example.com/success",
  "paymentCancelUrl": "https://example.com/cancel"
}
```

Same validation rules as `PATCH /clients/:id`. Returns updated group object.

---

### Webhooks

#### `POST /api/v1/webhooks/stripe`

Stripe calls this endpoint automatically. You don't call it manually. It requires a valid `Stripe-Signature` header and uses the raw request body.

The server handles these events:
- `account.updated` — syncs the client's onboarding readiness flags (`chargesEnabled`, `payoutsEnabled`, `detailsSubmitted`) by matching `stripeAccountId`
- `payment_intent.succeeded` — logged
- `payment_intent.payment_failed` — logged
- `charge.refunded` — logged
- `application_fee.refunded` — logged
- `payout.paid` — logged
- `payout.failed` — logged
- `invoice.payment_succeeded` / `invoice.payment_failed` — logged
- `invoice.paid` — increments `paymentsMade` metadata on the subscription and its schedule
- `customer.subscription.updated` / `.paused` / `.resumed` / `.deleted` — logged
- `subscription_schedule.completed` — marks schedule metadata completed
- `subscription_schedule.canceled` — logged

Events are stored in `webhook_events` for idempotency — duplicate events are ignored.

---

### Configuration

#### `GET /app-config.js`

No auth required. Registered **without** the `/api/v1` prefix. Returns a JavaScript snippet (`Content-Type: application/javascript`) that the frontend loads to discover the API base URL:

```js
window.API_URL = "<API_BASE_URL>";
```

**Errors:**
- `500` — `API_BASE_URL` is not set

---

### Products

#### `GET /api/v1/products`

**Auth: Admin JWT**

List active Stripe products on the platform account (up to 100), with default price expanded. Takes no query params.

**Response `200`:**
```json
[
  {
    "id": "prod_xxx",
    "name": "Monthly Retainer",
    "description": "...",
    "defaultPrice": {
      "id": "price_xxx",
      "amountCents": 50000,
      "currency": "usd"
    }
  }
]
```

`description` and `defaultPrice` may be `null`.

#### `GET /api/v1/tax-rates`

**Auth: Admin JWT**

List active platform tax rates (up to 100).

**Response `200`:**
```json
[
  {
    "id": "txr_xxx",
    "displayName": "Sales Tax",
    "description": null,
    "percentage": 8.25,
    "inclusive": false,
    "jurisdiction": "TX"
  }
]
```

#### `POST /api/v1/products`

**Auth: Admin JWT**

Create a new Stripe product.

**Request:**
```json
{
  "name": "Consulting Package",
  "description": "10 hours of consulting",
  "amountCents": 50000,
  "currency": "usd"
}
```

- `name` — required
- `description` — optional
- `amountCents` — required, positive integer
- `currency` — optional, defaults to `"usd"`

**Response `201`:** Created product object, same shape as the `GET /api/v1/products` items (`{ id, name, description, defaultPrice }`).

---

### Settings

#### `GET /api/v1/settings`

**Auth: Admin JWT**

Get system settings and billing defaults. Values are strings (settings are stored as text).

**Response `200`:**
```json
{
  "defaultFeeCents": "0",
  "defaultFeePercent": null,
  "companyName": "DFW Software Consulting",
  "contactEmail": "billing@example.com",
  "smtpFrom": "billing@example.com"
}
```

- `defaultFeeCents` — falls back to the `DEFAULT_PROCESS_FEE_CENTS` env var, then `"0"`
- `defaultFeePercent` — `null` when unset
- `contactEmail` — falls back to `SMTP_FROM`

#### `PATCH /api/v1/settings/:key`

**Auth: Admin JWT**

Update a single setting.

**Request:**
```json
{ "value": "<string>" }
```

Allowed keys:
- `default_fee_cents` — non-negative integer string
- `default_fee_percent` — empty string or 0–100
- `company_name` — 1–120 chars
- `contact_email` — valid email or empty

**Response `200`:**
```json
{ "message": "Setting updated successfully." }
```

**Errors:**
- `400` — Invalid key or value

---

## Flows

### Onboarding a New Client

**Step 1 — Create the client (admin)**

```
POST /api/v1/auth/login         → get token
POST /api/v1/onboard-client/initiate  → creates client + sends email (body requires workspace: "client_portal")
```

Save the `apiKey` from the response. You will not see it again. The client receives an email with their onboarding link.

**Step 2 — Client connects Stripe (client action)**

The client clicks the link in their email, which opens the frontend at `/onboard?token=...`. The frontend calls `GET /api/v1/onboard-client?token=...` to get a Stripe Connect URL, then redirects the client to Stripe.

**Step 3 — Stripe redirects back**

After the client finishes on Stripe, they're redirected back to `GET /api/v1/connect/callback`. The server validates the state, saves the `stripeAccountId`, and redirects to the success page.

**Client is now ready to accept payments.**

**If the client never finishes onboarding:**

```
POST /api/v1/onboard-client/resend    → sends new link, revokes old one
```

---

### Processing a Payment

**PaymentIntent flow (embedded form):**

```
POST /api/v1/payments/create
  Header: X-Api-Key: <client-api-key>
  Header: Idempotency-Key: <unique-uuid>
  Body: { amount: 5000, currency: "usd" }

→ Returns: { clientSecret: "pi_xxx_secret_yyy" }

→ Frontend uses Stripe.js to confirm the payment with clientSecret
```

**Checkout flow (hosted page):**

```
POST /api/v1/payments/create
  Header: X-Api-Key: <client-api-key>
  Header: Idempotency-Key: <unique-uuid>
  Body: { amount: 5000, currency: "usd", lineItems: [...] }

→ Returns: { url: "https://checkout.stripe.com/..." }

→ Redirect user to that URL
```

---

## Fee Calculation

When a payment is created, the platform fee is calculated using this priority order:

1. **Client `processingFeePercent`** — percentage of the payment amount
2. **Client `processingFeeCents`** — flat fee in cents
3. **Group `processingFeePercent`** — if client belongs to a group
4. **Group `processingFeeCents`** — if client belongs to a group
5. **Settings `default_fee_percent`** (DB) — global percentage default
6. **Settings `default_fee_cents`** (DB) — global flat-fee default
7. **`DEFAULT_PROCESS_FEE_CENTS`** env var — global default (defaults to `0`)

Only one rule applies — whichever is first in the list. You cannot set both `processingFeePercent` and `processingFeeCents` on the same client or group.

Example: if a client has `processingFeePercent = 2.5` and the payment amount is `$100.00` (10000 cents), the platform fee is `$2.50` (250 cents).

---

## Environment Variables Reference

### Required

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_...` or `sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (`whsec_...`) |
| `FRONTEND_ORIGIN` | Comma-separated allowed CORS origins (e.g., `http://localhost:5173`) |
| `USE_CHECKOUT` | `"true"` or `"false"` — switches payment mode |
| `SMTP_HOST` | SMTP server hostname |
| `SMTP_PORT` | SMTP server port number |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |
| `JWT_SECRET` | At least 32 characters — used to sign admin JWTs |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4242` | API server port |
| `JWT_EXPIRY` | `1h` | JWT token expiry (e.g., `24h`, `7d`) |
| `API_BASE_URL` | auto-detected (non-production only) | Public API base URL. Required in production — Stripe onboarding-link generation fails with a 500 `CONFIGURATION_ERROR` if unset (header-based auto-detection is deliberately disabled in production to prevent Host-header spoofing). Also required for `GET /app-config.js`, which returns 500 without it in any environment. |
| `ADMIN_USERNAME` | — | Seeds the first admin on startup; if unset, use the `/auth/setup` flow |
| `ADMIN_PASSWORD` | — | Seeds the first admin on startup (plaintext; must be ≥12 chars and not a known default in production); if unset, use the `/auth/setup` flow |
| `DEFAULT_PROCESS_FEE_CENTS` | `0` | Global default platform fee in cents |
| `SMTP_FROM` | auto-generated | Sender email address |
| `ENABLE_SWAGGER` | unset (disabled) | Set to `true` to enable Swagger UI at `/docs` |
| `NODE_ENV` | — | `production`, `development`, or `test` |

### First-run setup only

| Variable | Description |
|----------|-------------|
| `ALLOW_ADMIN_SETUP` | Set to `true` to enable the `/auth/setup` endpoint |
| `ADMIN_SETUP_TOKEN` | Optional token required to call `/auth/setup` |
