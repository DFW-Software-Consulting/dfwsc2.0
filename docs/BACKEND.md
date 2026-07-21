# Backend Architecture

This document details the backend implementation, API design, and core logic for the DFWSC Payment Portal.

## 1. Overview
The backend is a **Fastify 5** application written in **TypeScript**, using **Node.js 20**. Routes handle HTTP concerns; `src/lib/` handles core business logic (Stripe, mailer, auth, etc.).

## 2. Request Authentication
Two distinct schemes are implemented:

- **Client-Facing Routes** (`POST /payments/create`):
  - `X-Api-Key` header.
  - `apiKeyLookup` (SHA256) for O(1) DB lookup + `apiKeyHash` (bcrypt) for secure verification.
- **Admin Routes**:
  - JWT Bearer token from `POST /api/v1/auth/login`.
  - Claims must include `role: "admin"`.

The payment route also accepts Admin JWT as a fallback (for admin-initiated payments).

## 3. Core Flows

### Payment Flow
`POST /api/v1/payments/create` always creates a **Stripe Checkout Session** from the required `lineItems` array and returns a `url` for browser redirect to the Stripe-hosted checkout page. (The former Stripe Elements / PaymentIntent mode and its `USE_CHECKOUT` toggle have been removed.) Line items must use inline `price_data` (no platform price IDs). The base amount is derived server-side from line items; a caller-supplied `amount` is ignored for Checkout. All line items must use the same 3-letter ISO currency.

**Idempotency**: A nonblank `Idempotency-Key` header is required for all payment creation calls (both API-key and admin).

**Metadata**: Caller-supplied metadata is validated against Stripe limits (max 50 keys, 40-char keys, 500-char values) before being passed to Stripe.

**Payment Ledger**: Every payment creation inserts a row into the `payment_ledger` table synchronously after Stripe Checkout Session creation. The ledger tracks connected account, Stripe IDs, amounts, currency, and status. Webhook events update the ledger idempotently with ordering protection (stale events are ignored).

Checkout success/cancel redirects resolve in priority order: client URL, group URL, valid `DEFAULT_PAYMENT_SUCCESS_URL`/`DEFAULT_PAYMENT_CANCEL_URL`, then the built-in `FRONTEND_ORIGIN` fallback. Default success URLs receive `session_id={CHECKOUT_SESSION_ID}` unless they already include a `session_id` query parameter.

All payments resolve `application_fee_amount` via a 6-level priority chain:
1. Client `processingFeePercent`
2. Client `processingFeeCents`
3. Group `processingFeePercent`
4. Group `processingFeeCents`
5. DB setting `default_fee_percent`
6. DB setting `default_fee_cents`

If none of the six levels are set, the flat `DEFAULT_PROCESS_FEE_CENTS` environment variable is applied as a fallback; if that is also unset, no fee is applied.

### Onboarding Flow
1. **Create client**: `POST /api/v1/accounts` creates a client record + pending onboarding token in one transaction, returns `apiKey`, `clientId`, and `onboardingUrlHint` (a URL embedding the onboarding token; the raw token is no longer returned as a separate `onboardingToken` field).
2. **Send email**: `POST /api/v1/onboard-client/initiate` does the same but also emails the client. Unlike `/accounts`, it does **not** return the plaintext `apiKey` (response `apiKey` is `null`); instead the email includes a 15-minute `/regenerate-key#token=...` link that, when clicked, rotates and reveals the API key once via `POST /api/v1/api-key/regenerate` (token in request body, not URL).
3. **Resend**: `POST /api/v1/onboard-client/resend` revokes active tokens and issues a new one with a fresh email.
4. **Onboard**: `POST /api/v1/onboard-client` with body `{ "token": "..." }` creates a Stripe Express Account (if not already) and returns an Account Link URL.
5. **Callback**: Stripe redirects to the platform-registered return URL, `GET /api/v1/connect/callback` with `client_id` and `state` (Stripe does not append `account`; it is accepted only as an optional legacy cross-check). Validates CSRF state, looks up `stripeAccountId` from the client record, marks token `completed`, redirects browser to `/onboarding-success`.
6. **Refresh**: `GET /api/v1/connect/refresh?client_id=...&state=...` regenerates an expired account link and redirects the client.

