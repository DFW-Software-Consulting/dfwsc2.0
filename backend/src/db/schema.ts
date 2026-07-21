import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
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
    // The idempotency key used when creating the Stripe session/PI.
    // Unique per creation attempt; prevents duplicate ledger rows.
    idempotencyKey: text("idempotency_key").notNull().unique(),
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
    sessionIdIdx: index("payment_ledger_session_id_idx")
      .on(table.stripeSessionId)
      .where(sql`${table.stripeSessionId} IS NOT NULL`),
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
