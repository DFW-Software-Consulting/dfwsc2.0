# DFWSC Payment API Reference

Request and response reference for the routes a client application calls with its API key, plus the few public routes. For a step-by-step integration guide (retries, confirming payments, invoicing examples) read [CLIENT_INTEGRATION.md](./CLIENT_INTEGRATION.md). For the complete route table (admin panel routes, webhooks, rate limits, feature flags) read [docs/BACKEND.md](./docs/BACKEND.md), section 7.

## Contents
1. [Base URL and conventions](#base-url-and-conventions)
2. [Authentication](#authentication)
3. [Errors](#errors)
4. [Rate limits](#rate-limits)
5. [Endpoints](#endpoints)
6. [Fee calculation](#fee-calculation)
7. [Routes that are not documented here](#routes-that-are-not-documented-here)

---

## Base URL and conventions

| Item | Value |
|---|---|
| Production base URL | `https://api.dfwsc.com/api/v1` |
| Format | JSON request and response bodies (`Content-Type: application/json`) |
| Transport | HTTPS only. Never send an API key over plain HTTP |
| Amounts | Integer cents (`5000` is $50.00) |
| Request id | Every response has an `X-Request-Id` header. Send your own `X-Request-Id` (1 to 100 characters of letters, digits, `_` and `-`) to have it reused; quote it when you contact support |

Every route below is under `/api/v1`. The one exception is `GET /app-config.js` (no prefix), which serves the DFWSC web front end and is not part of the integrator API. Swagger UI (`/docs`) is served only when the API process is started with `ENABLE_SWAGGER=true`, so do not rely on it.

---

## Authentication

| Caller | Header | Used for |
|---|---|---|
| Client application | `X-Api-Key: <your key>` | Everything in the Endpoints section except the public routes |
| DFWSC administrator | `Authorization: Bearer <JWT>` from `POST /auth/login` | The admin panel routes (see [docs/BACKEND.md](./docs/BACKEND.md), section 7) |
| Public | none | `GET /health`, `POST /contact`, `GET /payments/session/:sessionId` (optional key), the API key regeneration routes |

An API key belongs to one client and is created when DFWSC onboards you. Keep it on your server. A missing or blank key returns `401 { "error": "API key is required." }`; an unknown, wrong or deactivated key returns `401 { "error": "Invalid API key." }`. If your key is lost or leaked, use the regeneration routes below or ask your DFWSC administrator.

---

## Errors

Most errors are:

```json
{ "error": "Human-readable message", "code": "MACHINE_CODE", "requestId": "..." }
```

- Branch on `code` when it is present, and on the HTTP status otherwise. The text of `error` can change.
- Some errors have no `code` or no `requestId`: authentication failures (`401`), many `400` validation errors (`{ "error": "..." }`), and schema errors (`{ "error", "requestId" }`).
- `429` is always `{ "error": "Too Many Requests", "code": "RATE_LIMITED" }` with a `Retry-After` header in whole seconds (at least 1).
- An unknown path is `404 { "error": "Not Found" }`.
- A `502` or `503` returned while the API restarts during a deploy comes from the proxy in front of it and has neither this body nor `X-Request-Id`; check the status before parsing.

Codes you can see on the client routes:

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST` (or none) | Missing or invalid field. `error` says which |
| 400 | `INVALID_REQUEST` | Stripe rejected a field; `param` names it when known |
| 400 | `REDIRECT_URL_NOT_ALLOWED` | A Connect return or refresh URL is not on one of your allowed origins |
| 402 | `CARD_DECLINED` | The card was declined |
| 404 | `NOT_FOUND` | Unknown resource, or one that belongs to another client |
| 409 | `ACCOUNT_NOT_CONNECTED` | Stripe onboarding is not finished or the account cannot take charges |
| 409 | `CARD_PAYMENTS_NOT_ACTIVE` | The `card_payments` capability is not active on your Stripe account |
| 409 | `IDEMPOTENCY_KEY_REUSED` | The `Idempotency-Key` was used with a different request body |
| 409 | `IDEMPOTENCY_KEY_IN_USE` | A request with this key is still running; retry the same request shortly |
| 409 | `REDIRECT_ORIGINS_NOT_CONFIGURED` | No redirect origins are registered for your account |
| 409 | `ONBOARDING_INCOMPLETE` | A dashboard link was requested before Stripe onboarding finished |
| 429 | `RATE_LIMITED` | Too many requests, or Stripe is rate limiting; wait `Retry-After` |
| 502 | `STRIPE_FAILED` | Stripe could not be reached or failed in an unclassified way |
| 502 | `EMAIL_DELIVERY_FAILED` | A required email could not be sent |
| 503 | `STRIPE_BUSY` | Too many Stripe calls in flight; `Retry-After: 5`; nothing was created |
| 503 | `STRIPE_CIRCUIT_OPEN` | Stripe calls are paused after repeated failures; retry in about 30 seconds |
| 503 | `LEDGER_PERSISTENCE_FAILED` | Stripe created the session but the record could not be saved; retry with the same key |

Invoicing adds its own codes; they are listed in the error reference of [CLIENT_INTEGRATION.md](./CLIENT_INTEGRATION.md#error-reference).

---

## Rate limits

Limits apply per client IP unless noted. The full table, and how the client IP is determined behind the proxy, are in [docs/BACKEND.md](./docs/BACKEND.md), section 4.

| Route | Limit |
|---|---|
| `POST /payments/create` | Token bucket per Stripe account: 200 at once, refilling at 120 per minute |
| `GET /payments/session/:sessionId` | 30 per minute per IP without a key; 600 per minute per client with `X-Api-Key` |
| `POST /connect/onboarding-link`, `POST /connect/dashboard-link` | 10 per minute per client |
| `GET /connect/account` | 60 per minute per client |
| `POST /api-key/regenerate-request` | 5 per minute per IP |
| `POST /api-key/regenerate`, `POST /contact` | 10 per minute per IP |
| Invoicing writes / reads | Token bucket 300, refilling at 120 per minute / 600 per minute per client |

Environment variables are not part of the client API; operators find them in [docs/ENVIRONMENT.md](./docs/ENVIRONMENT.md).

---

## Endpoints

### Health

`GET /health` (public)

```json
{ "status": "ok", "database": "connected", "timestamp": "2026-01-15T14:32:10.000Z" }
```

If the database check fails the status is `503` and the body is `{ "status": "error", "database": "disconnected", "timestamp": "..." }`.

### Create a payment

`POST /payments/create`

Creates a Stripe Checkout Session on your connected account. Redirect the customer to the returned `url`. Payments are Checkout-only; there is no embedded card form and no PaymentIntent client secret.

Headers:

| Header | Required | Description |
|---|---|---|
| `X-Api-Key` | Yes | Your API key |
| `Idempotency-Key` | Yes | A new UUID per payment attempt. The key is combined with your client id, and the result must fit in 255 characters (a key of up to 218 characters is always accepted). A missing or too long key is `400` |
| `Content-Type` | Yes | `application/json` |

Body (unknown fields are ignored):

| Field | Required | Description |
|---|---|---|
| `lineItems` | Yes | 1 to 100 items: `{ price_data: { currency, product_data: { name, description? }, unit_amount }, quantity? }`. `name` is 1 to 200 characters, `description` up to 1000. `unit_amount` is an integer from 1 to 99,999,999 (cents). `quantity` is an integer from 1 to 999,999 (default 1). All items must use the same 3-letter currency. Only inline `price_data` is accepted (no Stripe price ids) |
| `description` | No | Up to 2000 characters. Shown in your Stripe dashboard |
| `metadata` | No | String-to-string map. At most 50 keys; keys up to 40 characters; values up to 500. Attached to the PaymentIntent. The names `clientId`, `baseAmount`, `feeAmount` and `waivedFeeAmount` are set by the API and overwrite yours |

`amount` and `currency` are not used; the amount is computed from `lineItems`. `waiveFee`, `workspace` and `clientId` are for DFWSC administrators and have no effect on an API key call (an API key can never waive the fee).

```bash
curl -X POST https://api.dfwsc.com/api/v1/payments/create \
  -H "X-Api-Key: $KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
    "lineItems": [{
      "price_data": { "currency": "usd", "product_data": { "name": "Invoice #1234" }, "unit_amount": 5000 },
      "quantity": 1
    }],
    "metadata": { "invoiceId": "1234" }
  }'
```

Response `201`:

```json
{ "url": "https://checkout.stripe.com/c/pay/cs_test_...", "sessionId": "cs_test_..." }
```

Store `sessionId` with your order. After payment Stripe sends the customer to your success URL with `?session_id=<id>` appended (or `&session_id=` when the URL already has a query string). Success and cancel URLs come from your account settings, then your group's, then the DFWSC default, then the portal's own `/payment-success` and `/payment-cancel` pages; ask your administrator to set yours.

Errors: `400` (validation, missing `Idempotency-Key`), `401`, `402 CARD_DECLINED`, `409 ACCOUNT_NOT_CONNECTED`, `409 CARD_PAYMENTS_NOT_ACTIVE`, `409 IDEMPOTENCY_KEY_REUSED`, `409 IDEMPOTENCY_KEY_IN_USE`, `429 RATE_LIMITED`, `502 STRIPE_FAILED`, `503 STRIPE_BUSY`, `503 STRIPE_CIRCUIT_OPEN`, `503 LEDGER_PERSISTENCE_FAILED`. What to retry, and how, is in [CLIENT_INTEGRATION.md](./CLIENT_INTEGRATION.md).

### Get a payment's status

`GET /payments/session/{sessionId}` (public; send `X-Api-Key` for the higher limit and to see only your own sessions)

`sessionId` must be a Checkout Session id (`cs_test_...` or `cs_live_...`), otherwise `400`. Response `200`:

```json
{
  "status": "paid",
  "baseAmountCents": 5000,
  "totalAmountCents": 5500,
  "feeAmountCents": 500,
  "currency": "usd",
  "createdAt": "2026-01-15T14:32:10.000Z"
}
```

| `status` | Meaning |
|---|---|
| `created` | Checkout not finished yet (or a delayed payment method such as a bank debit has not settled) |
| `paid` | Paid. The only status to fulfil an order on |
| `expired` | The session expired unpaid |
| `failed` | A payment attempt failed. Not final: a later successful attempt on the same session can still make it `paid` |
| `canceled` | The payment was canceled |
| `refunded` | Paid, then refunded. Includes partial refunds; the refunded amount is not returned |
| `disputed` | Paid, then disputed |

`baseAmountCents` is the sum of your line items, `feeAmountCents` the DFWSC processing fee, and `totalAmountCents` what the customer paid (base plus fee). An unknown session, or (with `X-Api-Key`) another client's session, is `404`. A `created` session older than 30 seconds is re-checked against Stripe, at most once per session per 30 seconds.

### Set up payments from your own app (Stripe Connect)

All three calls need `X-Api-Key` and always act on your own Stripe account. An administrator must first register your app's origin(s) on your account (`connectRedirectOrigins`).

| Method and path | Body | Response |
|---|---|---|
| `POST /connect/onboarding-link` | `{ "returnUrl": "...", "refreshUrl": "..." }` (up to 2048 characters each; absolute `https` URLs, or `http` on localhost, on an allowed origin) | `200 { "url", "expiresAt" }`. Creates your Stripe account the first time |
| `GET /connect/account` | none | `200 { hasAccount, detailsSubmitted, chargesEnabled, payoutsEnabled, requirements: { currentlyDue, pastDue, disabledReason }, capabilities }`. `hasAccount: false` with empty values when you have no account yet |
| `POST /connect/dashboard-link` | none | `200 { "url" }` to the Stripe Express Dashboard (bank and payout details) |

Errors: `409 REDIRECT_ORIGINS_NOT_CONFIGURED`, `400 REDIRECT_URL_NOT_ALLOWED`, `409 ONBOARDING_INCOMPLETE` (dashboard link before onboarding is finished), `400 INVALID_REQUEST`, `409 ACCOUNT_NOT_CONNECTED`, `429`, `502 STRIPE_FAILED`, `503 STRIPE_BUSY` / `STRIPE_CIRCUIT_OPEN`. Links are single use and short lived: create one when the user clicks, never store or log it.

### API key regeneration

Both routes are public and token based.

| Method and path | Body | Response |
|---|---|---|
| `POST /api-key/regenerate-request` | `{ "email": "..." }` | Always `200 { "message": "If an account with that email exists, a regeneration link has been sent." }` for a valid request, whether or not the email belongs to a client. An email with a link valid for 15 minutes is sent to an active client. A client that was sent a link in the last 5 minutes is not sent another |
| `POST /api-key/regenerate` | `{ "token": "..." }` (the token from the email link) | `200 { "apiKey": "..." }`, shown once; the old key stops working. `404` for an unknown token, `400` for a used, invalidated or expired one |

DFWSC administrators can also trigger the email for you.

### Contact form

`POST /contact` (public, 10 per minute per IP). Used by the DFWSC marketing site.

Body: `{ "name", "email", "company", "message" }` (name and company up to 100 characters, message up to 2000, email up to 320), plus an optional `context` object (visit details such as referrer host, landing path, UTM tags, pages and seconds on site; invalid context is dropped, never an error) and a honeypot field `_hp` that must stay empty. Response `201 { "ok": true }` when the message reached the inbox or the sales pipeline; `502 EMAIL_DELIVERY_FAILED` otherwise. Details: [docs/BACKEND.md](./docs/BACKEND.md), section 7 ("Contact").

### Invoicing your customers (optional)

Create customers and invoices on your own Stripe account with the same API key:

`POST /customers`, `GET /customers?externalRef=`, `GET /customers/{id}`, `PATCH /customers/{id}`, `POST /invoices`, `GET /invoices`, `GET /invoices/{id}`, `POST /invoices/{id}/finalize`, `POST /invoices/{id}/send`, `POST /invoices/{id}/void`, `DELETE /invoices/{id}`.

These routes exist only when DFWSC has enabled invoicing on the API (`CONNECT_INVOICING=true`; otherwise every path is `404 Not Found`) and for your account (otherwise `403 INVOICING_NOT_ENABLED`). Webhook-driven status updates also need the Connect webhook endpoint subscribed to the invoice events; a read of an invoice still refreshes a stale one. Full request and response shapes, limits, idempotency rules and error codes: [CLIENT_INTEGRATION.md](./CLIENT_INTEGRATION.md#invoicing-your-customers).

---

## Fee calculation

DFWSC's processing fee is set per account (and per group, and as a default) by your administrator. For each payment the API takes the first of these that is set, in order:

1. Your account's percentage (`processingFeePercent`)
2. Your account's flat fee in cents (`processingFeeCents`)
3. Your group's percentage
4. Your group's flat fee in cents
5. The portal default percentage
6. The portal default flat fee in cents

If none is set, the server's `DEFAULT_PROCESS_FEE_CENTS` applies, and if that is also unset there is no fee. Percentages are applied to the base amount and rounded to whole cents. When the fee is above zero it is added to the Checkout Session as a separate line named **Processing Fee**, so the customer pays the base amount plus the fee, and the fee is sent as the application fee to DFWSC. The fee is fixed when the session is created and returned in `feeAmountCents`.

---

## Routes that are not documented here

These exist but are not part of the client API. Their reference is [docs/BACKEND.md](./docs/BACKEND.md), section 7.

| Area | Routes |
|---|---|
| Admin login | `POST /auth/login` |
| Clients and groups | `/clients`, `/groups` (list, read, update, archive or delete) |
| Admin onboarding | `POST /accounts`, `POST /onboard-client/initiate`, `POST /onboard-client/resend`, `POST /onboard-client`, `GET /connect/callback`, `GET /connect/refresh`, `POST /api-key/regenerate-request/admin` |
| Admin Stripe | `GET /reports/payments`, `/products`, `/tax-rates`, `/settings` |
| Webhooks | `POST /webhooks/stripe`, `POST /webhooks/stripe-billing`, `POST /webhooks/nextcloud/*` |
| Operations | `GET /metrics` (needs a bearer token; disabled unless `METRICS_TOKEN` is set), `GET /app-config.js` |
| Cerebo | `/cerebo/*` (admin only, only when `CEREBO_ENABLED=true`) |

The API has no PaymentIntent payment flow, and no subscription, Stripe customer or DFWSC client routes.
