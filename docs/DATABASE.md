# Database Architecture

This document describes the data model, Drizzle ORM usage, and migration strategy for the DFWSC Payment Portal.

## 1. Overview
The project uses **PostgreSQL 17** with the **Drizzle ORM**. All schema definitions are centralized in `backend/src/db/schema.ts`.

## 2. Core Tables

### `clients`
The primary entity for each consultant's client.
- **Keys**: `id` (UUID), `name`, `email`.
- **Credentials**: `apiKeyHash` (bcrypt), `apiKeyLookup` (SHA256).
- **Stripe**: `stripeAccountId` (linked Express account).
- **Pricing**: `processingFeePercent`, `processingFeeCents`.

### `client_groups`
Allows grouping multiple clients to share configuration.
- Shared settings for fees and URLs (`paymentSuccessUrl`, etc.).

### `onboarding_tokens`
Manages the lifecycle of Stripe Connect onboarding sessions.
- **Statuses**: `pending`, `in_progress`, `completed`.
- **State**: Includes a CSRF `state` with a 30-minute expiry.

### `subscriptions` & `invoices`
- **Subscriptions**: Defines recurring amounts and intervals.
- **Invoices**: Tracks individual billing records. Tokens are unique for public payment access.

### `webhook_events`
- An **idempotency table** used to de-duplicate Stripe webhook notifications.

## 3. Tooling & Migrations
- **Schema Changes**: Modify `backend/src/db/schema.ts`.
- **Generate**: `npm run db:generate` (creates SQL in `backend/drizzle/`).
- **Apply**: `npm run db:migrate` (uses `migrate.ts` script).

## 4. Idempotency Strategy
All Stripe operations, including webhook handling, are guarded by `Idempotency-Key` headers or the `webhook_events` table to prevent duplicate processing.
