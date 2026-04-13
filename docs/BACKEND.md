# Backend Architecture

This document details the backend implementation, API design, and core logic for the DFWSC Payment Portal.

## 1. Overview
The backend is a **Fastify 5** application written in **TypeScript**, using **Node.js 20**. It follows a controller-service pattern where routes handle HTTP concerns and `lib/` handles core business logic (Stripe, Mailer, etc.).

## 2. Request Authentication
Two distinct schemes are implemented:

- **Client-Facing Routes** (`POST /payments/create`):
  - Uses `X-Api-Key` header.
  - Verification: `apiKeyLookup` (SHA256) for O(1) DB lookup + `apiKeyHash` (bcrypt) for secure verification.
- **Admin Routes**:
  - Uses JWT Bearer tokens obtained from `POST /api/v1/auth/login`.
  - Claims must include `role: "admin"`.

## 3. Core Flows

### Payment Flow (Stripe Connect)
The `USE_CHECKOUT` environment variable toggles between two modes:
- **`USE_CHECKOUT=true`**: Creates a **Checkout Session** and returns a redirect URL.
- **`USE_CHECKOUT=false`**: Creates a **PaymentIntent** and returns a `clientSecret` for Stripe Elements.

All payments resolve platform fees via a 5-level priority chain:
1. Client `processingFeePercent`
2. Client `processingFeeCents`
3. Group `processingFeePercent`
4. Group `processingFeeCents`
5. Global `DEFAULT_PROCESS_FEE_CENTS`

### Onboarding Flow
1. **Initiation**: `POST /api/v1/onboard-client/initiate` creates a pending token.
2. **Onboarding**: Client visits `/onboard?token=...`, triggering Stripe Account/Link creation.
3. **Completion**: Stripe redirects to `/api/v1/connect/callback`, which marks the token `completed` and links the `stripeAccountId`.

## 4. Rate Limiting
- **Implementation**: In-memory sliding-window limiter (`lib/rate-limit.ts`).
- **Admin/Onboard Routes**: 10 req/min per IP.
- **Payment Routes**: 20 req/min per Stripe Account ID (fallback to IP).

## 5. Workspace Separation
All client-facing entities include a `workspace` field that separates:
- **`client_portal`** — External consulting clients
- **`dfwsc_services`** — Internal DFWSC service clients

Routes like `/clients` and `/dfwsc-clients` provide filtered access by workspace.

## 6. API Route Map
All routes are prefixed with `/api/v1`.

### Public Routes
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/config` | Public config (useCheckout flag) |
| GET | `/auth/setup/status` | Check if setup is needed |

### Authentication
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/auth/login` | Admin login (returns JWT) | Public |
| POST | `/auth/setup` | First-run setup (legacy) | Public |
| POST | `/auth/confirm-bootstrap` | Finalize admin setup | Public |

### Clients & Groups
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/clients` | List clients | Admin JWT |
| POST | `/accounts` | Create client | Admin JWT |
| PATCH | `/clients/:id` | Update client | Admin JWT |
| GET | `/dfwsc-clients` | List DFWSC workspace clients | Admin JWT |
| GET | `/groups` | List groups | Admin JWT |
| POST | `/groups` | Create group | Admin JWT |
| PATCH | `/groups/:id` | Update group | Admin JWT |

### Onboarding
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/onboard-client/initiate` | Send onboarding email | Admin JWT |
| POST | `/onboard-client/resend` | Resend onboarding email | Admin JWT |
| GET | `/onboard-client` | Get Stripe onboarding link | Public (token) |
| GET | `/connect/callback` | Stripe Connect callback | Public |
| GET | `/connect/refresh` | Refresh account link | Public |

### Payments & Billing
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/payments/create` | Create payment | API Key |
| GET | `/reports/payments` | List payments | Admin JWT |
| GET | `/invoices` | List invoices | Admin JWT |
| POST | `/invoices` | Create invoice | Admin JWT |
| PATCH | `/invoices/:id` | Cancel invoice | Admin JWT |
| GET | `/invoices/pay/:token` | Get invoice by token | Public |
| POST | `/invoices/pay/:token` | Submit invoice payment | Public |
| GET | `/subscriptions` | List subscriptions | Admin JWT |
| POST | `/subscriptions` | Create subscription | Admin JWT |
| GET | `/subscriptions/:id` | Get subscription details | Admin JWT |
| PATCH | `/subscriptions/:id` | Update subscription | Admin JWT |

### Stripe Management
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/products` | List Stripe products | Admin JWT |
| POST | `/products` | Create Stripe product | Admin JWT |
| GET | `/stripe-customers` | List Stripe customers | Admin JWT |
| POST | `/stripe-customers` | Create Stripe customer | Admin JWT |

### System
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/settings` | Get system settings | Admin JWT |
| POST | `/webhooks/stripe` | Stripe webhooks | Stripe Signature |

For complete endpoint details, see `API_DOCS.md`.
