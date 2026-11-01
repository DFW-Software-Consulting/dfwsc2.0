import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const clientGroups = pgTable(
  "client_groups",
  {
    id: text("id").primaryKey(),
    workspace: text("workspace", { enum: ["client_portal"] })
      .default("client_portal")
      .notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["active", "inactive"] })
      .default("active")
      .notNull(),
    processingFeePercent: numeric("processing_fee_percent", { precision: 5, scale: 2 }),
    processingFeeCents: integer("processing_fee_cents"),
    paymentSuccessUrl: text("payment_success_url"),
    paymentCancelUrl: text("payment_cancel_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    workspaceIdx: index("client_groups_workspace_idx").on(table.workspace),
    workspaceCheck: check(
      "client_groups_workspace_check",
      sql`${table.workspace} IN ('client_portal')`
    ),
    statusCheck: check(
      "client_groups_status_check",
      sql`${table.status} IN ('active', 'inactive')`
    ),
  })
);

export const clients = pgTable(
  "clients",
  {
    id: text("id").primaryKey(),
    workspace: text("workspace", { enum: ["client_portal"] })
      .default("client_portal")
      .notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    apiKeyHash: text("api_key_hash").unique(),
    apiKeyLookup: text("api_key_lookup").unique(),
    stripeAccountId: text("stripe_account_id"),
    stripeCustomerId: text("stripe_customer_id"),
    status: text("status", { enum: ["active", "inactive", "pending", "failed", "archived"] })
      .default("active")
      .notNull(),
    chargesEnabled: boolean("charges_enabled").default(false).notNull(),
    payoutsEnabled: boolean("payouts_enabled").default(false).notNull(),
    detailsSubmitted: boolean("details_submitted").default(false).notNull(),
    groupId: text("group_id").references(() => clientGroups.id, { onDelete: "set null" }),
    paymentSuccessUrl: text("payment_success_url"),
    paymentCancelUrl: text("payment_cancel_url"),
    processingFeePercent: numeric("processing_fee_percent", { precision: 5, scale: 2 }),
    processingFeeCents: integer("processing_fee_cents"),
    phone: text("phone"),
    billingContactName: text("billing_contact_name"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    state: text("state"),
    postalCode: text("postal_code"),
    country: text("country"),
    notes: text("notes"),
    defaultPaymentTermsDays: integer("default_payment_terms_days"),
    // Per-client opt-in for connected-account invoicing (also needs the global
    // CONNECT_INVOICING switch once the routes land). Admin-only toggle.
    invoicingEnabled: boolean("invoicing_enabled").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    emailWorkspaceUnique: unique("clients_email_workspace_unique").on(table.email, table.workspace),
    stripeAccountIdUnique: unique("clients_stripe_account_id_unique").on(table.stripeAccountId),
    stripeCustomerIdUniqueIdx: uniqueIndex("clients_stripe_customer_id_unique_idx")
      .on(table.stripeCustomerId)
      .where(sql`${table.stripeCustomerId} IS NOT NULL`),
    groupIdIdx: index("clients_group_id_idx").on(table.groupId),
    workspaceIdx: index("clients_workspace_idx").on(table.workspace),
    workspaceCheck: check("clients_workspace_check", sql`${table.workspace} IN ('client_portal')`),
    statusCheck: check(
      "clients_status_check",
      sql`${table.status} IN ('active', 'inactive', 'pending', 'failed', 'archived')`
    ),
  })
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id").primaryKey(),
    stripeEventId: text("stripe_event_id").notNull().unique(),
    type: text("type").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    // Lease timestamp: set when a delivery claims an unprocessed event so a
    // crashed processor's claim can be reclaimed after it goes stale.
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    // TODO: retention/pruning of old webhook_events
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    unprocessedIdx: index("webhook_events_unprocessed_idx")
      .on(table.processedAt)
      .where(sql`${table.processedAt} IS NULL`),
  })
);

export const onboardingTokens = pgTable(
  "onboarding_tokens",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    status: text("status", { enum: ["pending", "in_progress", "completed", "revoked"] }).notNull(),
    email: text("email").notNull(),
    state: text("state"),
    stateExpiresAt: timestamp("state_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    clientIdStateIdx: index("onboarding_tokens_client_state_idx").on(table.clientId, table.state),
    statusCheck: check(
      "onboarding_tokens_status_check",
      sql`${table.status} IN ('pending', 'in_progress', 'completed', 'revoked')`
    ),
  })
);

