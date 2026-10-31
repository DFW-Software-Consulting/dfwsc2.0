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
  - Claims must include `role: "admin"`. `requireAdminJwt` checks the signature (HS256), expiry and role only; it does not read the database.

The payment route also accepts Admin JWT as a fallback (for admin-initiated payments).

### Admin login (Nextcloud)
`POST /auth/login` (`{ username, password }`, unchanged) is checked against Nextcloud (`lib/admin-login.ts`); the portal has no admin accounts of its own (the `admins` table is legacy and unused).
1. The user's own credentials go in an HTTP Basic header to `GET {NEXTCLOUD_BASE_URL}/ocs/v2.php/cloud/user?format=json` (with `OCS-APIRequest: true`). A 200 means the password is valid, and `ocs.data.id` is the canonical user id (a user who typed an email alias is signed in as their id). 401 or 403 means bad credentials.
2. The service account (`NEXTCLOUD_USERNAME` / `NEXTCLOUD_APP_PASSWORD`, a Nextcloud admin) reads `GET /ocs/v2.php/cloud/users/{id}/groups?format=json` (id URL-encoded; response `ocs.data.groups`). Both calls follow the OCS provisioning API (`instruction_set_for_users`).
3. The user must be in at least one of `ADMIN_NEXTCLOUD_GROUPS` (comma-separated, exact ids, default `dfwsc-admins,managers`).

| Outcome | Response |
|---|---|
| Allowed | `200 { token, expiresIn }`. JWT `sub` = Nextcloud user id, `role` = `admin`, expiry `JWT_EXPIRY` (default 1h) |
| Bad credentials (including a username containing `:` or control characters, which is refused without calling Nextcloud) | `401 Invalid credentials` |
| Valid credentials, no allowed group | `403 This Nextcloud account isn't authorized for the admin panel` |
| Nextcloud unreachable, timing out, 5xx, 429, unexpected answer, breaker open, or `NEXTCLOUD_*` not configured | `503 Admin login is unavailable` (never 500) |

The password is sent only to `NEXTCLOUD_BASE_URL`, only on step 1, and is never logged or stored. Calls use `nextcloudRequest` (shared breaker and 8 s timeout); a user's 401/403 is listed in `okStatuses`, so wrong passwords never count as breaker failures, while 5xx, timeouts and a rejected service account do. Limits: 5 requests / 15 min per client IP and 10 / 15 min per username (trimmed, case-insensitive, hashed in the bucket key), because Nextcloud throttles failures by source IP and that is always this API, so guessing here would also slow the service account's automation. Accounts with two-factor login must use a Nextcloud app password. There is no local fallback: with Nextcloud down nobody can log in to the admin panel, while payments (API key routes, webhooks) are unaffected; tokens already issued stay valid until they expire.

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
1. **Create client**: `POST /api/v1/accounts` creates the client's Stripe Express account first, then stores the client record (with `stripeAccountId` and readiness flags) + pending onboarding token in one transaction, and returns `apiKey`, `clientId`, and `onboardingUrlHint` (a URL embedding the onboarding token; the raw token is no longer returned as a separate `onboardingToken` field).
2. **Send email**: `POST /api/v1/onboard-client/initiate` does the same but also emails the client. Unlike `/accounts`, it does **not** return the plaintext `apiKey` (response `apiKey` is `null`); instead the email includes a 15-minute `/regenerate-key#token=...` link that, when clicked, rotates and reveals the API key once via `POST /api/v1/api-key/regenerate` (token in request body, not URL).
3. **Resend**: `POST /api/v1/onboard-client/resend` revokes active tokens and issues a new one (in one transaction) with a fresh email; it returns 200 only after the email is sent.
4. **Onboard**: `POST /api/v1/onboard-client` with body `{ "token": "..." }` returns an Account Link URL for the client's stored Stripe account. Clients created before eager provisioning (null `stripeAccountId`) get their account created here as a fallback.
5. **Callback**: Stripe redirects to the platform-registered return URL, `GET /api/v1/connect/callback` with `client_id` and `state` (Stripe does not append `account`; it is accepted only as an optional legacy cross-check). Validates CSRF state, looks up `stripeAccountId` from the client record, marks token `completed`, redirects browser to `/onboarding-success`. The state expires after 24 hours; an expired state redirects to `/onboarding-success?status=expired` instead of returning an error.
6. **Refresh**: `GET /api/v1/connect/refresh?client_id=...&state=...` regenerates an expired account link and redirects the client.

## 4. Rate Limiting
- **Implementation**: Sliding-window limiter (`rateLimit` in `lib/rate-limit.ts`) — Redis-backed (shared across replicas) when `REDIS_URL` is set; otherwise falls back to per-process in-memory buckets and logs a one-time startup warning, since limits are then effectively multiplied by replica count under horizontal scaling.
- **Bucket isolation**: Each limiter keeps its own bucket, namespaced by an optional `name` or, by default, the request's method and route pattern (`ratelimit:<METHOD>:<route>:<key>`), so hits on one route never count against or prune another's.
- **Redis outage**: If Redis is unreachable or any pipeline command fails, the request is limited by the per-process in-memory buckets instead (fail-soft, not 503) and the error is logged at most once every 30 seconds. With a single API instance the in-memory limiter is as accurate as Redis, and failing closed would reject payments whenever Redis restarts.
- **Admin login** (`POST /auth/login`): 5 req / 15 min per IP, plus 10 req / 15 min per submitted username (own bucket, `ratelimit:POST:/auth/login:username:<sha256>`).
- **Admin/Onboard Routes**: 10 req/min per IP.
- **Resend Route**: 5 req/min per IP.
- **Checkout creation** (`POST /payments/create`): a token bucket (`tokenBucketRateLimit`, same file) per Stripe Account ID (fallback to IP): capacity 200, refilling at 120 per minute (`PAYMENT_CREATE_BUCKET_CAPACITY` and `PAYMENT_CREATE_REFILL_PER_MINUTE` in `lib/constants.ts`). In Redis it is one Lua script per request (atomic, so concurrent requests cannot both take the last token, with the refill computed from Redis's clock); it has the same per-route namespacing and the same in-memory fallback on Redis errors as the sliding window. Bucket keys are `ratelimit:bucket:<METHOD>:<route>:<key>`. A request that takes a token but is then refused before any Stripe call is made (`503 STRIPE_BUSY`, or `503 STRIPE_CIRCUIT_OPEN` from a breaker that was already open) gives that token back (`refund` on the limiter, with its own Lua script on Redis; it returns one token to the same store and bucket the take came from, never above capacity, and at most once per request), so the retry the caller is told to make is not charged twice. A request whose Stripe call went out keeps its token, including a Stripe `429` and a call that timed out, as do requests that fail validation. If the refund itself fails the token stays spent.
- **Session Lookup** (`GET /payments/session/:sessionId`): 30 req/min per IP when anonymous. A request with an `X-Api-Key` header is authenticated with `requireApiKey` (a bad or inactive key is `401`, not a fall back to anonymous; each distinct key is charged to the client IP by `failureRateLimit` before its lookup, keyed by the key's SHA-256 lookup hash, 30 a minute: the same bad key repeated counts once, a charge is given back when the key is accepted or the lookup errors (500), and a blank or missing key is not counted; over 30 distinct keys a request with a key is refused with 429 before any lookup unless the key passed verification within `VERIFIED_KEY_TTL_MS`, and requests over budget while charges from this process are still in flight wait for them to settle; refusals are not counted. `requireApiKey` also remembers a lookup hash that matched no active client for `BAD_API_KEY_TTL_MS` (60 s) and answers repeats 401 without a lookup, cleared early when an admin PATCHes a client's status (`forgetBadApiKey`), so a reactivated client is refused for at most that long (a lookup that read the client as inactive before that PATCH and finishes after it records nothing); and concurrent verifications of the same key share one lookup, which is given up after `API_KEY_VERIFICATION_TIMEOUT_MS` (10 s): its entry is removed so the next request starts a fresh lookup, the requests waiting on it fail with `500` exactly as for a database error (not counted against the failed-auth budget, not recorded as a bad key), and a result that arrives after the timeout is discarded without touching the bad-key record or the verification cache. The database pool itself still has no query timeout), is limited to 600 req/min per client in its own bucket, and only sees its own client's sessions (another client's session is the same `404` as an unknown one).
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

### Authentication
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/auth/login` | Admin login: credentials checked against Nextcloud, returns a JWT (see "Admin login (Nextcloud)" in §2) | Public (5/15 min per IP, 10/15 min per username) |

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
| POST | `/accounts` | Create Stripe Express account + client + onboarding token (no email) | Admin JWT |
| POST | `/onboard-client/initiate` | Create Stripe Express account + client + onboarding/retrieval tokens + send email | Admin JWT |
| POST | `/onboard-client/resend` | Revoke old tokens + send a newly issued link (502 and new-token revocation if delivery fails) | Admin JWT |
| GET | `/onboard-client` | Get Stripe Account Link URL | Public (token) |
| GET | `/connect/callback` | Stripe Connect callback | Public |
| GET | `/connect/refresh` | Refresh expired account link | Public |

The two client-creation routes call Stripe before their atomic database write, without holding a transaction across the network call. A Stripe failure leaves no client row and returns no credentials (mapped Stripe errors such as `503 STRIPE_BUSY`, otherwise `502 STRIPE_FAILED`). A duplicate email is rejected with 409 before Stripe is called; the database unique constraint remains authoritative. A database failure after Stripe returned an account triggers best-effort account deletion; if deletion fails, the client and Stripe account IDs are logged at error level for reconciliation. An initiate email failure keeps the client and Stripe account but revokes exactly the newly issued onboarding and API-key retrieval tokens and returns `502 EMAIL_DELIVERY_FAILED`; recover with `/onboard-client/resend` (onboarding link) and `/api-key/regenerate-request/admin` (API key), not another initiate call. A resend email failure revokes its new token and returns the same 502 (older tokens stay revoked). If revoking an undelivered token fails, the response tells the admin to contact support. Legacy clients with no stored Stripe account are provisioned lazily when an Account Link is requested, and the link is created only after the account ID is confirmed persisted.

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

### Contact
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/contact` | Contact form submission (`company` required): emailed to `CONTACT_INBOX` and, when sales automation is ready, submitted as a lead to the New Lead form (honeypot hits get the same 201 and are dropped). 201 if at least one enabled channel succeeded, else 502 `EMAIL_DELIVERY_FAILED` | Public (rate-limited) |

