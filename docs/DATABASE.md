# Database Architecture

This document describes the data model, Drizzle ORM usage, and migration strategy for the DFWSC Payment Portal.

## 1. Overview
The project uses **PostgreSQL 17** with the **Drizzle ORM**. All schema definitions are centralized in `backend/src/db/schema.ts`.

## 2. Core Tables

### `clients`
The primary entity for each consultant's client. Covers the full lifecycle from first contact (lead) through active billing to suspension.

- **Keys**: `id` (UUID), `name`, `email`.
- **Workspace**: `workspace` (`"dfwsc_services"` or `"client_portal"`) - separates internal and external clients.
- **Credentials**: `apiKeyHash` (bcrypt), `apiKeyLookup` (SHA256).
- **Stripe**: `stripeAccountId` (linked Express account), `stripeCustomerId` (for invoicing — null for leads).
- **Status**: `status` (`"active"`, `"inactive"`, or `"lead"`). Leads have no Stripe customer. Converting a lead to a client creates the Stripe customer and changes status to `"active"`.
- **Group**: `groupId` (optional) - links to `client_groups`.
- **Pricing**: `processingFeePercent`, `processingFeeCents`.
- **URLs**: `paymentSuccessUrl`, `paymentCancelUrl` - redirect URLs after payment.
- **Contact Info**: `phone`, `billingContactName`.
- **Address**: `addressLine1`, `addressLine2`, `city`, `state`, `postalCode`, `country`.
- **Billing**: `defaultPaymentTermsDays` - default payment terms for invoices.
- **Notes**: `notes` - free-form text field for admin notes.
- **CRM / Payment Sync** (added in migration `0007_gorgeous_fallen_one.sql`):
  - `paymentStatus` — cached Stripe subscription status: `active`, `trialing`, `past_due`, `unpaid`, `canceled`, or `none`. Updated every 15 minutes.
  - `paymentStatusSyncedAt` — timestamp of the last sync.
  - `suspendedAt` — when the client was suspended (null if not suspended).
  - `suspensionReason` — optional text reason for suspension.
- **Timestamps**: `createdAt`, `updatedAt`.

**Indexes:**
- `apiKeyHashIdx` - Fast API key lookup
- `apiKeyLookupIdx` - SHA256 lookup for API key
- `emailWorkspaceUnique` - Ensures unique email per workspace

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
- **Fields**: `id`, `stripeEventId` (unique), `type`, `payload` (JSONB), `processedAt`, `createdAt`.

### `admins`
Stores administrator accounts for the admin dashboard.
- **Fields**: `id`, `username` (unique), `passwordHash`, `role` (default: `"admin"`), `active`, `setupConfirmed`, `lastLoginAt`, `createdAt`, `updatedAt`.
- **Note**: Admin accounts are created via the bootstrap flow (`/auth/setup` → `/auth/confirm-bootstrap`).

### `settings`
Simple key-value store for system configuration.
- **Fields**: `key` (primary key), `value`, `updatedAt`.
- **Usage**: Stores system-wide defaults like payment terms.

## 3. Tooling & Migrations
- **Schema Changes**: Modify `backend/src/db/schema.ts`.
- **Generate**: `npm run db:generate` (creates SQL in `backend/drizzle/`).
- **Apply**: `npm run db:migrate` (uses `migrate.ts` script).

## 4. Idempotency Strategy
All Stripe operations, including webhook handling, are guarded by `Idempotency-Key` headers or the `webhook_events` table to prevent duplicate processing.
