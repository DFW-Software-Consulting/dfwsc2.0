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
- **Invoicing**: `invoicingEnabled` (boolean, NOT NULL, default false; per-client opt-in for connected-account invoicing, set only by admin `PATCH /clients/:id`, never by `X-Api-Key` routes). Unused until the invoicing routes land (migration `0035_connect_invoicing_schema`).
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
**Legacy: no longer read or written.** Admin login is checked against Nextcloud, and a later migration drops this table. It used to hold the dashboard's own admin accounts.

- **Fields**: `id`, `username` (unique), `passwordHash`, `role` (default `"admin"`), `active`, `setupConfirmed`, `lastLoginAt`, `createdAt`, `updatedAt`.

### `settings`
Key-value store for system-wide configuration.

- **Fields**: `key` (PK), `value`, `updatedAt`.
- Example key: `company_name` (used in onboarding emails).

### `sales_lead_submissions`
Progress of the Nextcloud New Lead automation, one row per Forms submission (see [BACKEND.md](./BACKEND.md), "Sales Lead Automation").

- **PK**: (`formId`, `submissionId`).
- **Statuses**: `pending` → `completed`, or `failed` (permanent error, or 10 attempts used).
- **Step outputs**: `tableRowId`, `contactUid`, `contactStatus` (`created` / `updated` / `ambiguous` / `read_only` / `failed`; `failed` means the contact step could not complete and the lead was kept anyway), `contactAddressbook` (the book the linked card lives in), `folderName`, `folderFileId`, `linksBackfilledAt`, each saved as its step succeeds so retries resume.
- **Retry/lease**: `attempts`, `nextAttemptAt`, `lastErrorCode` (PII-free), `claimedAt` + `claimToken`.
- Stores no form answers.

### `sales_lead_sync_state`
Per-form baseline: `baselineSubmissionId` is the highest submission id when the automation first ran; earlier submissions are never processed.

### `client_onboarding_submissions`
Progress of the Nextcloud client onboarding (Convert Won Lead to Client form), one row per Forms submission (see [BACKEND.md](./BACKEND.md), "Client Onboarding Automation").