## 4. Rate Limiting
- **Implementation**: Sliding-window limiter (`lib/rate-limit.ts`) — Redis-backed (shared across replicas) when `REDIS_URL` is set; otherwise falls back to per-process in-memory buckets and logs a one-time startup warning, since limits are then effectively multiplied by replica count under horizontal scaling.
- **Production**: Requires a working Redis connection. If Redis is unavailable in production, requests are rejected (fail-closed) rather than silently degrading to in-memory limits.
- **Admin/Onboard Routes**: 10 req/min per IP.
- **Resend Route**: 5 req/min per IP.
- **Payment Routes**: 20 req/min per Stripe Account ID (fallback to IP).
- **Session Lookup**: 30 req/min per IP.

## 5. Workspace
All clients and groups belong to the `client_portal` workspace. The `workspace` query parameter is required on all admin list endpoints and validated server-side.

## 6. Resilience: Circuit Breakers
Outbound calls to Stripe and SMTP are wrapped by in-process circuit breakers (`lib/circuit-breakers.ts`, built on `opossum`). Each breaker opens after 5 consecutive failures and stays open for a 30-second reset timeout; while open, calls fail fast instead of hitting the upstream service.

- **Stripe** (`withStripeCircuit`): wraps Stripe API calls in the `payments`, `connect`, `products`, and `webhooks` routes. When the breaker is open, these routes catch `isCircuitOpenError` and respond `503` with `{ "error": "Payment service is temporarily unavailable.", "code": "STRIPE_CIRCUIT_OPEN" }`.
- **SMTP** (`withSmtpCircuit`): wraps outbound mail in `lib/mailer.ts` (onboarding and API-key-regeneration emails).
- Breaker state (open/half-open/closed, plus fire/failure/success counts) is exposed via `GET /metrics` (bearer-token protected; the endpoint is disabled and returns 404 if `METRICS_TOKEN` is unset).

## 7. API Route Map
All routes are prefixed with `/api/v1`.

### Public Routes
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/app-config.js` | Public runtime config script (sets window API base URL from API_BASE_URL) |
| GET | `/auth/setup/status` | Check if admin setup is needed |

### Authentication
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/auth/login` | Admin login (returns JWT) | Public |
| POST | `/auth/setup` | Deprecated — always returns 410 Gone | Public |
| POST | `/auth/confirm-bootstrap` | Finalize admin setup (bootstrapped from `ADMIN_USERNAME`/`ADMIN_PASSWORD`) | Admin JWT |

### Clients
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/clients` | List clients (`?workspace=client_portal`) | Admin JWT |
| GET | `/clients/:id` | Get single client | Admin JWT |
| PATCH | `/clients/:id` | Update client fields | Admin JWT |

### Groups
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/groups` | List groups (`?workspace=client_portal`) | Admin JWT |
| POST | `/groups` | Create group | Admin JWT |
| PATCH | `/groups/:id` | Update group | Admin JWT |

### Onboarding & Connect
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/accounts` | Create client + onboarding token (no email) | Admin JWT |
| POST | `/onboard-client/initiate` | Create client + onboarding token + send email | Admin JWT |
| POST | `/onboard-client/resend` | Revoke old tokens + resend email | Admin JWT |
| GET | `/onboard-client` | Get Stripe Account Link URL | Public (token) |
| GET | `/connect/callback` | Stripe Connect callback | Public |
| GET | `/connect/refresh` | Refresh expired account link | Public |

### Payments
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/payments/create` | Create Checkout Session | API Key or Admin JWT + Idempotency-Key |
| GET | `/payments/session/:sessionId` | Get checkout session result from ledger | Public (rate-limited) |
| GET | `/reports/payments` | List Stripe PaymentIntents by client or group | Admin JWT |

### Products & Settings
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/products?clientId=...` | List Stripe products on connected account | Admin JWT |
| POST | `/products` | Create Stripe product on connected account (requires `clientId`) | Admin JWT |
| GET | `/tax-rates?clientId=...` | List Stripe tax rates on connected account | Admin JWT |
| GET | `/settings` | Get system settings | Admin JWT |
| POST | `/webhooks/stripe` | Stripe webhook handler (updates payment ledger) | Stripe Signature |

### API Key Management
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api-key/regenerate-request` | Request API key regeneration email | Public (rate-limited) |
| POST | `/api-key/regenerate-request/admin` | Admin-initiated API key regeneration | Admin JWT |
| POST | `/api-key/regenerate` | Consume regeneration token, return new API key | Public (rate-limited, token in body) |

## 8. Swagger
Swagger UI is available at `/docs` when the backend is started with `ENABLE_SWAGGER=true`. It is disabled by default in production to keep the build lean.
