# Database Architecture

This document describes the data model, Drizzle ORM usage, and migration strategy for the DFWSC Payment Portal.

## 1. Overview
The project uses **PostgreSQL 17** with **Drizzle ORM**. Two schema files feed one migration history (`backend/drizzle.config.ts` lists both):

| File | Postgres schema | Contents |
|------|-----------------|----------|
| `backend/src/db/schema.ts` | `public` | Every table in section 2 except the Cerebo tables |
| `backend/src/cerebo/schema.ts` | `cerebo` | The Cerebo tables (section 2, "Cerebo schema") |

Both are applied by the same migrations in `backend/drizzle/` (the `cerebo` schema is created by `0040_cerebo_module`). The Cerebo HTTP routes are registered only when `CEREBO_ENABLED=true` (see [BACKEND.md](./BACKEND.md) and [ENVIRONMENT.md](./ENVIRONMENT.md)), but the tables are created by every migration run whether or not the flag is on.

Table groups:

- **Payments and Connect (authoritative):** `clients`, `client_groups`, `onboarding_tokens`, `api_key_regeneration_tokens`, `payment_ledger`, `settings`, `connect_customers`, `connect_invoices`, `connect_invoice_sends`.
- **Webhook dedupe:** `webhook_events`.
- **DFWSC billing (platform Stripe account) and Nextcloud automations:** `billing_*`, `sales_lead_*`, `client_onboarding_*`, `contact_stripe_sync_*`, `portal_mirror_*`, `stripe_id_writebacks`.
- **Legacy:** `admins`.
- **Cerebo:** `cerebo.*`.

## 2. Core Tables

### `clients`
The primary entity for each consulting client.

- **Keys**: `id` (text, UUID), `name`, `email`.
- **Workspace**: `workspace` — always `"client_portal"` (CHECK `clients_workspace_check`).
- **Credentials**: `apiKeyHash` (bcrypt) and `apiKeyLookup` (SHA256, used to find the row before the bcrypt comparison). Both are unique columns and nullable.
- **Stripe**: `stripeAccountId` (linked Express account; unique), `stripeCustomerId` (unique where not null).
- **Status**: `"active"`, `"inactive"`, `"pending"`, `"failed"`, `"archived"` (CHECK `clients_status_check`, widened to include `archived` by migration `0020`).
- **Group**: `groupId` (optional FK → `client_groups.id`).
- **Pricing**: `processingFeePercent`, `processingFeeCents` (set one, not both).
- **URLs**: `paymentSuccessUrl`, `paymentCancelUrl`.
- **Connect redirect origins**: `connectRedirectOrigins` (`text[]`, NOT NULL, default empty; migration `0038_client_connect_redirect_origins`). The origins (`https://host[:port]`; plain `http` only for localhost) that a client app may use as `returnUrl` and `refreshUrl` for `POST /connect/onboarding-link`. An empty list means the client cannot use that endpoint. Set by admin `PATCH /clients/:id` (at most 10 entries, each a bare origin). See [STRIPE.md](./STRIPE.md), "Client-facing Connect endpoints".
- **Contact**: `phone`, `billingContactName`.
- **Address**: `addressLine1`, `addressLine2`, `city`, `state`, `postalCode`, `country`.
- **Billing**: `defaultPaymentTermsDays`.
- **Stripe readiness**: `chargesEnabled`, `payoutsEnabled`, `detailsSubmitted` and `cardPaymentsStatus` (nullable text: Stripe's `capabilities.card_payments` value, `active`, `inactive`, `pending` or `unrequested` (stored when Stripe's account has no such capability); NULL = never synced, migration `0037`). Both statuses are written from the Stripe account by the `account.updated` webhook, the onboarding callback, lazy account creation and the onboarding resend refresh. The client-facing `GET /connect/account` and `POST /connect/dashboard-link` sync (`syncClientFromAccount`) writes `cardPaymentsStatus` but leaves `achPaymentsStatus` unchanged. `achPaymentsStatus` is the same for `capabilities.us_bank_account_ach_payments` (same values, NULL = never synced, migration `0039`); the lazy NULL fill also fills it (only where NULL) and the onboarding resend refresh overwrites both. Nothing is gated on it yet. Invoice create, finalize and send require `cardPaymentsStatus = 'active'`; a NULL is read live once and stored, only if still NULL.
- **Invoicing**: `invoicingEnabled` (boolean, NOT NULL, default false; per-client opt-in for connected-account invoicing, set only by admin `PATCH /clients/:id`, never by `X-Api-Key` routes). Enforced by the invoicing routes (403 `INVOICING_NOT_ENABLED` when false; migration `0035_connect_invoicing_schema`). The routes themselves exist only when `CONNECT_INVOICING=true`.
- **Notes**: `notes` (free-form admin text).
- **Timestamps**: `createdAt`, `updatedAt`.

