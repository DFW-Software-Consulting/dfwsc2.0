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

## 5. API Route Map
All routes are prefixed with `/api/v1`.

| Method | Path | Auth |
|--------|------|------|
| GET | `/health` | Public |
| POST | `/auth/login` | Public |
| GET | `/clients` | Admin |
| POST | `/payments/create` | API Key |
| POST | `/webhooks/stripe` | Stripe Signature |
| ... | (See CLAUDE.md for full list) | ... |
