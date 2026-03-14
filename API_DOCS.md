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
- **All routes** are prefixed with `/api/v1` (except `/docs` and `/api/v1/health`)
- **Swagger UI** (dev only): `http://localhost:4242/docs`

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

All errors return a consistent JSON body:

```json
{
  "error": "Human-readable message describing what went wrong",
  "requestId": "uuid"
}
```

The `requestId` is also in the `X-Request-Id` response header — useful for debugging.

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

No auth required. Use this to check if the API is running.

**Response `200`:**
```json
{ "status": "ok" }
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
  "setupAllowed": true,
  "adminConfigured": false
}
```

> This is only relevant for first-time deployment. Once `ADMIN_PASSWORD` is set in the environment, `setupAllowed` will be `false`.

---

#### `POST /api/v1/auth/setup`

First-run only. Creates the initial admin account. Requires `ALLOW_ADMIN_SETUP=true` and no `ADMIN_PASSWORD` set.

**Headers (if `ADMIN_SETUP_TOKEN` is set):**
```
X-Setup-Token: <your-setup-token>
```

**Request:**
```json
{
  "username": "admin",
  "password": "at-least-8-chars"
}
```

**Response `200`:**
```json
{
  "username": "admin",
  "passwordHash": "$2b$10$...",
  "instructions": [
    "1. Copy the credentials above",
    "2. Add to your environment configuration:",
    "   ADMIN_USERNAME=admin",
    "   ADMIN_PASSWORD=$2b$10$...",
    "3. Remove or set ALLOW_ADMIN_SETUP=false",
    "4. Restart your application"
  ]
}
```

---

### Client Onboarding

#### `POST /api/v1/accounts`

**Auth: Admin JWT**

Creates a new client record and returns their credentials. Does **not** send an email — use `/onboard-client/initiate` if you want an email sent automatically.

**Request:**
```json
{
  "name": "Acme Corp",
  "email": "billing@acmecorp.com"
}
```

**Response `201`:**
```json
{
  "name": "Acme Corp",
  "clientId": "abc123",
  "apiKey": "64-hex-char-string",
  "onboardingToken": "64-hex-char-string",
  "onboardingUrlHint": "http://localhost:1919/onboard?token=..."
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
  "email": "billing@acmecorp.com"
}
```

**Response `201`:**
```json
{
  "message": "Onboarding email sent successfully.",
  "clientId": "abc123",
  "apiKey": "64-hex-char-string"
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

**Auth: Client API key (`X-Api-Key`)**

Creates a payment. The client must have completed Stripe onboarding (have a `stripeAccountId`).

**Required header:**
```
Idempotency-Key: <unique-string>
```

Use a unique key per payment attempt (e.g., a UUID). This prevents duplicate charges if the request is retried.

The behavior depends on the `USE_CHECKOUT` environment variable:

---

**PaymentIntent mode (`USE_CHECKOUT=false` — default)**

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

Redirect the user to this URL to complete payment. After payment, Stripe redirects to the client's configured `paymentSuccessUrl` (or `FRONTEND_ORIGIN/payment-success` as fallback).

**Common payment errors:**
- `400` — Missing or empty `Idempotency-Key`
- `400` — Missing `amount` or `currency` (PaymentIntent mode)
- `400` — Missing `lineItems` (Checkout mode)
- `401` — Missing or invalid API key

---

### Reports

#### `GET /api/v1/reports/payments`

**Auth: Admin JWT**

Retrieve payment history for a client or group.

**Query params** (one of `clientId` or `groupId` required):

| Param | Type | Description |
|-------|------|-------------|
| `clientId` | string | Get payments for a specific client |
| `groupId` | string | Get aggregated payments for all clients in a group |
| `limit` | number | 1–100, limits results |
| `starting_after` | string | Stripe PaymentIntent ID for cursor-based pagination |
| `ending_before` | string | Stripe PaymentIntent ID for cursor-based pagination |

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

**Errors:**
- `400` — Neither `clientId` nor `groupId` provided, or `limit` out of range
- `404` — Client/group not found, or client has no linked Stripe account

---

### Clients

#### `GET /api/v1/clients`

**Auth: Admin JWT**

List all clients.

**Query params:**
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
    "groupId": "grp_123",
    "processingFeePercent": "2.50",
    "processingFeeCents": null,
    "createdAt": "2024-03-14T10:30:00Z"
  }
]
```

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
- `processingFeePercent` — 0–100, cannot be set alongside `processingFeeCents`
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
{ "name": "Enterprise Clients" }
```

**Response `201`:**
```json
{
  "id": "grp_abc",
  "name": "Enterprise Clients",
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

Returns all groups (same shape as POST response, as array).

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
- `account.updated` — syncs client name/email when Stripe onboarding is submitted
- `payment_intent.succeeded` — logged
- `payment_intent.payment_failed` — logged
- `charge.refunded` — logged
- `payout.paid` — logged
- `payout.failed` — logged

Events are stored in `webhook_events` for idempotency — duplicate events are ignored.

---

## Flows

### Onboarding a New Client

**Step 1 — Create the client (admin)**

```
POST /api/v1/auth/login         → get token
POST /api/v1/onboard-client/initiate  → creates client + sends email
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
5. **`DEFAULT_PROCESS_FEE_CENTS`** env var — global default (defaults to `0`)

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
| `FRONTEND_ORIGIN` | Comma-separated allowed CORS origins (e.g., `http://localhost:1919`) |
| `USE_CHECKOUT` | `"true"` or `"false"` — switches payment mode |
| `SMTP_HOST` | SMTP server hostname |
| `SMTP_PORT` | SMTP server port number |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |
| `JWT_SECRET` | At least 32 characters — used to sign admin JWTs |
| `ADMIN_USERNAME` | Admin login username |
| `ADMIN_PASSWORD` | Admin password (bcrypt hash in production) |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4242` | API server port |
| `JWT_EXPIRY` | `1h` | JWT token expiry (e.g., `24h`, `7d`) |
| `API_BASE_URL` | auto-detected | Public API base URL |
| `DEFAULT_PROCESS_FEE_CENTS` | `0` | Global default platform fee in cents |
| `SMTP_FROM` | auto-generated | Sender email address |
| `ENABLE_SWAGGER` | `true` (non-prod) | Set to `false` to disable `/docs` |
| `NODE_ENV` | — | `production`, `development`, or `test` |

### First-run setup only

| Variable | Description |
|----------|-------------|
| `ALLOW_ADMIN_SETUP` | Set to `true` to enable the `/auth/setup` endpoint |
| `ADMIN_SETUP_TOKEN` | Optional token required to call `/auth/setup` |