**Indexes and constraints:**
- `clients_email_workspace_unique` — unique (`email`, `workspace`)
- `clients_stripe_account_id_unique` — unique (`stripe_account_id`)
- `clients_stripe_customer_id_unique_idx` — partial unique (`stripe_customer_id`) WHERE NOT NULL
- `clients_api_key_hash_unique`, `clients_api_key_lookup_unique` — the unique constraints on the two credential columns (these are the lookup indexes; the separate non-unique `clients_api_key_hash_idx` and `clients_api_key_lookup_idx` were dropped by migration `0019_brave_ravenous`)
- `clients_group_id_idx`, `clients_workspace_idx` — plain indexes
- `clients_workspace_check`, `clients_status_check` — CHECK constraints on the enums above
- `group_id` references `client_groups.id` with `ON DELETE SET NULL`

### `client_groups`
Groups multiple clients to share fee and redirect URL configuration.

- **Keys**: `id` (text), `name` (NOT NULL).
- **Workspace**: always `"client_portal"`.
- **Status**: `"active"` or `"inactive"`.
- **Shared config**: `processingFeePercent`, `processingFeeCents`, `paymentSuccessUrl`, `paymentCancelUrl`.
- **Timestamps**: `createdAt`, `updatedAt`.

**Indexes and constraints:** `client_groups_workspace_idx`; CHECKs `client_groups_workspace_check` and `client_groups_status_check`.

### `onboarding_tokens`
Manages the lifecycle of a client's Stripe Connect onboarding session.

- **Statuses**: `pending` → `in_progress` → `completed` (or `revoked` on resend). CHECK `onboarding_tokens_status_check`.
- **Token**: `token` is unique and holds the SHA-256 hex of the random token that was emailed, never the token itself (migration `0019_hash_onboarding_tokens` hashed the rows that predate this). The emailed link is valid for 24 hours from `createdAt` (`ONBOARDING_TOKEN_TTL_MS` in `routes/connect.ts`).
- **CSRF**: `state` (32-byte hex) + `stateExpiresAt` (24 hours, `OAUTH_STATE_EXPIRY_MS` in `lib/constants.ts`), minted each time an Account Link is created and validated in `GET /connect/callback`. The callback sets `state` to NULL, so a state is single-use. See [STRIPE.md](./STRIPE.md), "Onboarding flow".
- **Index**: `onboarding_tokens_client_state_idx` on (`client_id`, `state`).
- **FK**: `clientId` → `clients.id` (cascade delete).

### `api_key_regeneration_tokens`
One row per emailed API-key regeneration link (migration `0022_tiresome_rage`).

- **Fields**: `id`, `clientId` (FK → `clients.id`, cascade delete), `token` (unique; SHA-256 hex of the emailed token), `status` (`pending`, `completed`, `revoked`; CHECK `api_key_regeneration_tokens_status_check`), `email`, `createdAt`, `updatedAt`.
- **Lifetime**: 15 minutes from creation, with a 5-minute cooldown between requests (`lib/api-key-regeneration.ts`).
- **Index**: `api_key_regeneration_tokens_client_id_idx` on `client_id`.

