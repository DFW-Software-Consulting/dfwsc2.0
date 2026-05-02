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
The `USE_CHECKOUT` environment variable toggles between two modes:
- **`USE_CHECKOUT=true`**: Creates a **Checkout Session** and returns a redirect URL.
- **`USE_CHECKOUT=false`**: Creates a **PaymentIntent** and returns a `clientSecret` for Stripe Elements.

All payments resolve `application_fee_amount` via a 4-level priority chain:
1. Client `processingFeePercent`
2. Client `processingFeeCents`
3. Group `processingFeePercent`
4. Group `processingFeeCents`

If none are set, no fee is applied (no global fallback).

### Onboarding Flow
1. **Create client**: `POST /api/v1/accounts` creates a client record + pending onboarding token in one transaction, returns `apiKey`, `clientId`, and `onboardingToken`.
2. **Send email**: `POST /api/v1/onboard-client/initiate` does the same but also emails the client.
3. **Resend**: `POST /api/v1/onboard-client/resend` revokes active tokens and issues a new one with a fresh email.
4. **Onboard**: `GET /api/v1/onboard-client?token=...` creates a Stripe Express Account (if not already) and returns an Account Link URL.
5. **Callback**: Stripe redirects to `GET /api/v1/connect/callback` with `client_id`, `account`, and `state`. Validates CSRF state, links `stripeAccountId` to client, marks token `completed`, redirects browser to `/onboarding-success`.
6. **Refresh**: `GET /api/v1/connect/refresh?token=...` regenerates an expired account link and redirects the client.

## 4. Rate Limiting
- **Implementation**: In-memory sliding-window limiter (`lib/rate-limit.ts`).
- **Admin/Onboard Routes**: 10 req/min per IP.
- **Resend Route**: 5 req/min per IP.
- **Payment Routes**: 20 req/min per Stripe Account ID (fallback to IP).

## 5. Workspace
All clients and groups belong to the `client_portal` workspace. The `workspace` query parameter is required on all admin list endpoints and validated server-side.

## 6. API Route Map
All routes are prefixed with `/api/v1`.

### Public Routes
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/config` | Public config (`useCheckout` flag) |
| GET | `/auth/setup/status` | Check if admin setup is needed |

### Authentication
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/auth/login` | Admin login (returns JWT) | Public |
| POST | `/auth/setup` | First-run admin creation | Public |
| POST | `/auth/confirm-bootstrap` | Finalize admin setup | Public |

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
| POST | `/payments/create` | Create PaymentIntent or Checkout Session | API Key or Admin JWT |
| GET | `/reports/payments` | List Stripe PaymentIntents by client or group | Admin JWT |

### Products & Settings
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/products` | List Stripe products | Admin JWT |
| POST | `/products` | Create Stripe product | Admin JWT |
| GET | `/settings` | Get system settings | Admin JWT |
| POST | `/webhooks/stripe` | Stripe webhook handler | Stripe Signature |

## 7. Swagger
Swagger UI is available at `/docs` when the backend is started with `ENABLE_SWAGGER=true`. It is disabled by default in production to keep the build lean.