export const apiKeyRegenerationTokens = pgTable(
  "api_key_regeneration_tokens",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    status: text("status", { enum: ["pending", "completed", "revoked"] }).notNull(),
    email: text("email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    clientIdIdx: index("api_key_regeneration_tokens_client_id_idx").on(table.clientId),
    statusCheck: check(
      "api_key_regeneration_tokens_status_check",
      sql`${table.status} IN ('pending', 'completed', 'revoked')`
    ),
  })
);

export const admins = pgTable("admins", {
  id: text("id").primaryKey(),
  username: text("username").unique().notNull(),
  passwordHash: text("password_hash").notNull(),
  // NOTE: only "admin" is currently written by the app. Left unconstrained
  // (no CHECK) since the full intended role set is not yet established -
  // narrowing this now risks rejecting a future legitimate role value.
  role: text("role").notNull().default("admin"),
  active: boolean("active").notNull().default(true),
  setupConfirmed: boolean("setup_confirmed").default(false).notNull(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const paymentLedger = pgTable(
  "payment_ledger",
  {
    id: text("id").primaryKey(),
    // The caller's idempotency key used when creating the Stripe session/PI.
    // Scoped per client (see payment_ledger_client_idempotency_key_uniq); the
    // key sent to Stripe is namespaced as `${clientId}:${key}`.
    idempotencyKey: text("idempotency_key").notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    stripeSessionId: text("stripe_session_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    source: text("source", { enum: ["checkout", "payment_intent"] }).notNull(),
    // Status semantics:
    // - created: initial state after Stripe creation
    // - paid: terminal success state (checkout completed or PI succeeded)
    // - expired: checkout session expired without payment
    // - failed: payment attempt failed
    // - canceled: payment intent canceled before completion
    // - refunded: fully or partially refunded (see refunded_amount_cents)
    // - disputed: charge disputed (may or may not be refunded yet)
    // Precedence: disputed > refunded > paid > failed/expired/canceled > created
    // Once in disputed/refunded, cannot transition to paid.
    status: text("status", {
      enum: ["created", "paid", "expired", "failed", "refunded", "disputed", "canceled"],
    })
      .notNull()
      .default("created"),
    baseAmountCents: integer("base_amount_cents").notNull(),
    totalAmountCents: integer("total_amount_cents").notNull(),
    feeAmountCents: integer("fee_amount_cents").notNull(),
    // Track refunded amount for partial vs full refund distinction.
    // 0 = no refund, >0 and <total = partial, =total = full refund.
    refundedAmountCents: integer("refunded_amount_cents").notNull().default(0),
    currency: text("currency").notNull(),
    metadata: text("metadata"),
    // Stripe event ordering can be out-of-order; store the Stripe event
    // created timestamp so we can ignore stale updates.
    lastStripeEventCreatedAt: integer("last_stripe_event_created_at"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    clientIdIdx: index("payment_ledger_client_id_idx").on(table.clientId),
    // Portal mirror: "did any payment of this client change since X" is an index range probe.
    clientUpdatedIdx: index("payment_ledger_client_updated_idx").on(
      table.clientId,
      table.updatedAt
    ),
    // A Stripe session maps to exactly one ledger row.
    sessionIdUniq: uniqueIndex("payment_ledger_session_id_uniq")
      .on(table.stripeSessionId)
      .where(sql`${table.stripeSessionId} IS NOT NULL`),
    clientIdempotencyKeyUniq: uniqueIndex("payment_ledger_client_idempotency_key_uniq").on(
      table.clientId,
      table.idempotencyKey
    ),
    paymentIntentIdIdx: index("payment_ledger_pi_id_idx")
      .on(table.stripePaymentIntentId)
      .where(sql`${table.stripePaymentIntentId} IS NOT NULL`),
    connectedAccountIdx: index("payment_ledger_connected_account_idx").on(table.connectedAccountId),
    sourceCheck: check(
      "payment_ledger_source_check",
      sql`${table.source} IN ('checkout', 'payment_intent')`
    ),
    statusCheck: check(
      "payment_ledger_status_check",
      sql`${table.status} IN ('created', 'paid', 'expired', 'failed', 'refunded', 'disputed', 'canceled')`
    ),
  })
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// "DFWSC — New Lead" automation (lib/sales-lead-sync.ts). One row per Forms
// submission processed into Nextcloud. Answers are never stored here; they are
// re-read from Forms on each attempt. Each step's output column is written as
// soon as that step succeeds, so a retry resumes at the first missing output.
export const salesLeadSubmissions = pgTable(
  "sales_lead_submissions",
  {
    formId: integer("form_id").notNull(),
    submissionId: integer("submission_id").notNull(),
    status: text("status", { enum: ["pending", "completed", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    // Lease: set when a cycle claims the row; a stale claim can be reclaimed.
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimToken: text("claim_token"),
    // PII-free failure code such as "tables.create_row:503" or "missing_company".
    lastErrorCode: text("last_error_code"),
    tableRowId: integer("table_row_id"),
    contactUid: text("contact_uid"),
    // Existing-card handling: created, updated in place, left alone (several matches),
    // or matched in a read-only address book; "failed" when the contact step could not
    // complete (the lead is kept regardless). contactAddressbook is the book the
    // linked card lives in.
    contactStatus: text("contact_status", {
      enum: ["created", "updated", "ambiguous", "read_only", "failed"],
    }),
    contactAddressbook: text("contact_addressbook"),
    folderName: text("folder_name"),
    folderFileId: bigint("folder_file_id", { mode: "number" }),
    linksBackfilledAt: timestamp("links_backfilled_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.formId, table.submissionId] }),
    dueIdx: index("sales_lead_submissions_due_idx").on(table.status, table.nextAttemptAt),
    statusCheck: check(
      "sales_lead_submissions_status_check",
      sql`${table.status} IN ('pending', 'completed', 'failed')`
    ),
    contactStatusCheck: check(
      "sales_lead_submissions_contact_status_check",
      sql`${table.contactStatus} IS NULL OR ${table.contactStatus} IN ('created', 'updated', 'ambiguous', 'read_only', 'failed')`
    ),
  })
);

// Per-form baseline: submissions with an id at or below baseline_submission_id
// existed before the automation first ran and are never processed.
export const salesLeadSyncState = pgTable("sales_lead_sync_state", {
  formId: integer("form_id").primaryKey(),
  baselineSubmissionId: integer("baseline_submission_id").notNull(),
  baselinedAt: timestamp("baselined_at", { withTimezone: true }).notNull().defaultNow(),
});

// "Convert Won Lead to Client" onboarding (lib/client-onboarding-sync.ts). One row
// per Forms submission. Like sales_lead_submissions: no answers are stored, each
// step's output is saved as soon as the step succeeds, and a retry resumes at the
// first step without output.
export const clientOnboardingSubmissions = pgTable(
  "client_onboarding_submissions",
  {
    formId: integer("form_id").notNull(),
    submissionId: integer("submission_id").notNull(),
    status: text("status", { enum: ["pending", "completed", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimToken: text("claim_token"),
    // PII-free failure code such as "tables.create_row:503" or "missing_company".
    lastErrorCode: text("last_error_code"),
    // 1. Client folder clients/<Company>/ and its Meetings/ Decisions/ Deliverables/.
    folderName: text("folder_name"),
    folderFileId: bigint("folder_file_id", { mode: "number" }),
    // 2. Contact card: created, updated, or left alone (several cards matched, or the one
    // match is in a read-only address book).
    contactStatus: text("contact_status", {
      enum: ["created", "updated", "ambiguous", "read_only"],
    }),
    contactUid: text("contact_uid"),
    // 3. CP-### code. Allocated once under an advisory lock and never reused.
    projectNumber: integer("project_number"),
    projectCode: text("project_code"),
    tableRowId: integer("table_row_id"),
    // 4. Collectives page.
    pageId: integer("page_id"),
    pageUrl: text("page_url"),
    pageContentAt: timestamp("page_content_at", { withTimezone: true }),
    // Per-project Teams (CLIENT_ONBOARDING_PROJECT_TEAMS=true only; all stay NULL when off).
    // 3b. Nextcloud Team (Circles) "CP-### <Project name>"; teamMembersAt = admins and submitter added.
    teamId: text("team_id"),
    teamMembersAt: timestamp("team_members_at", { withTimezone: true }),
    // 3c. Collective of the same name (its landing page holds the Project Brief).
    collectiveId: integer("collective_id"),
    collectiveContentAt: timestamp("collective_content_at", { withTimezone: true }),
    // 3d. files_sharing share of the client folder with the team.
    folderShareId: integer("folder_share_id"),
    // Row links (folder, page, intake submission), verified on read-back.
    linksBackfilledAt: timestamp("links_backfilled_at", { withTimezone: true }),
    // 5. Sales Pipeline row. A non-"won" status is a flag for an operator, not a failure.
    leadStatus: text("lead_status", { enum: ["won", "no_match", "ambiguous", "already_linked"] }),
    leadRowId: integer("lead_row_id"),
    // 6. DFWSC billing Customer (CLIENT_ONBOARDING_BILLING_CUSTOMER=true only; NULL when off).
    // The Customer itself lives in billing_customers. Non-"linked" statuses are flags for an
    // operator, not failures: ambiguous = several Stripe Customers share the email,
    // no_email = the submission has no email to match on.
    billingStatus: text("billing_status", { enum: ["linked", "ambiguous", "no_email"] }),
    billingCustomerId: text("billing_customer_id"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.formId, table.submissionId] }),
    dueIdx: index("client_onboarding_submissions_due_idx").on(table.status, table.nextAttemptAt),
    projectNumberUnique: uniqueIndex("client_onboarding_submissions_project_number_idx").on(
      table.projectNumber
    ),
    projectCodeUnique: uniqueIndex("client_onboarding_submissions_project_code_idx").on(
      table.projectCode
    ),
    statusCheck: check(
      "client_onboarding_submissions_status_check",
      sql`${table.status} IN ('pending', 'completed', 'failed')`
    ),
    contactStatusCheck: check(
      "client_onboarding_submissions_contact_status_check",
      sql`${table.contactStatus} IS NULL OR ${table.contactStatus} IN ('created', 'updated', 'ambiguous', 'read_only')`
    ),
    leadStatusCheck: check(
      "client_onboarding_submissions_lead_status_check",
      sql`${table.leadStatus} IS NULL OR ${table.leadStatus} IN ('won', 'no_match', 'ambiguous', 'already_linked')`
    ),
    billingStatusCheck: check(
      "client_onboarding_submissions_billing_status_check",
      sql`${table.billingStatus} IS NULL OR ${table.billingStatus} IN ('linked', 'ambiguous', 'no_email')`
    ),
  })
);

// DFWSC's own billing Customers (platform Stripe account), one row per client code.
// Deliberately unrelated to clients / payment_ledger (Stripe Connect): a business can be
// both. Several client codes may share one Customer, so stripe_customer_id is not unique.
export const billingCustomers = pgTable(
  "billing_customers",
  {
    clientCode: text("client_code").primaryKey(),
    company: text("company").notNull(),
    // Lowercased.
    email: text("email").notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    source: text("source", { enum: ["created", "matched", "backfill"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    emailIdx: index("billing_customers_email_idx").on(sql`lower(${table.email})`),
    stripeCustomerIdx: index("billing_customers_stripe_customer_id_idx").on(table.stripeCustomerId),
    sourceCheck: check(
      "billing_customers_source_check",
      sql`${table.source} IN ('created', 'matched', 'backfill')`
    ),
  })
);

// Per-form baseline, as for sales_lead_sync_state.
export const clientOnboardingSyncState = pgTable("client_onboarding_sync_state", {
  formId: integer("form_id").primaryKey(),
  baselineSubmissionId: integer("baseline_submission_id").notNull(),
  baselinedAt: timestamp("baselined_at", { withTimezone: true }).notNull().defaultNow(),
});

// Nextcloud contact card -> billing Stripe Customer sync (CONTACT_STRIPE_SYNC=true only).
// CardDAV sync-token per address book; null forces a full scan on the next cycle.
export const contactStripeSyncBooks = pgTable("contact_stripe_sync_books", {
  addressbook: text("addressbook").primaryKey(),
  syncToken: text("sync_token"),
  syncedAt: timestamp("synced_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// Per onboarding contact card (dfwsc-client-*) linked to a billing Customer. Holds hashes only,
// never contact details: field_hashes = sha256 of each mapped Stripe field (name, email, phone,
// address) as last seen or pushed, last_hash = hash of all of them. baseline_at NULL = the
// card has not been seen yet (the first sighting records the hashes without pushing).
export const contactStripeSyncCards = pgTable(
  "contact_stripe_sync_cards",
  {
    contactUid: text("contact_uid").primaryKey(),
    clientCode: text("client_code").notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    href: text("href"),
    etag: text("etag"),
    lastHash: text("last_hash"),
    fieldHashes: jsonb("field_hashes").$type<Record<string, string | null>>(),
    baselineAt: timestamp("baseline_at", { withTimezone: true }),
    // Set (database clock) when the automation itself rewrote the card, which forces a baseline.
    // A sync cycle that started before it must not overwrite this row with what it had read.
    baselineResetAt: timestamp("baseline_reset_at", { withTimezone: true }),
    lastPushedAt: timestamp("last_pushed_at", { withTimezone: true }),
    // PII-free failure code such as "stripe.customer_update:400"; a non-retryable one is only retried
    // after the card changes (last_error_hash differs from the card's current hash).
    lastError: text("last_error"),
    lastErrorHash: text("last_error_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    customerIdx: index("contact_stripe_sync_cards_customer_idx").on(table.stripeCustomerId),
  })
);

// Portal Accounts mirror into a Nextcloud Table (PORTAL_MIRROR=true only).
// One row per mirrored source row (kind = "account"). The source tables are never
// touched: a source row is dirty when it has no row here or its updated_at is newer than
// synced_at. nc_row_id is the Nextcloud Tables row; null means "create it on the next cycle".
export const portalMirrorRows = pgTable(
  "portal_mirror_rows",
  {
    kind: text("kind", { enum: ["account", "billing"] }).notNull(),
    sourceId: text("source_id").notNull(),
    ncRowId: integer("nc_row_id"),
    contentHash: text("content_hash"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.kind, table.sourceId] }),
    kindCheck: check("portal_mirror_rows_kind_check", sql`${table.kind} IN ('account', 'billing')`),
  })
);

// Portal mirror bookkeeping that is not per source row: `accounts_table_id` and
// `billing_table_id`, the Nextcloud Tables the mirror provisioned (kept so a renamed table is
// not duplicated).
export const portalMirrorState = pgTable("portal_mirror_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// Read-only snapshot of one billing Customer's state, derived from Stripe LISTS (never from
// webhook payloads) by lib/billing-snapshot.ts; the "Client Billing" mirror renders from it.
// One row per client code. dirty_at is set by the account-level billing webhook and cleared by a
// refresh. updated_at is bumped ONLY when content_hash changes (no $onUpdate), so the mirror loop
// sees real changes, not refreshes that found nothing new.
export const billingSnapshots = pgTable("billing_snapshots", {
  clientCode: text("client_code")
    .primaryKey()
    .references(() => billingCustomers.clientCode, { onDelete: "cascade" }),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  // NULL until the first successful refresh (a first refresh that failed has a row with the error).
  rendered: jsonb("rendered").$type<Record<string, string | number | boolean | null>>(),
  contentHash: text("content_hash"),
  dirtyAt: timestamp("dirty_at", { withTimezone: true }),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// "New invoice" form (lib/billing-request-sync.ts): one row per submission of the Nextcloud form
// that creates a one-off invoice or a recurring plan (Subscription Schedule) for a billing_customers
// client on DFWSC's own Stripe account. Progress is saved as it happens: every Stripe object id as
// soon as Stripe returns it, so a retry resumes instead of creating a second invoice.
export const billingRequestSubmissions = pgTable(
  "billing_request_submissions",
  {
    formId: integer("form_id").notNull(),
    submissionId: integer("submission_id").notNull(),
    status: text("status", { enum: ["pending", "completed", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimToken: text("claim_token"),
    // PII-free failure code such as "unauthorized", "company_mismatch" or "stripe.invoice:503".
    lastErrorCode: text("last_error_code"),
    // What was asked, saved once the answers were read (also for requests that fail validation).
    requestedBy: text("requested_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    clientCode: text("client_code"),
    kind: text("kind", { enum: ["one_off", "recurring"] }),
    amountCents: integer("amount_cents"),
    planInterval: text("plan_interval", { enum: ["week", "bi_weekly", "month"] }),
    planPayments: integer("plan_payments"),
    // YYYY-MM-DD, America/Chicago.
    planStartDate: text("plan_start_date"),
    // Stripe objects, saved the moment they exist. Platform account only.
    stripeStartedAt: timestamp("stripe_started_at", { withTimezone: true }),
    stripeProductId: text("stripe_product_id"),
    stripeInvoiceId: text("stripe_invoice_id"),
    stripeInvoiceItemId: text("stripe_invoice_item_id"),
    stripeScheduleId: text("stripe_schedule_id"),
    invoiceFinalizedAt: timestamp("invoice_finalized_at", { withTimezone: true }),
    invoiceSentAt: timestamp("invoice_sent_at", { withTimezone: true }),
    outcome: text("outcome", { enum: ["sent", "draft", "scheduled"] }),
    // Row in the read-only "Billing Requests" Nextcloud Table, and the hash of what it holds.
    ncRowId: integer("nc_row_id"),
    ncRowHash: text("nc_row_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.formId, table.submissionId] }),
    dueIdx: index("billing_request_submissions_due_idx").on(table.status, table.nextAttemptAt),
    statusCheck: check(
      "billing_request_submissions_status_check",
      sql`${table.status} IN ('pending', 'completed', 'failed')`
    ),
    kindCheck: check(
      "billing_request_submissions_kind_check",
      sql`${table.kind} IS NULL OR ${table.kind} IN ('one_off', 'recurring')`
    ),
    intervalCheck: check(
      "billing_request_submissions_interval_check",
      sql`${table.planInterval} IS NULL OR ${table.planInterval} IN ('week', 'bi_weekly', 'month')`
    ),
    outcomeCheck: check(
      "billing_request_submissions_outcome_check",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('sent', 'draft', 'scheduled')`
    ),
  })
);

// Per-form baseline, as for client_onboarding_sync_state: submissions that existed before the
// automation was enabled are never turned into invoices.
export const billingRequestSyncState = pgTable("billing_request_sync_state", {
  formId: integer("form_id").primaryKey(),
  baselineSubmissionId: integer("baseline_submission_id").notNull(),
  baselinedAt: timestamp("baselined_at", { withTimezone: true }).notNull().defaultNow(),
});

// Connected-account invoicing (inert until the invoicing routes land). Customers
// live on the client's connected account; Postgres stores ids and an opaque
// external_ref only, never PII.
export const connectCustomers = pgTable(
  "connect_customers",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    connectedAccountId: text("connected_account_id").notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    // Opaque integrator reference (max 100 chars, no PII); unique per client when set.
    externalRef: text("external_ref"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountCustomerUniq: unique("connect_customers_account_customer_uniq").on(
      table.connectedAccountId,
      table.stripeCustomerId
    ),
    clientExternalRefUniq: uniqueIndex("connect_customers_client_external_ref_uniq")
      .on(table.clientId, table.externalRef)
      .where(sql`${table.externalRef} IS NOT NULL`),
    clientIdempotencyKeyUniq: unique("connect_customers_client_idempotency_key_uniq").on(
      table.clientId,
      table.idempotencyKey
    ),
  })
);

export const connectInvoices = pgTable(
  "connect_invoices",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    connectedAccountId: text("connected_account_id").notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    // Create-flow progress, saved as each Stripe object id arrives so a retry resumes.
    creationState: text("creation_state", {
      enum: ["reserved", "invoice_created", "lines_added", "complete"],
    })
      .notNull()
      .default("reserved"),
    stripeInvoiceId: text("stripe_invoice_id"),
    stripeFeeItemId: text("stripe_fee_item_id"),
    lineItemIds: jsonb("line_item_ids"),
    status: text("status", {
      enum: ["draft", "open", "paid", "void", "uncollectible", "deleted"],
    })
      .notNull()
      .default("draft"),
    currency: text("currency").notNull(),
    subtotalCents: integer("subtotal_cents").notNull(),
    feeAmountCents: integer("fee_amount_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    amountPaidCents: integer("amount_paid_cents").notNull().default(0),
    amountRemainingCents: integer("amount_remaining_cents").notNull(),
    number: text("number"),
    dueDate: timestamp("due_date", { withTimezone: true }),
    hostedInvoiceUrl: text("hosted_invoice_url"),
    invoicePdf: text("invoice_pdf"),
    sendCount: integer("send_count").notNull().default(0),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    // Stripe event ordering can be out-of-order; ignore stale updates.
    lastStripeEventCreatedAt: integer("last_stripe_event_created_at"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    clientIdempotencyKeyUniq: unique("connect_invoices_client_idempotency_key_uniq").on(
      table.clientId,
      table.idempotencyKey
    ),
    stripeInvoiceIdUniq: uniqueIndex("connect_invoices_stripe_invoice_id_uniq")
      .on(table.stripeInvoiceId)
      .where(sql`${table.stripeInvoiceId} IS NOT NULL`),
    clientCreatedIdx: index("connect_invoices_client_created_idx").on(
      table.clientId,
      sql`${table.createdAt} DESC`,
      table.id
    ),
    clientStatusIdx: index("connect_invoices_client_status_idx").on(table.clientId, table.status),
    creationStateCheck: check(
      "connect_invoices_creation_state_check",
      sql`${table.creationState} IN ('reserved', 'invoice_created', 'lines_added', 'complete')`
    ),
    statusCheck: check(
      "connect_invoices_status_check",
      sql`${table.status} IN ('draft', 'open', 'paid', 'void', 'uncollectible', 'deleted')`
    ),
  })
);