### `webhook_events`
Idempotency table to de-duplicate Stripe webhook notifications. It stores no event payload.

- **Fields**: `id`, `stripeEventId` (unique), `type`, `processedAt` (NULL until the event is fully handled), `claimedAt` (the lease timestamp), `createdAt`.
- **Lease**: a delivery inserts the row with `claimedAt = now()` and may process the event only if it won that insert. A delivery that finds an unprocessed row with a lease older than 15 minutes reclaims it; a live lease answers 409 so Stripe retries. After a retryable failure the row is deleted. See `lib/webhook-lease.ts`.
- **Index**: `webhook_events_unprocessed_idx`, partial on `processed_at` WHERE `processed_at IS NULL`.
- **Retention**: processed rows older than 30 days are deleted at boot and then every 24 hours (`lib/webhook-retention.ts`, `WEBHOOK_EVENT_RETENTION_MS` and `WEBHOOK_PRUNE_INTERVAL_MS`). Unprocessed rows are never pruned. Both Stripe webhook endpoints (Connect and billing) share this table.

### `admins`
**Legacy: no longer read or written.** Admin login is checked against Nextcloud. The table still exists: no migration drops it, it is still defined in `schema.ts`, and it is still listed in `REQUIRED_TABLES`, so the boot guard fails if it is missing. It used to hold the dashboard's own admin accounts.

- **Fields**: `id`, `username` (unique), `passwordHash`, `role` (default `"admin"`), `active`, `setupConfirmed`, `lastLoginAt`, `createdAt`, `updatedAt`.

### `settings`
Key-value store for system-wide configuration.

- **Fields**: `key` (PK), `value`, `updatedAt`.
- Example key: `company_name` (used in onboarding emails).

### `payment_ledger`
One row per Stripe Checkout Session created through `POST /payments/create` (migrations `0024_payment_ledger` and `0025_payment_ledger_per_client_idempotency`). It is inserted synchronously after the Session is created and before the checkout URL is returned; if the insert fails the API answers `503 LEDGER_PERSISTENCE_FAILED` and the caller retries with the same `Idempotency-Key`. Flow and fee behavior are in [STRIPE.md](./STRIPE.md), "Payment Strategy (Stripe Checkout)" and "Fees: the Processing Fee".