### Nextcloud webhooks
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/webhooks/nextcloud/client-onboarding` | Trigger for the client onboarding (§10): starts a cycle, answers 202. The body is ignored. 404 when the onboarding or its webhook secret is not configured | `Authorization: Bearer <CLIENT_ONBOARDING_WEBHOOK_SECRET>` (rate-limited) |
| POST | `/webhooks/nextcloud/billing-request` | Trigger for the "New invoice" form (§14): starts a cycle, answers 202. The body is ignored. 404 when billing requests or their webhook secret are not configured | `Authorization: Bearer <BILLING_REQUESTS_WEBHOOK_SECRET>` (rate-limited) |

## 8. Swagger
Swagger UI is available at `/docs` when the backend is started with `ENABLE_SWAGGER=true`. It is disabled by default in production to keep the build lean.

## 9. Sales Lead Automation (Nextcloud)
When an operator submits the Nextcloud Form **DFWSC — New Lead**, the API creates, exactly once per submission:
1. a row in the Tables table **DFWSC — Sales Pipeline** (Stage `New Lead`; Owner is left empty for the operator to fill in, since the submitter is not necessarily the owner),
2. a vCard, only if a contact name, email or phone was given (email and phone go only on the vCard, never on the row). First every address book the service account can see (its own and those shared with it, found by a CardDAV `PROPFIND`; server-generated books such as `z-server-generated--system` are skipped) is searched for an existing card: by email, or without an email by company (ORG) and contact name. A card this submission itself created on an earlier attempt (UID `dfwsc-lead-<formId>-<submissionId>`) counts as ours and is never an ambiguity. Then:
   - *One match, in any book* (e.g. a Stripe-synced client in `contacts`): it is updated in place and the row's **Contact Card** links that card. `contactStatus = updated`. The merge is strictly additive on a card that is not ours: an existing name (FN/N) or company (ORG) is never replaced, existing email/phone values are kept, and only missing properties, new email/phone values and the `Lead` category are added. A book whose CardDAV privilege set lacks write access is read-only up front (a 403 on the write is the fallback): nothing is written or created, `contactStatus = read_only`, the existing card is linked, and a warning names the book.
   - *Several matches, even across books*: no card is created or changed (`contactStatus = ambiguous`, flagged for an operator), but the row and folder are still created, so the lead is never lost.
   - *No match*: a card is created in the `dfwsc-sales` address book (`contactStatus = created`).
   - A shared book that answers 403/404/410 to the card listing is skipped with a warning naming it and the status. Any other failure to list the books or a book (network, timeout, 5xx, 429) fails the step with `carddav.discovery_failed:<status>` and is retried; it never falls back to `dfwsc-sales` alone. A failure that is not transient, or one that outlasts every attempt, never costs the lead: the contact step is recorded as `contactStatus = failed` (logged at error level) and the row, folder and links are still created, so an operator can add the card by hand.
   - The address books and their cards are read once per cycle and a book is re-read after this sync writes to it, so several leads in one cycle do not re-download everything and a later lead sees a card created by an earlier one.
   The service account must be able to see (own or be shared) every address book it should dedupe against; `contacts` is shared read-only with `dfwsc-admin` as of 2026-10-31, so its cards are detected but not modified.
3. a folder `<SALES_LEADS_FOLDER>/<Company>/`, then fills the row's **Contact Card** and **Notes / Files** links.

**How it runs.** An in-process poller (`lib/sales-lead-sync.ts`, started from `index.ts` and stopped before the DB pool closes on shutdown) reads the form's submissions every `SALES_POLL_INTERVAL_MS`. There is no webhook route: Forms itself is the queue, so nothing is lost while Nextcloud or the API is down. On its first cycle for a form it records a baseline (`sales_lead_sync_state`), and submissions at or below it are never processed. Progress per submission lives in `sales_lead_submissions`. Each step's output (row id, contact UID, folder name, folder file id) is saved as soon as that step succeeds, so a retry resumes at the first missing step. Rows are claimed with a 10-minute lease (`FOR UPDATE SKIP LOCKED`), so overlapping cycles or replicas never process the same submission twice. Answers are never stored in Postgres; each attempt re-reads them from Forms.

**Exactly-once per step.**
- *Row*: the row's hidden **Lead Ref** column holds `<formId>:<submissionId>`. It is searched before every create, so a create whose response was lost is adopted rather than repeated.
- *vCard*: the UID is deterministic (`dfwsc-lead-<formId>-<submissionId>`) and the `PUT` uses `If-None-Match: *` (412 means it already exists).
- *Folder*: the chosen name is saved before `MKCOL`, so on a retry a 405 for that name is ours. A name already in use (same company, or a manual folder) gets the next free suffix, `Acme (2)`, `Acme (3)`, and a `duplicateCompany` warning is logged. Each submission still gets its own row.
- *Links*: the Contact Card and Notes / Files cells are written as `Title (https://…)`, the format Tables 2.4 stores (a JSON `{title, value, providerId}` value gets a 200 but nothing is saved). Tables converts it on write and returns each stored link cell as that JSON string, with slashes escaped as `\/`. The row is then read back, each link cell's `value` URL is parsed out, and `links_backfilled_at` is set only once both URLs are there; otherwise the attempt fails with `tables.link_not_persisted` and is retried.

**Titles, not ids.** Form questions (`Company`, `Contact name`, `Email`, `Phone`, `Source`, `Temperature`, `Estimated value`, `Next follow-up`, `Notes`) and table columns (`Company`, `Contact Name`, `Contact Card`, `Stage`, `Temperature`, `Source`, `Estimated Value`, `Next Follow-up`, `Notes / Files`, `Summary`, `Lead Ref`) are matched by exact title on each cycle. A missing title, or a Stage column with no `New Lead` option, stops the cycle with one error log until it is fixed. An answer that fits no option or value (e.g. an unknown Temperature) is left out of the row and its field name is logged.

**Website contacts become leads.** `POST /contact` (when `SALES_AUTOMATION_ENABLED` is ready, same gate as the poller) also POSTs the contact to the New Lead form as the service account (`lib/website-lead.ts`, `SalesLeadNextcloud.submitLead`, Forms v3 `POST /forms/{id}/submissions` with `{"answers": {"<questionId>": [value]}}`, via `nextcloudRequest`, so the breaker and timeouts apply). Questions are resolved by the same titles: Company, Contact name, Email, Notes from the form; Source is the dropdown option matching `/website/i` (or "Website" for a text question). With no such option or question, Source stays blank and Notes starts with `Source: website contact form`. The poller then handles it like any submission (no submitter filter; it is above the baseline). The form must allow repeated submissions (`submitMultiple` on) and have no submission cap or expiry, otherwise Forms rejects the service account's second submission and the lead channel fails (the email still goes out). Email and lead run in parallel; failures are logged per channel without the message. A missing or invalid `CONTACT_INBOX`/`SMTP_FROM` fails only the email channel, so the lead still goes through. The lead channel has a global cap of `WEBSITE_LEAD_CAP_MAX` (20) attempts per rolling hour (`lib/constants.ts`, in memory per process, so a restart resets it); beyond it the lead is skipped with a `contact.lead_cap_reached` warning and only the email is sent.

**Failures.** Network errors, timeouts, 5xx, 401, 408, 423, 425 and 429 are retried with backoff (1 min doubling, capped at 1 h) for up to 10 attempts, after which the submission becomes `failed`. Other 4xx (a share or id is wrong), a missing Company or a deleted submission fail immediately. While the Nextcloud circuit breaker (`lib/nextcloud.ts`, its own breaker, separate from Stripe and SMTP) is open, the cycle is skipped and no attempt is used. Logs contain only form, submission and row ids, step labels and error codes such as `tables.create_row:503`, never answers, names, emails, phone numbers, folder names or DAV paths.

**Environment variables** (all optional; the automation is off unless `SALES_AUTOMATION_ENABLED=true`, and then the rest are required. An invalid config is logged once at startup and the poller stays off; payments are never affected):

| Variable | Example | Notes |
|---|---|---|
| `NEXTCLOUD_BASE_URL` | `https://cloud.example.com` | HTTPS only |
| `NEXTCLOUD_USERNAME` | `dfwsc-admin` | Service account |
| `NEXTCLOUD_APP_PASSWORD` | `xxxxx-xxxxx-…` | App password, never logged |
| `SALES_AUTOMATION_ENABLED` | `true` | Default `false` |
| `SALES_LEAD_FORM_ID` | `12` | Form id (from the form's URL or `GET /ocs/v2.php/apps/forms/api/v3/forms?type=shared`) |
| `SALES_PIPELINE_TABLE_ID` | `8` | |
| `SALES_ADDRESSBOOK_PATH` | `dfwsc-sales_shared_by_messyginger0804` | The address book's collection name as the service account sees it |
| `SALES_LEADS_FOLDER` | `DFWSC Sales/Leads` | Relative to the service account's files root |
| `SALES_POLL_INTERVAL_MS` | `120000` | Default 120000, minimum 30000 |

**Nextcloud prerequisites.**
- The form owner shares the form with the service account with the **`results`** permission (Forms → Share → the user → enable "View responses"). Being a Nextcloud admin does not grant this.
- A **manage** share on the Sales Pipeline table, and a text column **Lead Ref** on it (it can be hidden from views).
- **Read-write** shares of the `dfwsc-sales` address book and the sales folder to the service account, accepted if shares need acceptance. Check the paths as the service account with `PROPFIND /remote.php/dav/addressbooks/users/<user>/` and `PROPFIND /remote.php/dav/files/<user>/` (a folder share may sit under `Shared/`).
- Nextcloud **cron** (background jobs) running normally. The poller does not depend on it, but share and file-cache maintenance does.

**Ops runbook.**
- *Watch*: `GET /api/v1/metrics` exposes `dfwsc_sales_lead_submissions{status=...}`, `dfwsc_sales_lead_last_cycle_ok`, `dfwsc_sales_lead_last_cycle_timestamp_seconds` and `dfwsc_nextcloud_circuit_open`. Alert on `failed` > 0 or a stale last cycle.
- *See failures*: `SELECT form_id, submission_id, attempts, last_error_code, updated_at FROM sales_lead_submissions WHERE status = 'failed';`
- *Retry a failed row* once the cause is fixed. Completed steps are kept, so it resumes where it stopped:
  `UPDATE sales_lead_submissions SET status = 'pending', attempts = 0, next_attempt_at = now(), claimed_at = NULL, claim_token = NULL WHERE form_id = <form> AND submission_id = <id>;`
- *Skip a submission for good*: leave it `failed`. To redo it from scratch, delete the Nextcloud row, contact and folder, then delete its `sales_lead_submissions` row. It is rediscovered only if its id is above every other known id, so normally re-insert it with `INSERT INTO sales_lead_submissions (form_id, submission_id) VALUES (<form>, <id>);`.
- *Empty links on early leads*: leads processed before the link-format fix have empty Contact Card and Notes / Files cells even though they are `completed`. Fill them by hand in Tables (folder: `<base>/index.php/f/<folder_file_id>`; contact: open it from the Contacts app).
- *Disable*: set `SALES_AUTOMATION_ENABLED=false` and redeploy or restart the `api` service. Nothing is lost: submissions made meanwhile are picked up when it is re-enabled (the baseline is kept).

## 10. Client Onboarding Automation (Nextcloud)
When an operator submits the Nextcloud Form **DFWSC — Convert Won Lead to Client** (form 2), the API does, exactly once per submission:
1. **Client folder**: `<CLIENT_ONBOARDING_CLIENTS_FOLDER>/<Company>/` with `Meetings/`, `Decisions/` and `Deliverables/` (the Client Projects folder layout). A returning client's existing folder is reused.
2. **Contact card**, ORG = company. It first looks for an existing card in **every** address book the service account (`NEXTCLOUD_USERNAME`) can see, found by a CardDAV `PROPFIND` (Depth 1) on its address book home, so books shared with it are included. Server-generated books (`z-server-generated--*`) are skipped. A card matches on the submitted email or, without an email, on company and contact name, counted across all books together:
   - *One match, in any book*: it is updated in place, in the book it lives in (e.g. a Stripe-synced card in `contacts`). The merge is strictly additive: an existing name (FN/N) or company (ORG) is never replaced, and only missing properties, new email/phone values and the `Client` category are added. A book whose privilege set lacks write access is treated as read-only up front, without a write attempt. If that book refuses the write (403, a read-only share), no card is created. The submission stores `contactStatus = read_only` with the card's UID, logs a warning naming the book, and the rest of the onboarding continues.
   - *Several matches, even across books*: none is changed (`contactStatus = ambiguous`).
   - *No match*: a card with UID `dfwsc-client-<formId>-<submissionId>` is created in the configured `CLIENT_ONBOARDING_ADDRESSBOOK_PATH` (`dfwsc-sales`).

   A shared book that answers 403/404/410 to the card listing is skipped with a warning naming it and the status. If the address books cannot be listed or another book cannot be read, the step fails with `carddav.discovery_failed` and is retried; it never falls back to the configured book alone, since that could duplicate a card. Logs name the address book (collection name only). The service account must be able to see (own or be shared) every address book it should dedupe against, and needs write access to be able to update a card there.
3. **Client Projects row** (Tables "Client Projects"): the next `CP-###` code, Project Name, Status *Intake*, Owner = the submitter (left empty for an anonymous submission), Start/Target Date, and Summary.
4. **Collectives page** `CP-### — <Project Name>` under **Projects** in the Client Projects collective, whose body is the Project Brief (with Teams on: the hub, see above) with links to the row, the client folder and the intake results. The row then gets its **Project Folder**, **Project Page** and **Intake Submission** links.
   **Per-project Teams** (only with `CLIENT_ONBOARDING_PROJECT_TEAMS=true`; with the flag off, steps 3a-3c and the hub below do not exist and nothing under `/circles`, `files_sharing` or collective creation is called). After the Projects row:
   - 3a. **Team**: dfwsc-admin creates a Nextcloud Team (Circles) named exactly `CP-### <Project name>` (the name is made file-name safe like the page title, because Collectives sanitises collective names the same way). Every id in `CLIENT_ONBOARDING_TEAM_ADMINS` is added and raised to level 8 (admin). The form submitter is added as a plain member, unless it is dfwsc-admin, already an admin from the list, or an anonymous submitter. dfwsc-admin stays the owner.
   - 3b. **Project wiki**: a collective with the same name. Collectives reuses a team of that name when the caller is its admin, so the wiki is built on the team from 3a (checked by team id; a different team fails with `collective_team_mismatch`). Its landing page gets the **Project Brief** (same content and seed/`If-Match` guards as step 4 describes), so the brief lives in the team's wiki.
   - 3c. **Folder share**: `<CLIENT_ONBOARDING_CLIENTS_FOLDER>/<Company>` is shared with the team (share type 7, permissions 15 = read, update, create, delete; no reshare).
   Step 4 is then a short **hub** instead of the brief: `# Project hub` with the project code and links to the team wiki, client folder, Projects row and the team. It follows the same no-overwrite guards.
5. **Sales Pipeline lead**: the row named by `lead_link` (a Tables row link `…/#/table/8/row/<id>` or `…/#/view/<v>/row/<id>`). Otherwise it is the row whose **Company** exactly equals `lead_link` (or, if that is empty, the company), compared case-insensitively with whitespace collapsed. That row gets Stage *Won* and a **Client Project** link to the new Projects row, but only if its current Stage is an open one: the table 8 option ids 0 New Lead, 1 Contacted, 2 Qualified, 3 Proposal Sent or 6 Nurture (hardcoded as `PROMOTABLE_STAGE_IDS`, the same set as the "Open Pipeline" view). A lead already *Won* (4) keeps its stage and only gets the link. A lead in *Lost* (5), with an empty Stage or with any other id is left completely untouched (no stage and no link write) and flagged with `leadStatus = ambiguous` and the lead row id; the log line has `reason: lead_stage_not_promotable` and the stage id. With no match, several matches, or a lead whose Client Project already links another project, nothing is changed. The submission still completes, with `leadStatus` `no_match`, `ambiguous` or `already_linked` for an operator.
6. **Billing Stripe Customer** (only with `CLIENT_ONBOARDING_BILLING_CUSTOMER=true`; runs last, after the Sales Pipeline step). DFWSC's own Customer on the platform Stripe account, used to bill the business for development work. It is separate from Stripe Connect: no `clients` row, no Express account, `stripeAccount` is never passed. Lookup order, keyed on the submitted email: `billing_customers` (lowercased), then `stripe.customers.list({ email, limit: 10 })` for the lowercased email and the raw trimmed one, deduplicated by id.
   - One match: reused and **not modified** in Stripe; the link lives only in `billing_customers` (`source = matched`). Several client codes may share one Customer.
   - Several matches: nothing is created, `billingStatus = ambiguous`, a PII-free warning is logged. The operator picks the Customer with the backfill script: put its id in the CSV `stripe_customer_id` column (below), e.g. `CP-004,ap@emmut.example,Emmut Properties Corp,cus_Abc123`.
   - No match: `customers.create` with `name` = company, `email`, metadata `client_code`, `source = dfwsc-onboarding`, `submission_id`, and idempotency key `onboarding-customer-<sha256(lowercased email)>` (`source = created`).
   - Billing email: an optional form question with Forms technical name `billing_email` (title "Billing email", short text, not required). When it holds a valid address it is used for the lookup and as the Customer email (and stored in `billing_customers.email`); empty, invalid (warning `billing_email_invalid`) or absent falls back to the contact email. Questions are matched by technical name, so no id or env setting is needed, and a form without it, or with other unknown questions, works unchanged.
   - No usable email (missing, or invalid for both billing and contact email, or rejected by Stripe as an invalid email): `billingStatus = no_email`, a PII-free warning, step done, no Customer is created.
   - A Stripe outage (connection, rate limit, 5xx) fails the attempt with `stripe.customer:<status>`; the submission stays `pending` and is retried with the usual backoff, earlier steps are skipped. Authentication/permission errors (401/403, e.g. a rotated key) are retried the same way until the attempt cap; other invalid-request errors are permanent (`failed`).
   - Backfill (clients onboarded earlier, and resolving `ambiguous` or `no_email`): the script ships in the API image (source `backend/src/scripts/backfill-billing-customers.ts`, compiled to `dist/scripts/backfill-billing-customers.js`), so it runs in the live container, which already holds `DATABASE_URL` and `STRIPE_SECRET_KEY`; no secret is copied anywhere. `--csv -` reads the CSV from stdin. Dry run: `docker exec -i <api container> node dist/scripts/backfill-billing-customers.js --csv - < customers.csv`; apply: the same with `--apply` added. Without a shell on the host, open the API application's terminal in the Coolify web UI and run `cat > /tmp/customers.csv` (paste, then Ctrl-D) followed by `node dist/scripts/backfill-billing-customers.js --csv /tmp/customers.csv [--apply]` (the container's `/tmp` is discarded on redeploy; delete the file afterwards). Local dev: `cd backend && npx tsx src/scripts/backfill-billing-customers.ts --csv customers.csv [--apply]`. `--help` needs no environment variables. The CSV has no quoting and the columns `client_code,email[,company][,stripe_customer_id]`: `email` is the billing email, `company` overrides the folder-derived name used when a Customer is created, and `stripe_customer_id` links exactly that Customer (it must exist and not be deleted; it is never modified). Dry run is the default. Before touching any Customer it prints the Stripe mode (live/test/restricted key), the platform account id, the database host and name, and whether `CLIENT_ONBOARDING_BILLING_CUSTOMER` is on (it does not need the flag). A row with no CSV `company` prints a note naming the fallback (folder name or client code). A dry run reports a pinned `stripe_customer_id` that is missing, deleted, or unreachable (key refused, network) distinctly, and an email Stripe rejects prints `invalid_email` (not counted as ambiguous). With `--apply` it also sets the submission's `billingStatus = linked` and `billingCustomerId`. `source` in `billing_customers` is `created`, `matched` (existing Customer found during onboarding) or `backfill` (linked by this script).

Contact details go only on the vCard, never on the Projects row or the page. The page holds the brief and links only, because status lives in Tables.

**How it runs.** The code is `lib/client-onboarding-sync.ts`, started from `index.ts` and stopped before the DB pool closes. Nextcloud's `webhook_listeners` app calls `POST /api/v1/webhooks/nextcloud/client-onboarding` on each form submission. The route rate limits and checks the shared secret in constant time in Fastify's `onRequest` hook, before the body is read, so a refused request (`404`, `401`, `429`) never buffers its body; then it starts a cycle and answers `202` straight away. It never reads the payload: the body is accepted with any or no `Content-Type` (`webhook_listeners` sends JSON without one, which Fastify would otherwise reject with 415) and dropped. Each cycle re-reads submissions from the Forms API. A poll runs the same cycle every `CLIENT_ONBOARDING_POLL_INTERVAL_MS` (default 5 min) as the safety net, so a lost webhook only delays a submission. One cycle runs at a time per process: triggers that arrive during a cycle are merged into one more cycle right after it. Everything else matches §9: the per-form baseline (`client_onboarding_sync_state`; submissions that exist when the automation first runs are skipped), per-step outputs in `client_onboarding_submissions` so a retry resumes at the first missing step, the 10-minute claim lease (`FOR UPDATE SKIP LOCKED`), the retry policy, the shared Nextcloud breaker, and PII-free logs.

**Form questions and columns.** Questions are matched by Forms *technical name*: `company`, `contact_name`, `email`, `phone`, `project_name`, `start_date`, `target_date`, `summary`, `lead_link`. `company`, `project_name` and `summary` are required, and a submission without one fails with `missing_<name>`. Columns are matched by exact title. In Projects: `Project Code`, `Project Name`, `Status` (needs an *Intake* option), `Owner`, `Start Date`, `Target Date`, `Project Folder`, `Project Page`, `Intake Submission`, `Summary`. In Sales Pipeline: `Company`, `Stage` (needs a *Won* option), `Client Project` (the legacy title `Cerebo Project` is also accepted). Any missing name, title or option stops the cycle with one error log.

**Exactly-once per step.**
- *Folder*: the name is saved before `MKCOL`, and an existing folder (405) is accepted.
- *Contact*: the search covers every visible address book (see step 2). The update uses `If-Match` with the card's ETag, so a card edited in between gives `carddav.contact_changed`, which is retried. A merge that changes nothing is not written. A create uses a fixed UID with `If-None-Match: *`.
- *Project code*: allocated once per submission inside a transaction holding `pg_advisory_xact_lock`. It is max(highest code ever allocated here, highest `CP-###` in the Projects table) + 1, written to the submission row in the same transaction. Codes are unique in Postgres and never reused, even when a submission later fails, so gaps are possible. A code typed into Tables by hand while an onboarding is in flight can still collide. The row check below catches that: the colliding code is burned, a fresh one above both the database and the table is allocated, and the attempt is retried.
- *Row*: before creating, the table is searched for the allocated code. A row with that code and the same Project Name is adopted (a create whose response was lost). A row with that code and a different name is never overwritten: the code is burned and replaced by a fresh one (never reused), and the attempt is retried. Each collision uses an attempt, so repeated collisions end in `failed` with `project_code_taken`. Several rows with that code and the same Project Name fail at once with `project_code_taken`.
- *Page*: before creating, a page with the same title under Projects is adopted. The body is then written once over WebDAV at `<collectivePath>/<filePath>/<fileName>` as reported by Collectives. It is the Project Brief (the team's `Project-Brief.md` template text, kept in `projectBriefContent`): a Field/Value table with Project code, Purpose (the form summary, escaped for a table cell), Target date (`YYYY-MM-DD` or blank), blank Owner, Success criteria and Constraints, then link rows Project row, Client folder and Intake results. The file is read first and written only if it is a seed (empty, whitespace-only, or just the page's own `# <title>` heading), with `If-Match` set to the ETag that was read (a leading `W/` added by Cloudflare is stripped; with no ETag the write is unguarded and a warning is logged). A page with other content, a missing file (404, warned), or a `412` from a concurrent edit (warned) is skipped and the step is recorded done (`page_content_at`), so human edits are never overwritten and a retry after a lost response does not write twice. A failed read or write is retried like the other Nextcloud steps. If the collective is not mounted in the service account's files (no `collectivePath`), the page is left empty and a warning is logged.
- *Team* (flag only): `team_members_at` marks the step done. Before creating, `GET /circles` is searched for a team with the exact name; one where dfwsc-admin is admin (8) or owner (9) is adopted (a create whose response was lost), one where it is not fails at once with `team_name_taken`. The id is saved as soon as the team exists (`team_id`). Members are then read (`GET /circles/{id}/members`) and only missing ones are added; a listed admin whose level is below 8 is raised, so a retry never duplicates a member. `team_members_at` is set last.
- *Project wiki* (flag only): `collective_id` is saved right after the collective exists; before creating, the collective list is searched for one built on this team id and reused. The landing page is the page with `parentId = 0`; the brief is written with the same guards as the page (only into an empty or title-only file, with `If-Match`), then `collective_content_at` marks it done. A landing page that already has text (for example a default welcome text) is left alone and the step is still recorded done.
- *Folder share* (flag only): `folder_share_id` marks it done. Before creating, the shares of the folder (`GET .../shares?path=`) are searched for a type 7 share with this team and reused.
- *Links* (Projects row and the lead's Client Project): written as `Title (https://…)` and read back, as in §9. Tables 2.4 stores and returns link cells as the JSON `{"title","value","providerId":"url"}`, but answers a write in that JSON form with 200 and stores nothing. A link that does not read back fails the attempt with `tables.link_not_persisted`, which is retried.

**Failures.** These are the same as §9. New Nextcloud calls are classified like the others (5xx, network, timeout, 401, 408, 423, 425, 429 retry; other 4xx fail at once). Two refusals are named so the log says what to change: `circles.create_forbidden` (Nextcloud refused to create a Team: allow dfwsc-admin to create Teams in the Teams app settings) and `files_sharing.create_forbidden` (sharing with Teams may be disabled on the server, or dfwsc-admin may lack share rights on the client folder). Both fail the submission at once; fix the cause and use the Retry statement below. `team_name_taken` and `collective_team_mismatch` also fail at once. Logs carry ids only (no team, project or user names). In addition, `missing_company`, `missing_project_name`, `missing_summary` and `submission_not_found` fail at once. `carddav.contact_changed`, `carddav.discovery_failed`, `tables.link_not_persisted` and a `project_code_taken` collision with a hand-made row are retried; `project_code_taken` fails at once only when several rows already hold our code with our name.

**Environment variables** (all optional; nothing runs unless `CLIENT_ONBOARDING_ENABLED=true`, and then all but the secret and interval are required. An invalid config is logged once at startup and nothing starts; payments are never affected. Uses the `NEXTCLOUD_*` service account from §9):

| Variable | Example | Notes |
|---|---|---|
| `CLIENT_ONBOARDING_ENABLED` | `true` | Default `false` |
| `CLIENT_ONBOARDING_FORM_ID` | `2` | Convert Won Lead to Client form |
| `CLIENT_ONBOARDING_PROJECTS_TABLE_ID` | `6` | Client Projects |
| `CLIENT_ONBOARDING_PIPELINE_TABLE_ID` | `8` | DFWSC — Sales Pipeline |
| `CLIENT_ONBOARDING_ADDRESSBOOK_PATH` | `dfwsc-sales_shared_by_messyginger0804` | Address book collection as the service account sees it |
| `CLIENT_ONBOARDING_CLIENTS_FOLDER` | `clients` | Parent of client folders, relative to the service account's files root (a share may appear as e.g. `Shared/clients`) |
| `CLIENT_ONBOARDING_COLLECTIVE_ID` | `1` | Client Projects |
| `CLIENT_ONBOARDING_WEBHOOK_SECRET` | `openssl rand -hex 32` | At least 32 characters. Unset: the webhook answers 404 and only the poll runs |
| `CLIENT_ONBOARDING_POLL_INTERVAL_MS` | `300000` | Default 300000, minimum 30000 |
| `CLIENT_ONBOARDING_PROJECT_TEAMS` | `true` | Default `false`. Per-project Teams, wiki and folder share (above). Only the exact value `true` turns it on |
| `CLIENT_ONBOARDING_BILLING_CUSTOMER` | `true` | Default `false`. Step 6, the billing Stripe Customer (below). Only the exact value `true` turns it on |
| `CLIENT_ONBOARDING_TEAM_ADMINS` | `ops-lead,Jane Doe` | Comma-separated Nextcloud user ids made team admins of every project team. Required (non-empty) when the flag is on, otherwise the config is invalid and nothing runs. Ids may contain spaces; only the ends are trimmed |

**Nextcloud admin setup.** Run these as the owner or an admin; the service account is `dfwsc-admin`.
1. **Form 2**: share it with `dfwsc-admin` with *View responses* (`results`). Already done.
2. **Table 6, Client Projects**: share it with `dfwsc-admin` with read, create and update. It must keep the column titles and the *Intake* status option above.
3. **Table 8, DFWSC — Sales Pipeline**: the existing share from §9 (manage) is enough. It must have the *Won* stage option and the *Client Project* link column (the legacy title *Cerebo Project* also works).
4. **`clients/`**: share the folder read-write (create + edit) with `dfwsc-admin` and accept the share if needed. Set `CLIENT_ONBOARDING_CLIENTS_FOLDER` to the path `dfwsc-admin` sees: `PROPFIND /remote.php/dav/files/dfwsc-admin/`.
5. **`dfwsc-sales` address book**: the existing read-write share from §9. Any other address book that may already hold the client (for example `contacts` with the Stripe-synced cards) must be owned by or shared with `dfwsc-admin`, otherwise it is not searched; share it read-write if cards there should be updated, read-only if they should only be detected.
   - *Status 2026-10-31*: the owner's `contacts` address book (holding the Stripe-synced cards) is being shared read-only with `dfwsc-admin`. Cards there are therefore detected, but a match gets `contactStatus = read_only` (logged with the book name), the card is not modified and no duplicate is created.
6. **Client Projects collective**: add `dfwsc-admin` to the collective's team as a member who can edit pages. Check that `GET /ocs/v2.php/apps/collectives/api/v1.0/collectives` as `dfwsc-admin` lists it (id 1) and that the page list shows a `collectivePath` such as `Collectives/Client Projects` (the URL slug, e.g. `Cerebo-Pilot`, may differ from the name) (otherwise pages are created empty).
7. **Webhook**: the `webhook_listeners` app must be enabled (it ships with Nextcloud 30+). Register the listener as an admin:
   ```sh
   curl -u <admin>:<app-password> -H 'OCS-APIRequest: true' -H 'Content-Type: application/json' \
     -X POST 'https://cloud.dfwsc.com/ocs/v2.php/apps/webhook_listeners/api/v1/webhooks' \
     -d '{"httpMethod":"POST",
          "uri":"https://<api-host>/api/v1/webhooks/nextcloud/client-onboarding",
          "event":"OCA\\Forms\\Events\\FormSubmittedEvent",
          "eventFilter":{"event.form.id":2},
          "authMethod":"header",
          "authData":{"Authorization":"Bearer <CLIENT_ONBOARDING_WEBHOOK_SECRET>"}}'
   ```
   Check it with `occ webhook_listeners:list`. Nextcloud sends webhooks from background jobs, so with cron every 5 minutes a call can be up to 5 minutes late. For faster delivery, run dedicated workers as described in the admin manual ("Speeding up webhook dispatch"): `occ background-job:worker -t 60 'OCA\WebhookListeners\BackgroundJobs\WebhookCall'`. Either way the poll covers a call that is late or never arrives.
8. **Per-project Teams** (only if `CLIENT_ONBOARDING_PROJECT_TEAMS=true`):
   - **Reshare on `/clients`**: dfwsc-admin must be allowed to reshare the clients folder, otherwise sharing a client folder with a team fails with `files_sharing.create_forbidden`. The share of `clients/` to dfwsc-admin needs the *Share* permission (and the folder owner must allow resharing); the team gets read, update, create and delete only.
   - **Team creation**: dfwsc-admin must be allowed to create Teams (Teams app admin settings), otherwise `circles.create_forbidden`.
   - **Collectives**: dfwsc-admin must be allowed to create collectives (it is the owner of the team, so it is admin and Collectives reuses the team).
   - `CLIENT_ONBOARDING_TEAM_ADMINS` must name existing users.
   - **Adding people to a project afterwards**: open the project's Team (Contacts app > Teams, linked from the hub page), add the person as a member. Membership gives them the wiki (it is the collective's team) and the shared client folder with no further step. Make them admin of the team to let them manage members.
9. Enable the flag after the shares exist (`CLIENT_ONBOARDING_ENABLED=true` plus the variables above) and redeploy. The first cycle records the baseline, so submissions made before that are not processed. Re-insert one with SQL (below) if needed.

**Ops runbook.**
- *Watch*: `GET /api/v1/metrics` exposes `dfwsc_client_onboarding_submissions{status=...}`, `dfwsc_client_onboarding_flagged` (completed, but the lead or contact needs a person), `dfwsc_client_onboarding_last_cycle_ok` and `dfwsc_client_onboarding_last_cycle_timestamp_seconds`.
- *Flagged*: `SELECT submission_id, project_code, lead_status, contact_status FROM client_onboarding_submissions WHERE lead_status <> 'won' OR contact_status IN ('ambiguous', 'read_only');` Fix the pipeline row or the card by hand. The submission stays `completed`.
- *Failures*: `SELECT submission_id, project_code, attempts, last_error_code FROM client_onboarding_submissions WHERE status = 'failed';`
- *Retry* once the cause is fixed (completed steps and the allocated code are kept):
  `UPDATE client_onboarding_submissions SET status = 'pending', attempts = 0, next_attempt_at = now(), claimed_at = NULL, claim_token = NULL WHERE form_id = <form> AND submission_id = <id>;`
- *Process an older submission*: `INSERT INTO client_onboarding_submissions (form_id, submission_id) VALUES (<form>, <id>);`
- *Rollout limits*:
  - Run a single API instance. The 10-minute claim lease is not renewed while a submission is processed, so a submission that takes longer than 10 minutes can be claimed again and processed twice (a second instance makes this more likely; the per-step claim token stops the first one from saving further output, but its Nextcloud writes may already have happened).
  - The first poll cycle after a deploy that enables the automation only records the baseline (§9). Submissions filed between the deploy and that first cycle are skipped, not processed. Re-insert one with the SQL below if needed.
- *Reset a failed submission*: use the Retry statement above. It returns the row to `pending` with the attempts cleared and keeps the completed steps and the allocated code, so the next cycle resumes at the first missing step. There is no API for this.
- *Disable*: set `CLIENT_ONBOARDING_ENABLED=false` and redeploy. The webhook then answers 404. Nothing is lost: the baseline is kept and the first cycle after re-enabling picks up submissions made meanwhile.

## 11. Contact Card to Billing Customer Sync (Nextcloud -> Stripe)
Edits made to a client's contact card in Nextcloud Contacts are pushed to the client's billing Stripe Customer (section 10 step 6; platform account, `stripeAccount` is never passed). Implementation: `backend/src/lib/contact-stripe-sync.ts` (poller, state, pushes), `contact-stripe-fields.ts` (card to Stripe field mapping) and the CardDAV sync helpers in `nextcloud-contacts.ts`. **Off by default** (`CONTACT_STRIPE_SYNC=true` turns it on). **Nextcloud wins**: nothing is ever written from Stripe back to Nextcloud.

- **Polling, nothing runs on Nextcloud.** Every `CONTACT_STRIPE_SYNC_INTERVAL_MS` (default 120000, minimum 10000) the API sends a CardDAV `sync-collection` REPORT (RFC 6578) for `CLIENT_ONBOARDING_ADDRESSBOOK_PATH` with the stored sync-token and handles only the cards changed since. Cycles never overlap (running/again guard). A cycle does a **full scan with an ETag compare** (REPORT with an empty token; cards whose ETag equals the recorded one are skipped) and **resets the token** when: no token is stored, the server refuses the token (403/400/409/410/412, i.e. `valid-sync-token`), or a linked card has no recorded state yet (a new link, or a Customer that changed). A retryable Stripe failure keeps the old token so the same delta is seen again next cycle.
- **Scope.** Only onboarding client cards: UID `dfwsc-client-<formId>-<submissionId>` in the onboarding address book, created by section 10 (`contactStatus = created`) and linked to a billing Customer. The link is resolved from `client_onboarding_submissions` (`contactUid` + `projectCode`) joined to `billing_customers` by client code (so links made by the backfill script work with no extra step), falling back to the submission's own `billingCustomerId` when `billingStatus = linked`. `stripe-cus_*` cards, cards matched in other books, unlinked cards, other books and a read-only onboarding book (the whole cycle is skipped with one log) are ignored.
- **Fields (Stripe's names).**
  - `name`: ORG, else FN.
  - `email`: the EMAIL labelled **Account email**, else the card's only EMAIL (the same address in several entries counts once). Several unlabelled, or an invalid address: unchanged, logged as `email_ambiguous` / `email_invalid`.
  - `phone`: the TEL labelled **Account phone**, else the only TEL, else unchanged (`phone_ambiguous`).
  - `address`: the ADR labelled **Billing address**, else the only ADR, else unchanged (`address_ambiguous`). Mapping: street -> `line1`; extended + PO box -> `line2`; locality -> `city`; region -> `state`; postal code -> `postal_code`; country -> 2-letter ISO code (names such as "United States", "USA", "UK", "Germany" are mapped; an unknown country is omitted from the push and logged as `country_unmappable`).
  - **A blank field never clears the Stripe field**, and only fields that changed are sent: `customers.update(id, { ...changed }, { idempotencyKey })`. The key is a hash of the Customer id, the card ETag and the pushed fields, so retrying one edit repeats the key while changing a value and changing it back (new ETag) is a new request that Stripe's 24h idempotency cache cannot swallow.
- **Labels in Nextcloud Contacts.** Open the contact, add the property (Email / Phone / Address), open the label dropdown of that entry, choose a custom label and type exactly `Account email`, `Account phone` or `Billing address` (case does not matter). Verified on the live instance, Contacts stores it as `NEXTCLOUD2.EMAIL;TYPE=HOME:...` plus `NEXTCLOUD2.X-ABLABEL:Account email` (TYPE stays alongside). The sync matches any group name and any case of `X-ABLabel` within the same group, and a `TYPE` parameter with the same text. The onboarding contact step writes the same form (`NEXTCLOUD<n>.EMAIL;TYPE=WORK:...` + `NEXTCLOUD<n>.X-ABLABEL:Account email`, `n` the next group the card does not use).
- **Baseline, no push on first sight.** The first time a linked card is seen, or right after a link is created, its per-field hashes and ETag are recorded **without pushing**. Customers created by hand in the Stripe dashboard (e.g. Emmut) are therefore never overwritten until someone edits the card; only later changes push. A card deleted in Nextcloud is reset and re-baselined if it comes back. Relinking a card to a different Customer re-baselines it.
- **Several client codes or cards on one Customer.** If two cards of the same Customer change in the same cycle they are applied in order of the card's REV (last change wins) and the cycle logs it. If an earlier one fails retryably, the later ones of that Customer wait for the next cycle so the order holds.
- **Errors.** Retryable (Stripe connection, rate limit, API/5xx, 409, 401/403): `last_error` is recorded, the card is retried next cycle. Non-retryable (e.g. 400 invalid request, missing Customer): `last_error` and `last_error_hash` are stored and the card is not retried until its content changes again (the hash differs). Nextcloud being down or the breaker open ends the cycle as `nextcloud_unavailable`; nothing is lost. Stripe calls are made directly on the platform client with its own timeout.
- **Logs** carry ids (contact UID, Customer id), field names, statuses and error codes only; never names, emails, phone numbers, addresses, answers or DAV paths. State holds hashes only.
- **Onboarding contact step change (section 10 step 2).** When the submission has a valid `billing_email` answer, the contact step also writes it to the card as an EMAIL labelled `Account email` (`NEXTCLOUD<n>.EMAIL;TYPE=WORK:...` + `NEXTCLOUD<n>.X-ABLABEL:Account email`). On a new card, when it equals the contact email, one labelled entry replaces the plain one. On a matched card the existing additive-merge rules apply: the entry is appended, an existing "Account email" entry is left alone, and a read-only book is not written. That append is the automation's own write, not a person's edit, so the card's sync state is reset (`baseline_reset_at` = database clock) and its next sighting is a baseline: it is never pushed to the Customer. Every state write of a cycle is conditional on `baseline_reset_at` not being later than the cycle's start, so a cycle that read the card before the append cannot write its stale baseline over the reset. The step resets before and after its write, and a cycle re-reads the card's state right before each push and skips it if the card was reset since the cycle started, so no window lets the appended entry be pushed; a write that fails leaves the card to be re-baselined.
- **Cycle claim and backoff.** Each cycle holds a Postgres session advisory lock on a dedicated pooled connection, so two API instances (deploy overlap, restart) never run a cycle at once; the loser skips with status `busy`, and the lock frees itself if the process dies. A connection whose unlock fails is destroyed instead of returned to the pool. A persistent Stripe 401/403 backs the sync off exponentially (one interval, doubling, capped at 30 minutes, in memory) until a push succeeds.
- **Address semantics.** Only non-blank address parts are sent (never empty strings, and an unmappable country is omitted), because Stripe merges the nested `address` hash by key on update and only an explicit empty value unsets a key.
- **Rollout.** Deploy with the flag off (the migration `0031_contact_stripe_sync` creates the state tables). Label the fields of the cards that need it in Nextcloud Contacts, set `CONTACT_STRIPE_SYNC=true` and redeploy: the first cycle baselines every linked card (full scan) and pushes nothing; edits after that push. Requires `NEXTCLOUD_*` and `CLIENT_ONBOARDING_ADDRESSBOOK_PATH`, not `CLIENT_ONBOARDING_ENABLED`. Disable: set the flag to `false`; state is kept, and on re-enable edits made while off are pushed only if the card's ETag changed since the last recorded state.

## 12. Portal Accounts Mirror (Portal -> Nextcloud Tables)

A read-only Nextcloud Table, **Portal Accounts**, shows the Stripe Connect side of the portal to the owner and managers without logging in to Stripe or the admin panel. Implementation: `backend/src/lib/portal-mirror-sync.ts` (config, provisioning, loop, reconcile), `portal-mirror-render.ts` (pure column and cell rendering), `portal-mirror-nextcloud.ts` (Tables calls). **Off by default** (`PORTAL_MIRROR=true`). **The database wins**: edits made in Nextcloud are overwritten. Strictly separate from the billing side (`billing_customers`, the contact sync, section 13): no shared rows. Payments are **not** mirrored row by row.

- **Table and sharing.** The API creates the table as the Nextcloud service account (`NEXTCLOUD_USERNAME`, the table owner), uses the table id it stored in `portal_mirror_state` (so a renamed table is not duplicated), else finds it by exact title (lowest id among tables it owns, with a warning when several match), else creates it; missing columns are re-created by title. This is re-checked every cycle with one `GET` of the columns: a table or column deleted in Nextcloud is re-provisioned on the next cycle without a restart, and a reconcile runs right after. An existing share to a group that grants more than read is only logged as a warning (not modified). and shares it **read-only** (`permissionRead` only, never create/update/delete/manage) with `PORTAL_MIRROR_SHARE_GROUPS` (default `dfwsc-admins,managers`; the shares list makes this idempotent). Tables REST v1 (`/index.php/apps/tables/api/1`): `GET/POST /tables`, `GET/POST /tables/{id}/columns`, `GET /tables/{id}/shares`, `POST /shares`, `GET/POST /tables/{id}/rows`, `PUT/DELETE /rows/{rowId}`. Fallback: `PORTAL_ACCOUNTS_TABLE_ID` uses a hand-made table whose column titles match (not shared by the API).
- **Columns.** Client ID (key), Name, Email, Group, Status, Stripe Account, Onboarding (Not started / Details needed / Under review / Ready), Charges Enabled, Payouts Enabled, Details Submitted (Yes/No text), Fee % and Fee $ (the fee a payment would use, same precedence as `resolveClientFee`: client percent, client cents, group percent, group cents, default percent, default cents), Last Payment, Payments (30d), DFWSC Fees (30d), Created, Updated. The client email is always shown (owner decision). Never rendered: phone, address, notes, API keys, payment metadata, individual payments.
- **Payment aggregates** are computed in SQL per client. A payment counts when its status is `paid`, or `refunded` with `refunded_amount_cents < total_amount_cents` (a partial refund); created, expired, failed, canceled, fully refunded and disputed never count. Fees are the gross `fee_amount_cents` (the ledger records no fee refunds, so refunds are not netted), USD only; a non-USD payment still counts in Payments (30d) and a PII-free warning is logged once per cycle.
- **Archived clients** are hidden by default (`PORTAL_MIRROR_INCLUDE_ARCHIVED`); archiving deletes the mirror row, the payments stay.
- **Change tracking** needs no trigger. A client is dirty when it has no `portal_mirror_rows` row, or the latest `updated_at` among the client and its group, or any of its payments (an index probe on `payment_ledger(client_id, updated_at)`), is newer than the row's `syncedAt` minus 5 minutes. Every Drizzle write bumps `updated_at` (the Node clock for `$onUpdate`, the database clock for inserts); `syncedAt` is the database clock, and the 5 minute overlap absorbs the skew and late commits. Not tracked by the watermark, so up to 24 h stale until the reconcile: a deleted group (`group_id` is cleared by the FK) and a change to the default fee settings. `content_hash` makes an unchanged render a no-op.
- **Loop.** Every `PORTAL_MIRROR_INTERVAL_MS` (60 s) under a session advisory lock, at most `PORTAL_MIRROR_BATCH` (25, max 100) rows per cycle, at most 5 Nextcloud calls per second, through a circuit breaker of its own (a Tables outage never trips the other Nextcloud syncs). A 429, 5xx, timeout, open breaker or 401/403 ends the cycle (401/403 also back off up to 30 minutes); another 4xx backs only that row off (1 min doubling to 1 h). A 404 on update re-creates the row. The first cycle after enabling is the backfill: everything is dirty and the batch limit paces it.
- **Daily reconcile** (at boot, then every 24 h): lists the table and re-renders every account (the 30 day window slides with no write at all), re-inserts rows deleted in Nextcloud, reverts hand edits, removes duplicates and rows without a client. The normal loop then rewrites what was marked, within its batch limit. It also catches raw SQL writes and a deleted group (which clears `clients.group_id` without touching `updated_at`).
- **Rollout.** Deploy with the flag off (migration `0032_portal_mirror` creates `portal_mirror_rows`). Make sure the Nextcloud groups exist, set `PORTAL_MIRROR=true`, redeploy. Disable: set it to `false`; the table and mapping stay.

## 13. Client Billing Mirror (Stripe billing Customers -> Nextcloud Tables)

A read-only Nextcloud Table, **Client Billing**, shows the billing state of DFWSC's own clients (Stripe Customers on the PLATFORM account, `billing_customers`) to the owner. Strictly separate from Stripe Connect (`clients`, `payment_ledger`). **Off by default** (`BILLING_MIRROR=true`). The database wins; edits made in Nextcloud are overwritten. Implementation: `backend/src/lib/billing-status.ts` (pure status rules), `billing-snapshot.ts` (Stripe reads and `billing_snapshots`), `billing-mirror-render.ts` / `billing-mirror-sync.ts` (table and loop), `mirror-table.ts` (provisioning, shares, advisory lock, row mapping and reconcile shared with the Portal Accounts mirror), `routes/webhooks-billing.ts` (docs/STRIPE.md).

- **Strictly read-only toward Stripe.** Per Customer: `subscriptions.list({status: "all", expand: ["data.schedule"]})`, `invoices.list` (paged) and `subscriptionSchedules.list({scheduled: true})` (schedules that have not started have no subscription yet). Draft, void and incomplete invoices and subscriptions are ignored. The result always comes from these lists, never from a webhook payload. Calls go through `withStripeCircuit`; a circuit-open, busy or 429 error ends the run, any other failure backs that Customer off (1 min doubling to 1 h, in process).
- **Status, first match wins.** **Late**: a subscription is `past_due` or `unpaid`; an open invoice with a balance is past its due date (Late starts the UTC day after `due_date`, no grace period); a `charge_automatically` open invoice has `attempt_count > 0`; an invoice is `uncollectible` (Late until voided). **Active**: a subscription is `active`, `trialing` or `paused`; a schedule is `not_started` or `active`; an open invoice is not yet due. **Ended**: a subscription or schedule was canceled or completed, or an invoice was paid, and nothing is live. **None**: nothing in Stripe. **Up to date** is No exactly when Overdue Amount is above 0 (open past-due or failed-attempt invoices plus uncollectible ones). Open Balance sums `amount_remaining` of open invoices; Next Due is the earliest of open invoices not yet due, the next renewal of a subscription that will renew and the start of a not-yet-started schedule. Amounts are USD only: when an open or overdue invoice is in another currency, the matching amount cell is blank and Status gets a "(non-USD)" suffix (Late stays Late).
- **Subscription text** like `$1,500/week for 20 weeks`: price x quantity per interval; the length comes from the schedule phases (`iterations`, else `end_date`), else the subscription's `cancel_at`, else it is open-ended (`$1,500/week`). **Payments Made** like `7 of 20` counts that subscription's invoices that are paid with `amount_paid > 0`. Several subscriptions are joined with `; `. Several client codes on one Customer each get a row with the same data and a note in the Client cell.
- **Columns.** Client, Client Code (key), Up to date, Status, Subscription, Payments Made, Amount Paid, Next Due, Open Balance, Overdue Amount, Last Payment, Stripe Customer (`https://dashboard.stripe.com/customers/<id>` as text), Updated (last content change), Last Checked (last successful refresh). Money cells are `$` numbers with 2 decimals; dates are `YYYY-MM-DD HH:mm` UTC.
- **Staleness is visible.** Every `billing_customers` client code has a row. Before its first successful refresh the row says Status "Pending" (other cells blank), or "Check failed" when that first refresh failed. When a refresh fails after a success the row shows "Check failed (was Active)" with Up to date blank and the last good figures. Both change the content hash, so the row is rewritten; Last Checked tells how old the data is. Customers are refreshed stalest first, so a sweep cut short by a 429 continues with the ones it did not reach. `customer.deleted` marks the row dirty and the next refresh shows "Check failed".
- **Table and sharing** as section 12 (title lookup, id stored in `portal_mirror_state` as `billing_table_id`, read-only shares), with `BILLING_MIRROR_SHARE_GROUPS` (default `dfwsc-admins,managers`, both read-only).
- **Refresh and sweep.** A webhook only sets `billing_snapshots.dirty_at`. Each mirror cycle (`PORTAL_MIRROR_INTERVAL_MS`, 60 s) first refreshes dirty snapshots and Customers with no snapshot yet; at boot and every `BILLING_SWEEP_INTERVAL_MS` (1 h) every Customer is refreshed, which also covers a missing webhook endpoint and invoices that become overdue with no event. One Customer at a time, 250 ms apart, under an advisory lock. `billing_snapshots.updated_at` moves only when the content hash does.
- **Mirror loop.** Every cycle re-renders every row (one query) and writes only rows whose content hash differs from `portal_mirror_rows.content_hash` (`kind = 'billing'`), at most `PORTAL_MIRROR_BATCH` per cycle; per-row backoff, outage handling and the daily reconcile are those of section 12, with their own advisory lock (`billing_mirror_cycle`) and a Tables circuit breaker of its own.
- **Rollout.** Deploy with the flag off (migration `0033_billing_snapshots`). Create the account-level Stripe endpoint and set `STRIPE_BILLING_WEBHOOK_SECRET` (docs/STRIPE.md; optional, the sweep works without it), set `BILLING_MIRROR=true`, redeploy. Disable: set it to `false`; the table, snapshots and mapping stay. The API boots regardless of this configuration.

## 14. New Invoice Form (Nextcloud -> Stripe invoices and plans)
**These are real invoices on DFWSC's live Stripe account.** Each submission of the Nextcloud Form **New invoice** creates, exactly once, either a one-off invoice or a recurring plan for a client in `billing_customers` (DFWSC's own billing Customers on the platform account; Stripe Connect is never involved and no call passes a connected account). Off unless `BILLING_REQUESTS_ENABLED=true`; the API boots whatever the configuration (a bad one is logged and the feature stays off).

**Flow.** Same model as §10: Forms is the queue, progress per submission lives in `billing_request_submissions`, rows are claimed with a lease, a Nextcloud webhook (`POST /webhooks/nextcloud/billing-request`) only asks for a cycle to run now and a poll (`BILLING_REQUESTS_POLL_INTERVAL_MS`, default 5 min) runs one anyway, so a lost webhook delays a request but never loses it. Two rules keep old answers from being billed. Submissions that already exist when the form is **first** read are skipped (baseline in `billing_request_sync_state`, kept for good). And a submission whose Forms timestamp is older than `BILLING_REQUESTS_MAX_AGE_HOURS` (default 72) is marked **Expired** (`request_expired`) with no Stripe call, so submissions made while the feature was switched off are not billed when it is switched back on; resubmit if one is still wanted. The age limit never applies to a request Stripe was already called for: that one is resumed whatever its age.

**One-off invoice.** `invoices.create` (customer, `usd`, `send_invoice`, `days_until_due` = `BILLING_DEFAULT_DAYS_UNTIL_DUE`, `pending_invoice_items_behavior: exclude`, `auto_advance: false`, memo as the description, metadata `nc_form`, `nc_submission`, `client_code`), then `invoiceItems.create` for the one line, then, when `BILLING_AUTO_SEND` is on (default), `finalizeInvoice` and `sendInvoice`. Status **Sent**; with auto-send off the invoice stays a draft in Stripe and the status is **Draft created**.

**Recurring plan.** One Product per submission, then a Subscription Schedule starting at the start date 09:00 America/Chicago, `end_behavior: cancel`, `send_invoice` collection, and one phase with the price inline. The phase length is `duration: { interval, interval_count }` (payments x the interval), **not `iterations`**: on the pinned Stripe API version (`2025-09-30.clover`, stripe-node 19) a phase takes `duration` or `end_date` and `iterations` no longer exists. Weekly x 20 is `{ interval: week, interval_count: 20 }`, every 2 weeks x 10 is `{ week, 20 }`, monthly x 12 is `{ month, 12 }`. Status **Scheduled**. Stripe creates and emails each invoice itself (Dashboard: Settings > Billing > Subscriptions and emails > "Email finalized invoices"), `BILLING_AUTO_SEND` does not apply to plans.

**Validation** (a refused request never reaches Stripe, is marked `failed` with a code and is not retried; resubmit the form to try again. This applies only to a request with **no Stripe link** in the result table: one that has a link exists in Stripe, so finish or void it in the Dashboard instead of resubmitting):

| Code | Meaning |
|------|---------|
| `unauthorized` | Anonymous or unknown submitter, or not in `BILLING_REQUESTS_ALLOWED_GROUPS` |
| `unknown_client_code` | `client_code` is not in `billing_customers` (case-insensitive) |
| `company_mismatch` | `company` differs from `billing_customers.company` after ignoring case, repeated spaces and trailing punctuation ("Emmut Properties Corp" = "Emmut Properties Corp.") |
| `invalid_amount`, `amount_too_large` | Amount not `^\d{1,6}(\.\d{2})?$`, zero, or above `BILLING_MAX_AMOUNT_CENTS` (default 2,500,000 = $25,000, per invoice or per plan payment) |
| `invalid_kind`, `invalid_description`, `invalid_memo`, `invalid_client_code`, `missing_company` | Missing or malformed answer (description max 250 characters, memo max 1000) |
| `missing_interval`, `invalid_interval` | Plan without a valid interval |
| `invalid_payments` | Payments not a whole number from 2 to 104 |
| `invalid_start_date`, `start_date_out_of_range` | Not a real date, or outside tomorrow to +90 days (America/Chicago, judged at the submission time) |
| `start_date_passed` | The start time passed before the schedule was created. If an earlier attempt may have sent the create, Stripe is searched first and a schedule found is adopted instead |
| `request_expired` | Older than `BILLING_REQUESTS_MAX_AGE_HOURS` and Stripe was never called for it (status Expired) |
| `customer_no_email`, `customer_missing` | The Customer in Stripe has no email, or is deleted or gone. Checked with a read before anything is created, so nothing exists to clean up |
| `unknown_client_code`, `ambiguous_client_code` | Codes are compared trimmed and upper-cased on both sides; two clients whose codes differ only in case are refused, not guessed |
| `submission_not_found` | The submission was deleted before it was read |

**Authorization.** The form is restricted to Nextcloud groups (below) and the API checks again: the submitter's user id must be in one of `BILLING_REQUESTS_ALLOWED_GROUPS` (default `dfwsc-admins,managers`), read with `GET /ocs/v2.php/cloud/users/{userId}/groups` (the service account `dfwsc-admin` is a Nextcloud admin). Anonymous (`anon-user-*`), unknown (404) and non-member submitters fail with `unauthorized`. If the groups lookup itself is unavailable the request is retried, not refused.

**Retries.** Stripe 429, 5xx, no answer, 409 (same idempotency key still in flight) and an open Stripe circuit breaker are retried with backoff (1 min doubling to 1 h, at most 10 attempts; an open breaker also stops the cycle so the rest wait untouched). Any other Stripe 4xx fails the request (`stripe.<step>:<status>`). Nextcloud errors are retried the same way.

**Finalized, not sent.** If the invoice was finalized but the send fails, a retryable error (429, 5xx, no answer) is retried on later cycles for the saved invoice id only (finalize is never repeated); once retries are used up, or on a permanent error, the table shows **Finalized, not sent** with the invoice link and the error code. That invoice is open and collectible in Stripe: **never resubmit the form**, send it from the Stripe Dashboard (or void it there).

**Idempotency and resuming.** Every Stripe call carries the key `ncbill-{formId}-{submissionId}-{step}` (`invoice`, `item`, `finalize`, `send`, `product`, `schedule`) and the id of each created object is saved in `billing_request_submissions` right away, so a retry reuses it and resumes (for example the invoice exists but the item does not). Order for every object: the saved id; then, if an earlier attempt may have sent the create (its answer or id may have been lost), a lookup by metadata `nc_form` + `nc_submission` (paginated `invoices.list` and `subscriptionSchedules.list` for that Customer since the request was made, `invoiceItems.list` for the invoice, `products.search`), adopting what is found; only then validation that depends on time (start date passed) and the create. This runs on every retry, not only past Stripe's 24 hour key window, and the key still protects a create inside it. After a lost response the invoice email can in the worst case be sent twice, never zero times. Nothing existing is ever updated, voided or cancelled: the API only creates.

**Result table.** A read-only Nextcloud Table **Billing Requests**, created and shared by the API (same helper as §12 and §13) to `BILLING_REQUESTS_SHARE_GROUPS` (default `dfwsc-admins,managers`; read-only). One row per request: Submitted, By (Nextcloud user id), Client Code, Type, Amount, Plan (for example `$1,500 weekly × 20 from 2026-11-03`), Status (Processing, Sent, Draft created, Scheduled, Finalized not sent, Expired, Failed), Error (code only) and Stripe (Dashboard link to the invoice or schedule; kept on a failed request that got as far as creating one). A request that Stripe completed is never shown as Failed because the table could not be written: that part is retried on its own. After a success the client's `billing_snapshots` row is marked dirty, so **Client Billing** (§13) refreshes within a minute. Logs carry ids and codes only, never names, descriptions or amounts.

**Environment.** `BILLING_REQUESTS_ENABLED` (default false), `BILLING_REQUESTS_FORM_ID`, `BILLING_REQUESTS_WEBHOOK_SECRET` (32+ characters; unset = webhook answers 404, poll only), `BILLING_REQUESTS_POLL_INTERVAL_MS` (300000, min 30000), `BILLING_REQUESTS_ALLOWED_GROUPS`, `BILLING_REQUESTS_SHARE_GROUPS`, `BILLING_REQUESTS_MAX_AGE_HOURS` (72), `BILLING_MAX_AMOUNT_CENTS` (2500000), `BILLING_AUTO_SEND` (true), `BILLING_DEFAULT_DAYS_UNTIL_DUE` (7). Needs `NEXTCLOUD_*`.

**Known limits.** The amount cap is per invoice or per plan payment; there is no cap on a plan's total (payments x amount, up to 104 x $25,000), so keep the form restricted. Answers are re-read on every attempt and not snapshotted: keep "Allow editing responses" **off** on the form, because an edit during a retry changes the parameters of an idempotent call (Stripe then refuses it and the request fails).

### Form setup (exact)
Create the form in Nextcloud Forms as `dfwsc-admin`, title **New invoice**. Questions are found by their **technical name** (Question settings > Technical name), not by title or position; extra questions are ignored and radio options are matched by their text (case and spacing ignored).

| # | Title (suggested) | Type | Technical name | Required | Notes |
|---|-------------------|------|----------------|----------|-------|
| 1 | Client code | Short text | `client_code` | yes | for example `CP-004` |
| 2 | Company | Short text | `company` | yes | must match the client's company (typo guard) |
| 3 | What are you creating? | Multiple choice (radio) | `kind` | yes | options exactly `One-off invoice` and `Recurring plan` |
| 4 | Description | Short text | `description` | yes | the invoice line, or the plan name; max 250 characters |
| 5 | Amount (USD) | Short text | `amount_usd` | yes | digits only: `1500` or `1500.00`, no `$` or commas. Per invoice, or per payment of a plan |
| 6 | Interval (plans only) | Multiple choice (radio) | `interval` | no | options exactly `Weekly`, `Every 2 weeks`, `Monthly` |
| 7 | Number of payments (plans only) | Short text | `payments` | no | whole number 2 to 104 |
| 8 | Start date (plans only) | Date | `start_date` | no | tomorrow to 90 days ahead (America/Chicago); the first invoice is created at 09:00 Chicago time |
| 9 | Memo | Long text | `memo` | no | optional; becomes the invoice description (and the plan description) |

The API refuses to process anything (and logs which names) while questions 1 to 8 are missing. Turn on "Allow multiple responses per user" (operators submit many requests) and keep the form non-anonymous and not public: an anonymous submission is refused with `unauthorized`.

1. **Restrict who can submit**: Share > "Share with groups/users": `dfwsc-admins` and `managers` only; no public link. (The API checks the same groups again.)
2. **Share the responses with `dfwsc-admin`** (the service account) with the **"View responses"** permission: the API reads the submissions with its app password. Without it every read answers 403 and nothing is processed.
3. Note the form id (the number in `.../apps/forms/<id>/...`) for `BILLING_REQUESTS_FORM_ID`.
4. **Register the webhook listener** (the `webhook_listeners` app, as in §10 step 7), as a Nextcloud admin:
   ```sh
   curl -u <admin>:<app-password> -H 'OCS-APIRequest: true' -H 'Content-Type: application/json' \
     -X POST 'https://cloud.dfwsc.com/ocs/v2.php/apps/webhook_listeners/api/v1/webhooks' \
     -d '{"httpMethod":"POST",
          "uri":"https://<api-host>/api/v1/webhooks/nextcloud/billing-request",
          "event":"OCA\\Forms\\Events\\FormSubmittedEvent",
          "eventFilter":{"event.form.id":<form id>},
          "authMethod":"header",
          "authData":{"Authorization":"Bearer <BILLING_REQUESTS_WEBHOOK_SECRET>"}}'
   ```
   It is optional: without it the poll picks submissions up within `BILLING_REQUESTS_POLL_INTERVAL_MS`.
5. Set the environment, deploy, then set `BILLING_REQUESTS_ENABLED=true`. The first cycle records the baseline and creates the **Billing Requests** table (shared read-only).
