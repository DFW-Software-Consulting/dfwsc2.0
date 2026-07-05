# Database Architecture

This document describes the data model, Drizzle ORM usage, and migration strategy for the DFWSC Payment Portal.

## 1. Overview
The project uses **PostgreSQL 17** with **Drizzle ORM**. All schema definitions live in `backend/src/db/schema.ts`.

## 2. Core Tables

### `clients`
The primary entity for each consulting client.

- **Keys**: `id` (text, UUID), `name`, `email`.
- **Workspace**: `workspace` — always `"client_portal"`.
- **Credentials**: `apiKeyHash` (bcrypt), `apiKeyLookup` (SHA256 — fast lookup index).
- **Stripe**: `stripeAccountId` (linked Express account), `stripeCustomerId`.
- **Status**: `"active"`, `"inactive"`, `"pending"`, `"failed"`.
- **Group**: `groupId` (optional FK → `client_groups.id`).
- **Pricing**: `processingFeePercent`, `processingFeeCents` (set one, not both).
- **URLs**: `paymentSuccessUrl`, `paymentCancelUrl`.
- **Contact**: `phone`, `billingContactName`.
- **Address**: `addressLine1`, `addressLine2`, `city`, `state`, `postalCode`, `country`.
- **Billing**: `defaultPaymentTermsDays`.
- **Notes**: `notes` (free-form admin text).
- **Timestamps**: `createdAt`, `updatedAt`.

**Indexes:**
- `clients_api_key_hash_idx` — API key verification
- `clients_api_key_lookup_idx` — SHA256 fast lookup
- `clients_email_workspace_unique` — unique email per workspace

### `client_groups`
Groups multiple clients to share fee and redirect URL configuration.

- **Workspace**: always `"client_portal"`.
- **Status**: `"active"` or `"inactive"`.
- **Shared config**: `processingFeePercent`, `processingFeeCents`, `paymentSuccessUrl`, `paymentCancelUrl`.

### `onboarding_tokens`
Manages the lifecycle of a client's Stripe Connect onboarding session.

- **Statuses**: `pending` → `in_progress` → `completed` (or `revoked` on resend).
- **CSRF**: `state` field (32-byte hex) + `stateExpiresAt` (30-minute window) validated in `/connect/callback`.
- **FK**: `clientId` → `clients.id` (cascade delete).

### `webhook_events`
Idempotency table to de-duplicate Stripe webhook notifications.

- **Fields**: `id`, `stripeEventId` (unique), `type`, `payload` (JSONB), `processedAt`, `createdAt`.

### `admins`
Admin accounts for the dashboard.

- **Fields**: `id`, `username` (unique), `passwordHash`, `role` (default `"admin"`), `active`, `setupConfirmed`, `lastLoginAt`, `createdAt`, `updatedAt`.
- Created via the bootstrap flow: seed `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars (with `ALLOW_ADMIN_SETUP=true`), log in, then `POST /auth/confirm-bootstrap`.

### `settings`
Key-value store for system-wide configuration.

- **Fields**: `key` (PK), `value`, `updatedAt`.
- Example key: `company_name` (used in onboarding emails).

## 3. Tooling & Migrations
- **Schema Changes**: Edit `backend/src/db/schema.ts`.
- **Generate**: `npm run db:generate` — creates SQL migration files in `backend/drizzle/`.
- **Apply**: `npm run db:migrate` — runs the `drizzle-kit migrate` CLI to apply pending migrations. (Separately, `runMigrations` in `src/lib/migrate.ts` applies the same migrations automatically at app startup in non-production environments.)

### Migration authoring policy
Always create migrations with `npx drizzle-kit generate` (or `npx drizzle-kit generate --custom` for hand-written/data-only SQL) so file numbering, `meta/_journal.json`, and `meta/*_snapshot.json` stay tool-managed. Never hand-number a migration file and never hand-edit `_journal.json` — review every generated diff line-by-line before committing. `backend/drizzle/` is applied-in-production history: existing files, tags, and journal entries must never be renamed or renumbered after the fact. The tree carries a few grandfathered anomalies predating this policy (duplicate `0019_*` prefixes, a skipped `0021` prefix, and some historical migrations missing a `meta/*_snapshot.json`); these are enumerated and guarded against further drift by `backend/src/__tests__/lib/migration-journal.test.ts`.

## 4. Idempotency Strategy
Stripe webhook handling is guarded by the `webhook_events` table. Payment creation uses `Idempotency-Key` headers (required for API key calls).
