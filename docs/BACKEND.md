# Backend Architecture

This document details the backend implementation, API design, and core logic for the DFWSC Payment Portal.

## 1. Overview
The backend is a **Fastify 5** application written in **TypeScript**, using **Node.js 22**. Routes handle HTTP concerns; `src/lib/` handles core business logic (Stripe, mailer, auth, etc.).

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
`POST /api/v1/payments/create` always creates a **Stripe Checkout Session** from the required `lineItems` array and returns `{ url, sessionId }` (201): `url` is for browser redirect to the Stripe-hosted checkout page, and `sessionId` is the Checkout Session ID the integrator stores against its order and later passes to `GET /payments/session/:sessionId` to confirm the payment. (The former Stripe Elements / PaymentIntent mode and its `USE_CHECKOUT` toggle have been removed.) Line items must use inline `price_data` (no platform price IDs). The base amount is derived server-side from line items; a caller-supplied `amount` is ignored for Checkout. All line items must use the same 3-letter ISO currency.

**Idempotency**: A nonblank `Idempotency-Key` header is required for all payment creation calls (both API-key and admin). Conflicts return 409: `IDEMPOTENCY_KEY_REUSED` (same key, different parameters; permanent, use a new key) or `IDEMPOTENCY_KEY_IN_USE` (same key still in progress; transient, retry shortly with the same key).

**Metadata**: Caller-supplied metadata is validated against Stripe limits (max 50 keys, 40-char keys, 500-char values) before being passed to Stripe.

**Payment Ledger**: Every payment creation inserts a row into the `payment_ledger` table synchronously after Stripe Checkout Session creation. The ledger tracks connected account, Stripe IDs, amounts, currency, and status. Webhook events update the ledger idempotently with ordering protection (stale events are ignored).

Checkout success/cancel redirects resolve in priority order: client URL, group URL, valid `DEFAULT_PAYMENT_SUCCESS_URL`/`DEFAULT_PAYMENT_CANCEL_URL`, then the built-in `FRONTEND_ORIGIN` fallback. Every success URL (client, group, default or fallback) carries `session_id={CHECKOUT_SESSION_ID}`: it is appended (`?` or `&`, before any `#fragment`) unless the URL already contains the literal `{CHECKOUT_SESSION_ID}` placeholder. This uses plain string handling because URL serialization would percent-encode the braces and Stripe would stop substituting them. The cancel URL is unchanged.

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
5. **Callback**: Stripe redirects to the platform-registered return URL, `GET /api/v1/connect/callback` with `client_id` and `state` (Stripe does not append `account`; it is accepted only as an optional legacy cross-check). Validates CSRF state, looks up `stripeAccountId` from the client record, marks token `completed`, redirects browser to `/onboarding-success`. The state expires after 24 hours; an expired state redirects to `/onboarding-success?status=expired` instead of returning an error.
6. **Refresh**: `GET /api/v1/connect/refresh?client_id=...&state=...` regenerates an expired account link and redirects the client.