- **Keys**: `id` (text, UUID), `clientId` (FK → `clients.id`, cascade delete), `connectedAccountId` (the `acct_` the charge was made on).
- **Stripe ids**: `stripeSessionId` (set at insert), `stripePaymentIntentId` (NULL at insert; learned from the first Checkout Session webhook or the status endpoint's Stripe fallback, and never overwritten with a different id).
- **Idempotency**: `idempotencyKey` is the caller's key, unique per client. The key sent to Stripe is `<clientId>:<key>`.
- **Source**: `source` is `checkout` or `payment_intent` (CHECK). Current code writes only `checkout`; `payment_intent` remains allowed for rows from the removed PaymentIntent mode.
- **Amounts** (integer cents): `baseAmountCents` (sum of the caller's line items), `feeAmountCents` (the Processing Fee, 0 when waived), `totalAmountCents` (base + fee), `refundedAmountCents` (default 0; the maximum refunded amount seen, so 0 is no refund, below total is partial, equal to total is full), `currency` (lowercase ISO code).
- **Metadata**: `metadata` is a text column holding the caller's metadata as a JSON string (NULL when none).
- **Ordering**: `lastStripeEventCreatedAt` (integer, Stripe event `created` in Unix seconds). A webhook older than the stored value is ignored for status.
- **Timestamps**: `createdAt`, `updatedAt`.

**Status.** `created`, `paid`, `expired`, `failed`, `canceled`, `refunded`, `disputed` (CHECK `payment_ledger_status_check`). The webhook handler applies a new status only if it does not lower the precedence of the stored one: `created` (0) < `expired`, `failed`, `canceled` (1) < `paid` (2) < `refunded` (3) < `disputed` (4). So `refunded` and `disputed` can never go back to `paid`, while `failed` is not final and can still move to `paid` (for example when a delayed payment later succeeds). `refunded` covers partial refunds; use `refundedAmountCents` to tell them apart.

**Indexes and constraints:**
- `payment_ledger_client_idempotency_key_uniq` — unique (`client_id`, `idempotency_key`)
- `payment_ledger_session_id_uniq` — partial unique (`stripe_session_id`) WHERE NOT NULL
- `payment_ledger_pi_id_idx` — partial (`stripe_payment_intent_id`) WHERE NOT NULL
- `payment_ledger_client_id_idx`, `payment_ledger_connected_account_idx`
- `payment_ledger_client_updated_idx` — (`client_id`, `updated_at`), used by the portal mirror (migration `0032`)
- `payment_ledger_source_check`, `payment_ledger_status_check`

Every ledger write calls `kickJob("portalMirror")`, so the Nextcloud Portal Accounts mirror (docs/BACKEND.md section 12) picks up payment changes. The ledger is the only record of Checkout payments in Postgres; the invoicing tables below are separate.

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
Stripe-derived billing state per client code, for the Client Billing mirror (migration 0033). **PK** `clientCode` (FK to `billing_customers`, cascade). `stripeCustomerId` (several client codes may share one Customer), `rendered` (jsonb, NULL until the first successful refresh; status, up to date, subscription text, payments made, amounts, next due, last payment), `contentHash` (NULL with it; sha256 of `rendered`), `dirtyAt` (set by the billing webhook; cleared by a refresh unless set again during it), `refreshedAt`, `attempts` and `lastError` (error class only), `createdAt`, `updatedAt`. **`updatedAt` changes only when `contentHash` changes** (no `$onUpdate`), so a refresh that finds nothing new leaves it alone. The mirror still rewrites the row hourly: its rendered Last Checked (from `refreshedAt`, minute resolution) is part of the row's content hash. Derived only from Stripe list calls, never from webhook payloads.

### `billing_request_submissions`
One row per submission of the "New invoice" Nextcloud Form (docs/BACKEND.md section 14), PK `(form_id, submission_id)`. Same queue columns as `client_onboarding_submissions` (`status` pending/completed/failed, `attempts`, `next_attempt_at`, `claimed_at`/`claim_token` lease, `last_error_code`). Request summary once the answers are read (`requested_by` Nextcloud user id, `submitted_at`, `client_code`, `kind` one_off/recurring, `amount_cents`, `plan_interval` week/bi_weekly/month, `plan_payments`, `plan_start_date`); no description, memo or company text is stored. Stripe progress, each id saved as soon as Stripe returns it so a retry resumes: `stripe_started_at` (age of the 24 h idempotency window), `stripe_product_id`, `stripe_invoice_id`, `stripe_invoice_item_id`, `stripe_schedule_id`, `invoice_finalized_at`, `invoice_sent_at`, `outcome` (sent/draft/scheduled). `nc_row_id` and `nc_row_hash` track the row in the read-only "Billing Requests" Nextcloud Table. Migration `0034_billing_requests`.

### `billing_request_sync_state`
Per-form baseline (`form_id` PK, `baseline_submission_id`): submissions up to that id existed before the automation was first enabled and are never processed.

### `stripe_id_writebacks`
Bookkeeping for the Stripe ID write-back (`STRIPE_ID_WRITEBACK=true`, docs/BACKEND.md section 15; migration 0041). **PK** (`target`, `targetKey`); `target` is `project_row` (key = client code) or `contact_card` (key = contact UID, or `client:<code>` when the card is found by email). `ncRowId`, `addressbook`, `cardHref` (where it was last found), `desiredHash` (what `billing_customers` wants now), `writtenHash` (what was last confirmed in Nextcloud; an equal pair means no Nextcloud call), `writtenAt`, `verifiedAt` (daily verify pass), `status` (`ok`, `not_found`, `ambiguous`, `read_only`, `forbidden`, `error`), `attempts`, `nextAttemptAt` (backoff), `lastError` (a code, never a message or PII), `updatedAt`. CHECK constraints on `target` and `status`. Derived and rebuildable: deleting a row only costs a re-compare.

### `connect_customers`
Customers created on a client's connected account for connected-account invoicing (migration `0035_connect_invoicing_schema`). Written by `POST /customers`. PK `id` (text uuid); `client_id` (FK → `clients.id`, cascade), `connected_account_id`, `stripe_customer_id`, `external_ref` (nullable opaque integrator reference, max 100 chars, no PII), `idempotency_key`, `created_at`. No PII is stored: the Customer itself lives on the connected account. Never mixed with `billing_customers` (platform account).

**Indexes / constraints:**
- `connect_customers_account_customer_uniq` — unique (`connected_account_id`, `stripe_customer_id`)
- `connect_customers_client_external_ref_uniq` — partial unique (`client_id`, `external_ref`) WHERE `external_ref IS NOT NULL`
- `connect_customers_client_idempotency_key_uniq` — unique (`client_id`, `idempotency_key`)

### `connect_invoices`
One row per invoice created through the connected-account invoicing API; the row is stored before any Stripe call so a retry can resume (migration `0035_connect_invoicing_schema`). Written by `POST /invoices` and read by `GET /invoices[/:id]` (docs/BACKEND.md). Deliberately separate from `payment_ledger`. PK `id` (text uuid); `client_id` (FK → `clients.id`, cascade), `connected_account_id`, `stripe_customer_id`, `idempotency_key`, `request_hash`. Create progress: `creation_state` (`reserved`, `invoice_created`, `lines_added`, `complete`), `stripe_invoice_id` (`in_...`, nullable until Stripe returns it), `stripe_fee_item_id`, `line_item_ids` (jsonb). `status` (`draft`, `open`, `paid`, `void`, `uncollectible`, `deleted`). Amounts: `currency`, `subtotal_cents`, `fee_amount_cents`, `total_cents`, `amount_paid_cents` (default 0), `amount_remaining_cents`. Stripe fields: `number`, `due_date`, `hosted_invoice_url`, `invoice_pdf`; `description` (text, nullable) and `metadata` (jsonb, nullable; the caller's own metadata without `dfwsc_` keys) added by migration `0036_connect_invoice_lifecycle`. Lifecycle: `send_count` (default 0), `finalized_at`, `sent_at`, `paid_at`, `voided_at`, `last_stripe_event_created_at` (bigint; newest Connect webhook event time seen, written with `GREATEST`, diagnostic only and never a skip gate), `last_synced_at`, `claimed_at`, `created_at`, `updated_at`.

**Column usage by invoice creation.** `idempotency_key` holds the SHA-256 hex of the caller's `Idempotency-Key`, `request_hash` the sha256 of the canonical validated body. `subtotal_cents`, `fee_amount_cents` and `total_cents` are written at reservation (before Stripe): `subtotal_cents` is the sum of the lines before the processing fee, `total_cents` = subtotal + fee, `amount_remaining_cents` = total; `complete` re-writes total and remaining from the re-retrieved Stripe invoice (Stripe's own `subtotal` includes the fee line, so `subtotal_cents` = Stripe subtotal - fee). `creation_state` moves `reserved` -> `invoice_created` (`stripe_invoice_id` saved) -> `lines_added` (`line_item_ids` is the jsonb array of item ids in line order, `stripe_fee_item_id` the fee item; no fee item when the fee is 0) -> `complete`. `claimed_at` is the in-flight lease (60 s); it is null on a finished row. Reads only see `complete` rows. `created_at` is always written from a JS `Date` (millisecond precision) so the list cursor round-trips exactly. `last_synced_at` is set on completion and by the 30 s re-check. `description` and `metadata` are written at reservation and refreshed from Stripe by the lifecycle writes. `status` only moves forward (draft, open, uncollectible, paid or void; `deleted` from draft); a deleted row stays visible to `GET /invoices/:id` and `status=deleted`, and a delete takes `claimed_at` like a create does.

**Indexes / constraints:**
- `connect_invoices_client_idempotency_key_uniq` — unique (`client_id`, `idempotency_key`)
- `connect_invoices_stripe_invoice_id_uniq` — partial unique (`stripe_invoice_id`) WHERE NOT NULL
- `connect_invoices_client_created_idx` — (`client_id`, `created_at` DESC, `id`), keyset listing
- `connect_invoices_client_status_idx` — (`client_id`, `status`)
- `connect_invoices_creation_state_check`, `connect_invoices_status_check` — CHECK on the enums above
- `connect_invoices_{subtotal,fee_amount,total,amount_paid,amount_remaining}_cents_check` — each amount `>= 0`; `connect_invoices_send_count_check` — `send_count >= 0`; `connect_invoices_currency_check` — `currency ~ '^[a-z]{3}$'` (lowercase ISO code)
- `connect_invoices_customer_fk` — composite FK (`connected_account_id`, `stripe_customer_id`) → `connect_customers` (same columns, backed by `connect_customers_account_customer_uniq`). ON DELETE NO ACTION: customers are never deleted in v1; deleting a client still cascades to both tables in one statement.

Both tables, and `clients.invoicing_enabled`, are in `REQUIRED_TABLES` (`backend/src/lib/schema-check.ts`).

### `connect_invoice_sends`
One row per accepted `POST /invoices/:id/send` Idempotency-Key (migration `0036_connect_invoice_lifecycle`). PK `id` (text uuid); `invoice_id` (FK → `connect_invoices.id`, cascade), `client_id` (FK → `clients.id`, cascade), `key_hash` (SHA-256 hex of the caller's key), `state` (`pending`, `sent`, `failed`), `claimed_at` (60 s lease while a Stripe call is in flight; null otherwise), `created_at`, `updated_at`. `pending` and `sent` rows count towards the cap of 3 sends per invoice, enforced in a transaction holding `SELECT ... FOR UPDATE` on the invoice row; `failed` (a definite Stripe rejection) does not and is never retried (the caller uses a new key). Verified at boot by `lib/schema-check.ts`.

**Indexes / constraints:**
- `connect_invoice_sends_invoice_key_uniq` — unique (`invoice_id`, `key_hash`)
- `connect_invoice_sends_client_idx` — (`client_id`), backs the `clients` cascade (`client_id` is an FK but is not used in any query)
- `connect_invoice_sends_state_check` — CHECK `state IN ('pending', 'sent', 'failed')`

### Cerebo schema (`cerebo`)
Client and project tracking, defined in `backend/src/cerebo/schema.ts` and created by migration `0040_cerebo_module`. Every table has `client_id` (FK → `public.clients.id`, `NO ACTION`: clients are archived rather than deleted, so a client that still has Cerebo rows cannot be deleted). References between Cerebo rows are composite (`client_id`, `id`) foreign keys so the database rejects a link that crosses clients. The HTTP routes (`/api/v1/cerebo/*`) exist only when `CEREBO_ENABLED=true`.

| Table | Purpose | Notable columns and constraints |
|-------|---------|---------------------------------|
| `cerebo.projects` | A client's projects | `name`, `description`, `status` (`planned`, `active`, `paused`, `completed`, `canceled`), `starts_on`, `ends_on`. Unique (`client_id`, `id`) so others can reference it; CHECKs `projects_status_check` and `projects_dates_check` (end not before start); index (`client_id`, `status`) |
| `cerebo.milestones` | Milestones of a project | `project_id`, `title`, `status` (`planned`, `in_progress`, `done`, `canceled`), `due_on`, `completed_at`, `client_visible` (default false), `stripe_invoice_id` (text, no FK), `sort_order`. FK `milestones_project_fk` (`client_id`, `project_id`) → `projects`, cascade; index (`client_id`, `project_id`, `sort_order`) |
| `cerebo.resource_links` | Where work lives outside the portal | `project_id` (NULL for client-level), `kind` (`deck_board`, `files_folder`, `talk_room`, `collective`, `contact`, `calendar`), `external_id`, `url`, `label`. Unique (`client_id`, `kind`, `external_id`); FK `resource_links_project_fk` → `projects`, cascade; index (`client_id`, `project_id`) |
| `cerebo.audit_events` | Append-only record of Cerebo writes, written in the same transaction as the change | `actor_type` (`admin`, `system`), `actor_id`, `action` (`create`, `update`, `delete`), `entity_type`, `entity_id`, `changes` (jsonb, default `{}`), `request_id`, `created_at`. Indexes (`entity_type`, `entity_id`, `created_at`) and (`client_id`, `created_at`) |

`projects`, `milestones` and `resource_links` also have `created_at` and `updated_at`. The boot schema guard does not check the `cerebo` schema (section 3).

## 3. Tooling & Migrations

### Generating a migration
- **Schema changes**: edit `backend/src/db/schema.ts` (or `backend/src/cerebo/schema.ts`).
- **Generate**: from `backend/`, run `npm run db:generate` (`drizzle-kit generate`). It reads both schema files, needs `DATABASE_URL` set (`drizzle.config.ts` throws without it), and writes the SQL file, `meta/_journal.json` entry and snapshot into `backend/drizzle/`. Use `npx drizzle-kit generate --custom` for hand-written or data-only SQL.
- **Other scripts**: `db:migrate` (`drizzle-kit migrate`), `db:push` and `db:studio`. `db:push` bypasses the migration history and is not used for deployments.

### Applying migrations

| Environment | How migrations run |
|-------------|--------------------|
| Local dev stack (`docker-compose.base.yml` + `docker-compose.dev.yml`) | The `api` container runs `npx drizzle-kit migrate` before starting. The dev compose override tolerates a failure (`|| echo "Migration failed, continuing..."`), so check the logs. Outside production the API also calls `runMigrations` (`lib/migrate.ts`, the drizzle migrator) at startup, which is a no-op when everything is applied. |
| CI | The test job runs `npm run db:migrate` against a fresh database. |
| Production (`docker-compose.prod.yml`) | A one-shot `migrator` service (built from the backend `builder` target, `restart: "no"`) runs `npm run db:migrate`. The `api` service has `depends_on: migrator: condition: service_completed_successfully`, so if a migration fails the API does not start. In production the API never runs migrations itself (`NODE_ENV=production` skips `runMigrations`). |

At every start the API then calls `verifyDatabaseSchema()` (`lib/schema-check.ts`) and exits if it fails.

### Boot schema guard
`verifyDatabaseSchema` reads `information_schema.columns` for the `public` schema and checks that each table in `REQUIRED_TABLES` has the listed columns. It is a safety net against a deployment that skipped a migration, not a full schema comparison:

- It checks only the columns listed per table, not every column (for example `clients.connect_redirect_origins` and `webhook_events.claimed_at` are not listed) and not constraints or indexes.
- Not every table is listed. Unchecked tables include `billing_customers`, `billing_snapshots`, `portal_mirror_rows`, `portal_mirror_state`, `stripe_id_writebacks` and every table in the `cerebo` schema.
- When a migration adds a table or a column the code needs at boot, update `REQUIRED_TABLES` in the same PR.

### Production migration runbook
There are no down migrations. Rolling back means restoring a backup or writing a new forward migration.

1. Merge the change. Deploying does not take a backup for you.
2. Before deploying a migration that rewrites data or drops or narrows columns, take a dump: `make backup-now` on a host with the production compose file, or run `backup.sh` in the running backup container (see [BACKUP.md](./BACKUP.md)). Confirm the new file exists and passes the completeness check (the script does this and keeps no file otherwise).
3. Deploy. The migrator runs first. Read its output: `drizzle-kit migrate` applies pending files in journal order.
4. If the migrator fails, the API does not start. Fix forward with a new migration, or restore the dump into a scratch database to inspect it first ([BACKUP.md](./BACKUP.md), "Restore drill"). Restoring over the production database is a last resort.
5. Confirm the API boots: a passing `verifyDatabaseSchema` appears as a normal start; a failure logs `Database schema incomplete for table ...` and exits.

How the platform sequences the `migrator` and `api` services on deploy is covered in [COOLIFY_DEPLOYMENT.md](./COOLIFY_DEPLOYMENT.md).

### Migration authoring policy
Always create migrations with `npx drizzle-kit generate` (or `npx drizzle-kit generate --custom` for hand-written/data-only SQL) so file numbering, `meta/_journal.json`, and `meta/*_snapshot.json` stay tool-managed. Never hand-number a migration file and never hand-edit `_journal.json`; review every generated diff line by line before committing. `backend/drizzle/` is applied-in-production history: existing files, tags, and journal entries must never be renamed or renumbered after the fact.

Journal rules and quirks:

- **`when` must increase.** Drizzle applies a migration only when its journal `when` is greater than the newest `created_at` already recorded in the database. A migration merged with an older `when` than one already deployed is silently skipped in production while a fresh CI database still applies it. Keep each new migration's `when` strictly greater than the previous entry's, which `drizzle-kit generate` does when run on top of current `main`.
- **Grandfathered anomalies**, listed exactly in `backend/src/__tests__/lib/migration-journal.test.ts`: two files share the prefix `0019` (`0019_brave_ravenous` and `0019_hash_onboarding_tokens`), there is no `0021`, journal entry idx 3 has the same `when` as idx 2, and some historical migrations have no `meta/*_snapshot.json`. The test fails on any new drift.
- Migration numbers (`0035`, `0039`, ...) are file prefixes; the journal `idx` is the position in the list and differs from the prefix after `0019`.

## 4. Idempotency, retention and table roles
- **Stripe webhooks**: the `webhook_events` table (section 2) dedupes events with a reclaimable lease; processed rows are pruned after 30 days.
- **Payment creation**: `Idempotency-Key` is required for every call; the ledger enforces it per client (`payment_ledger_client_idempotency_key_uniq`) and the key sent to Stripe is namespaced by client id.
- **Invoicing**: `connect_customers` and `connect_invoices` store a SHA-256 of the caller's key, unique per client.
- **Authoritative vs derived.** Authoritative data (back it up; it cannot be rebuilt): `clients`, `client_groups`, `onboarding_tokens`, `api_key_regeneration_tokens`, `payment_ledger`, `settings`, `connect_customers`, `connect_invoices`, `connect_invoice_sends`, `billing_customers`, the `*_submissions` progress tables and the `*_sync_state` baselines (they record which Stripe and Nextcloud objects a form submission already created, so a retry does not duplicate them), `cerebo.*`. Derived or rebuildable from Stripe and Nextcloud: `portal_mirror_rows`, `portal_mirror_state`, `billing_snapshots`, `stripe_id_writebacks`, `contact_stripe_sync_books`, `contact_stripe_sync_cards`. Losing a derived table costs a re-sync (for the Nextcloud mirrors, a re-create or re-compare cycle), not data. `webhook_events` is a dedupe log and is pruned by design.