- **PK**: (`formId`, `submissionId`).
- **Statuses**: `pending` → `completed`, or `failed` (permanent error, or 10 attempts used).
- **Step outputs**: `folderName`, `folderFileId`, `contactStatus` (`created` / `updated` / `ambiguous` / `read_only`), `contactUid`, `projectNumber` + `projectCode` (CP-###), `tableRowId`, `pageId`, `pageUrl`, `pageContentAt`, `teamId` + `teamMembersAt`, `collectiveId` + `collectiveContentAt`, `folderShareId` (the last five only with `CLIENT_ONBOARDING_PROJECT_TEAMS=true`, else NULL), `linksBackfilledAt`, `leadStatus` (`won` / `no_match` / `ambiguous` / `already_linked`), `leadRowId`, `billingStatus` (`linked` / `ambiguous` / `no_email`) + `billingCustomerId` (only with `CLIENT_ONBOARDING_BILLING_CUSTOMER=true`, else NULL). Each is saved as its step succeeds so retries resume.
- **Project codes**: `projectNumber` and `projectCode` are unique. They are allocated under a transaction-scoped advisory lock and never reused, including for submissions that later fail.
- **Retry/lease**: `attempts`, `nextAttemptAt`, `lastErrorCode` (PII-free), `claimedAt` + `claimToken`.
- Stores no form answers.

### `billing_customers`

DFWSC's own billing Customers (platform Stripe account), written by the New Client onboarding when `CLIENT_ONBOARDING_BILLING_CUSTOMER=true`. Unrelated to `clients`, `payment_ledger` and Stripe Connect; a business can have rows in both worlds.

- **PK**: `clientCode` (CP-###). `company`, `email` (lowercased, index on `lower(email)`), `stripeCustomerId` (NOT NULL, plain index, not unique: several client codes may share one Customer), `source` (`created` / `matched` / `backfill`), `createdAt`, `updatedAt`.
- Look a Customer up by `clientCode`, or by Stripe `customer` id.

### `client_onboarding_sync_state`
Per-form baseline for the client onboarding, as for `sales_lead_sync_state`.

### `contact_stripe_sync_books`
CardDAV sync-token per address book for the contact card to billing Customer sync (`CONTACT_STRIPE_SYNC=true`, docs/BACKEND.md section 11). **PK** `addressbook`; `syncToken` (NULL forces a full scan), `syncedAt`, `updatedAt`.

### `contact_stripe_sync_cards`
Per onboarding contact card (`dfwsc-client-*`) linked to a billing Customer. **PK** `contactUid`; `clientCode`, `stripeCustomerId` (plain index), `href`, `etag`, `lastHash` and `fieldHashes` (jsonb: sha256 per mapped Stripe field name/email/phone/address, never the values), `baselineAt` (NULL = card not seen yet, deleted, or reset), `baselineResetAt` (set when the automation rewrote the card; a cycle that started earlier must not overwrite the row), `lastPushedAt`, `lastError` (PII-free code) and `lastErrorHash` (a non-retryable error is retried only when the card hash differs), `createdAt`, `updatedAt`. Nothing on `clients` or `payment_ledger`.

### `portal_mirror_rows`
Mapping for the Portal Accounts Nextcloud Table mirror (`PORTAL_MIRROR=true`, docs/BACKEND.md section 12). **PK** (`kind`, `sourceId`); `kind` is `account` (Portal Accounts) or `billing` (Client Billing, `BILLING_MIRROR=true`, docs/BACKEND.md section 13); the CHECK was widened by migration 0033. `ncRowId` (the Nextcloud Tables row; NULL = create it on the next cycle), `contentHash` (sha256 of the rendered cells; an unchanged hash means no Nextcloud write), `syncedAt` (database clock at the start of the cycle that wrote it; NULL = needs a write), `attempts`, `nextAttemptAt` and `lastError` (error class and HTTP status only) for per-row backoff, `updatedAt`. Nothing on `clients` or `client_groups`: a client is dirty when `greatest(clients.updated_at, client_groups.updated_at)` or any of its `payment_ledger.updated_at` is newer than `syncedAt` minus 5 minutes (index `payment_ledger_client_updated_idx` on (`client_id`, `updated_at`), added by migration 0032).

### `portal_mirror_state`
Key/value bookkeeping for the portal mirrors. Two keys, `accounts_table_id` and `billing_table_id`: the Nextcloud Tables they provisioned, so a renamed table keeps being used. **PK** `key`; `value`, `updatedAt`.

### `billing_snapshots`
Stripe-derived billing state per client code, for the Client Billing mirror (migration 0033). **PK** `clientCode` (FK to `billing_customers`, cascade). `stripeCustomerId` (several client codes may share one Customer), `rendered` (jsonb, NULL until the first successful refresh; status, up to date, subscription text, payments made, amounts, next due, last payment), `contentHash` (NULL with it; sha256 of `rendered`), `dirtyAt` (set by the billing webhook; cleared by a refresh unless set again during it), `refreshedAt`, `attempts` and `lastError` (error class only), `createdAt`, `updatedAt`. **`updatedAt` changes only when `contentHash` changes** (no `$onUpdate`), so a refresh that finds nothing new is invisible to the mirror loop. Derived only from Stripe list calls, never from webhook payloads.

### `billing_request_submissions`
One row per submission of the "New invoice" Nextcloud Form (docs/BACKEND.md section 14), PK `(form_id, submission_id)`. Same queue columns as `client_onboarding_submissions` (`status` pending/completed/failed, `attempts`, `next_attempt_at`, `claimed_at`/`claim_token` lease, `last_error_code`). Request summary once the answers are read (`requested_by` Nextcloud user id, `submitted_at`, `client_code`, `kind` one_off/recurring, `amount_cents`, `plan_interval` week/bi_weekly/month, `plan_payments`, `plan_start_date`); no description, memo or company text is stored. Stripe progress, each id saved as soon as Stripe returns it so a retry resumes: `stripe_started_at` (age of the 24 h idempotency window), `stripe_product_id`, `stripe_invoice_id`, `stripe_invoice_item_id`, `stripe_schedule_id`, `invoice_finalized_at`, `invoice_sent_at`, `outcome` (sent/draft/scheduled). `nc_row_id` and `nc_row_hash` track the row in the read-only "Billing Requests" Nextcloud Table. Migration `0034_billing_requests`.

### `billing_request_sync_state`
Per-form baseline (`form_id` PK, `baseline_submission_id`): submissions up to that id existed before the automation was first enabled and are never processed.

### `connect_customers`
Customers created on a client's connected account for connected-account invoicing (migration `0035_connect_invoicing_schema`). **Unused until the invoicing routes land.** PK `id` (text uuid); `client_id` (FK → `clients.id`, cascade), `connected_account_id`, `stripe_customer_id`, `external_ref` (nullable opaque integrator reference, max 100 chars, no PII), `idempotency_key`, `created_at`. No PII is stored: the Customer itself lives on the connected account. Never mixed with `billing_customers` (platform account).

**Indexes / constraints:**
- `connect_customers_account_customer_uniq` — unique (`connected_account_id`, `stripe_customer_id`)
- `connect_customers_client_external_ref_uniq` — partial unique (`client_id`, `external_ref`) WHERE `external_ref IS NOT NULL`
- `connect_customers_client_idempotency_key_uniq` — unique (`client_id`, `idempotency_key`)

### `connect_invoices`
One row per invoice created through the connected-account invoicing API; the row is stored before any Stripe call so a retry can resume (migration `0035_connect_invoicing_schema`). **Unused until the invoicing routes land.** Deliberately separate from `payment_ledger`. PK `id` (text uuid); `client_id` (FK → `clients.id`, cascade), `connected_account_id`, `stripe_customer_id`, `idempotency_key`, `request_hash`. Create progress: `creation_state` (`reserved`, `invoice_created`, `lines_added`, `complete`), `stripe_invoice_id` (`in_...`, nullable until Stripe returns it), `stripe_fee_item_id`, `line_item_ids` (jsonb). `status` (`draft`, `open`, `paid`, `void`, `uncollectible`, `deleted`). Amounts: `currency`, `subtotal_cents`, `fee_amount_cents`, `total_cents`, `amount_paid_cents` (default 0), `amount_remaining_cents`. Stripe fields: `number`, `due_date`, `hosted_invoice_url`, `invoice_pdf`. Lifecycle: `send_count` (default 0), `finalized_at`, `sent_at`, `paid_at`, `voided_at`, `last_stripe_event_created_at` (bigint, event-order guard), `last_synced_at`, `claimed_at`, `created_at`, `updated_at`.

**Indexes / constraints:**
- `connect_invoices_client_idempotency_key_uniq` — unique (`client_id`, `idempotency_key`)
- `connect_invoices_stripe_invoice_id_uniq` — partial unique (`stripe_invoice_id`) WHERE NOT NULL
- `connect_invoices_client_created_idx` — (`client_id`, `created_at` DESC, `id`), keyset listing
- `connect_invoices_client_status_idx` — (`client_id`, `status`)
- `connect_invoices_creation_state_check`, `connect_invoices_status_check` — CHECK on the enums above
- `connect_invoices_{subtotal,fee_amount,total,amount_paid,amount_remaining}_cents_check` — each amount `>= 0`; `connect_invoices_send_count_check` — `send_count >= 0`; `connect_invoices_currency_check` — `currency ~ '^[a-z]{3}$'` (lowercase ISO code)
- `connect_invoices_customer_fk` — composite FK (`connected_account_id`, `stripe_customer_id`) → `connect_customers` (same columns, backed by `connect_customers_account_customer_uniq`). ON DELETE NO ACTION: customers are never deleted in v1; deleting a client still cascades to both tables in one statement.

Both tables, and `clients.invoicing_enabled`, are in `REQUIRED_TABLES` (`backend/src/lib/schema-check.ts`).

## 3. Tooling & Migrations
- **Schema Changes**: Edit `backend/src/db/schema.ts`.
- **Generate**: `npm run db:generate` — creates SQL migration files in `backend/drizzle/`.
- **Apply**: `npm run db:migrate` — runs the `drizzle-kit migrate` CLI to apply pending migrations. (Separately, `runMigrations` in `src/lib/migrate.ts` applies the same migrations automatically at app startup in non-production environments.)
- **Boot Schema Guard**: When a migration adds a new table, update `REQUIRED_TABLES` in `backend/src/lib/schema-check.ts` in the same PR, or a deployment that skips the migration will pass the boot check and fail later at runtime.

### Migration authoring policy
Always create migrations with `npx drizzle-kit generate` (or `npx drizzle-kit generate --custom` for hand-written/data-only SQL) so file numbering, `meta/_journal.json`, and `meta/*_snapshot.json` stay tool-managed. Never hand-number a migration file and never hand-edit `_journal.json` — review every generated diff line-by-line before committing. `backend/drizzle/` is applied-in-production history: existing files, tags, and journal entries must never be renamed or renumbered after the fact. The tree carries a few grandfathered anomalies predating this policy (duplicate `0019_*` prefixes, a skipped `0021` prefix, and some historical migrations missing a `meta/*_snapshot.json`); these are enumerated and guarded against further drift by `backend/src/__tests__/lib/migration-journal.test.ts`.

## 4. Idempotency Strategy
Stripe webhook handling is guarded by the `webhook_events` table. Payment creation uses `Idempotency-Key` headers (required for API key calls).