## 4. Rate Limiting
- **Implementation**: Sliding-window limiter (`rateLimit` in `lib/rate-limit.ts`) — Redis-backed (shared across replicas) when `REDIS_URL` is set; otherwise falls back to per-process in-memory buckets and logs a one-time startup warning, since limits are then effectively multiplied by replica count under horizontal scaling.
- **Bucket isolation**: Each limiter keeps its own bucket, namespaced by an optional `name` or, by default, the request's method and route pattern (`ratelimit:<METHOD>:<route>:<key>`), so hits on one route never count against or prune another's.
- **Redis outage**: If Redis is unreachable or any pipeline command fails, the request is limited by the per-process in-memory buckets instead (fail-soft, not 503) and the error is logged at most once every 30 seconds. With a single API instance the in-memory limiter is as accurate as Redis, and failing closed would reject payments whenever Redis restarts.
- **Admin/Onboard Routes**: 10 req/min per IP.
- **Resend Route**: 5 req/min per IP.
- **Checkout creation** (`POST /payments/create`): a token bucket (`tokenBucketRateLimit`, same file) per Stripe Account ID (fallback to IP): capacity 200, refilling at 120 per minute (`PAYMENT_CREATE_BUCKET_CAPACITY` and `PAYMENT_CREATE_REFILL_PER_MINUTE` in `lib/constants.ts`). In Redis it is one Lua script per request (atomic, so concurrent requests cannot both take the last token, with the refill computed from Redis's clock); it has the same per-route namespacing and the same in-memory fallback on Redis errors as the sliding window. Bucket keys are `ratelimit:bucket:<METHOD>:<route>:<key>`. A request that takes a token but is then refused before any Stripe call is made (`503 STRIPE_BUSY`, or `503 STRIPE_CIRCUIT_OPEN` from a breaker that was already open) gives that token back (`refund` on the limiter, with its own Lua script on Redis; it returns one token to the same store and bucket the take came from, never above capacity, and at most once per request), so the retry the caller is told to make is not charged twice. A request whose Stripe call went out keeps its token, including a Stripe `429` and a call that timed out, as do requests that fail validation. If the refund itself fails the token stays spent.
- **Session Lookup** (`GET /payments/session/:sessionId`): 30 req/min per IP when anonymous. A request with an `X-Api-Key` header is authenticated with `requireApiKey` (a bad or inactive key is `401`, not a fall back to anonymous; each distinct key is charged to the client IP by `failureRateLimit` before its lookup, keyed by the key's SHA-256 lookup hash, 30 a minute: the same bad key repeated counts once, a charge is given back when the key is accepted or the lookup errors (500), and a blank or missing key is not counted; over 30 distinct keys a request with a key is refused with 429 before any lookup unless the key passed verification within `VERIFIED_KEY_TTL_MS`, and requests over budget while charges from this process are still in flight wait for them to settle; refusals are not counted. `requireApiKey` also remembers a lookup hash that matched no active client for `BAD_API_KEY_TTL_MS` (60 s) and answers repeats 401 without a lookup, cleared early when an admin PATCHes a client's status (`forgetBadApiKey`), so a reactivated client is refused for at most that long; and concurrent verifications of the same key share one lookup), is limited to 600 req/min per client in its own bucket, and only sees its own client's sessions (another client's session is the same `404` as an unknown one).
- **Refusals**: every `429` from these limiters is `{ "error": "Too Many Requests", "code": "RATE_LIMITED" }` with a `Retry-After` header in whole seconds (at least 1): for the sliding window, the time until the oldest counted hit leaves the window; for the token bucket, the time until one token is available.

## 5. Workspace
All clients and groups belong to the `client_portal` workspace. The `workspace` query parameter is required on all admin list endpoints and validated server-side.

## 6. Resilience: Circuit Breakers
Outbound calls to Stripe and SMTP are wrapped by in-process circuit breakers (`lib/circuit-breakers.ts`, built on `opossum`). Each breaker opens after 5 consecutive failures and stays open for a 30-second reset timeout; while open, calls fail fast instead of hitting the upstream service.

A "failure" is defined per breaker. Errors that mean the caller's input was wrong are not counted (opossum records them as successes, so they also reset the consecutive count):
- **Stripe** counts calls with no HTTP status (connection errors), 5xx, 401 (platform key revoked or wrong) and opossum timeouts. Any other 4xx (invalid request, idempotency mismatch, permission, card errors, and 429 rate limiting) does not count. A Stripe 429 therefore never opens the breaker, and because opossum emits "success" for it, it also resets the consecutive-failure count. `POST /payments/create` answers it with `429 RATE_LIMITED` and `Retry-After: 2` (Stripe sends none).
- **SMTP** counts every error except a permanent 5xx rejection of a recipient (`RCPT TO`). Auth, connection, `MAIL FROM`, `DATA` and temporary 4xx failures still count.

- **Stripe** (`withStripeCircuit`): wraps Stripe API calls in the `payments`, `connect`, `products`, and `webhooks` routes. When the breaker is open, these routes catch `isCircuitOpenError` and respond `503` with `{ "error": "Payment service is temporarily unavailable.", "code": "STRIPE_CIRCUIT_OPEN" }`.
- **Stripe concurrency cap**: `withStripeCircuit` also limits Stripe calls in flight (`lib/concurrency-limiter.ts`, in front of the breaker): at most 25 at once (`STRIPE_MAX_CONCURRENT_CALLS`); further calls wait FIFO for a slot. A call that waits longer than 10 s (`STRIPE_QUEUE_MAX_WAIT_MS`), or arrives when 500 are already waiting (`STRIPE_QUEUE_MAX_WAITING`), fails with a busy error that is never counted by the breaker. `mapStripeError` turns it into `503 { "error", "code": "STRIPE_BUSY" }` with `Retry-After: 5` at every call site. A webhook that cannot get a slot answers `503`, releases its claim and is not marked processed, so Stripe redelivers it. The checkout status reconciliation lookup in `routes/payments.ts` stays outside `withStripeCircuit` (and so outside the cap) with its own 3 s timeout. The cap is per process.
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
| GET | `/payments/session/:sessionId` | Get checkout session result from ledger (how integrators confirm payment; 30 req/min per IP, or 600 req/min per client with `X-Api-Key`) | Public, or API key |
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
