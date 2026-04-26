import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const clientGroups = pgTable("client_groups", {
  id: text("id").primaryKey(),
  workspace: text("workspace", { enum: ["dfwsc_services", "client_portal", "ledger_crm"] })
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const clients = pgTable(
  "clients",
  {
    id: text("id").primaryKey(),
    workspace: text("workspace", { enum: ["dfwsc_services", "client_portal", "ledger_crm"] })
      .default("client_portal")
      .notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    apiKeyHash: text("api_key_hash").unique(),
    apiKeyLookup: text("api_key_lookup").unique(),
    stripeAccountId: text("stripe_account_id"),
    stripeCustomerId: text("stripe_customer_id"),
    status: text("status", { enum: ["active", "inactive", "lead"] })
      .default("active")
      .notNull(),
    groupId: text("group_id").references(() => clientGroups.id),
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
    lastContactAt: timestamp("last_contact_at", { withTimezone: true }),
    nextAction: text("next_action"),
    followUpAt: timestamp("follow_up_at", { withTimezone: true }),
    defaultPaymentTermsDays: integer("default_payment_terms_days"),
    paymentStatus: text("payment_status", {
      enum: ["active", "past_due", "canceled", "unpaid", "trialing", "none"],
    }).default("none"),
    paymentStatusSyncedAt: timestamp("payment_status_synced_at", { withTimezone: true }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    suspensionReason: text("suspension_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    apiKeyHashIdx: index("clients_api_key_hash_idx").on(table.apiKeyHash),
    apiKeyLookupIdx: index("clients_api_key_lookup_idx").on(table.apiKeyLookup),
    emailWorkspaceUnique: unique("clients_email_workspace_unique").on(table.email, table.workspace),
  })
);

export const webhookEvents = pgTable("webhook_events", {
  id: text("id").primaryKey(),
  stripeEventId: text("stripe_event_id").notNull().unique(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const onboardingTokens = pgTable("onboarding_tokens", {
  id: text("id").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  status: text("status").notNull(),
  email: text("email").notNull(),
  state: text("state"),
  stateExpiresAt: timestamp("state_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const profileSyncState = pgTable("profile_sync_state", {
  clientId: text("client_id")
    .primaryKey()
    .references(() => clients.id, { onDelete: "cascade" }),
  externalSource: text("external_source").default("nextcloud").notNull(),
  externalId: text("external_id"),
  syncStatus: text("sync_status", { enum: ["synced", "pending", "failed"] })
    .default("pending")
    .notNull(),
  syncError: text("sync_error"),
  syncAttempts: integer("sync_attempts").default(0).notNull(),
  lastSyncAttemptAt: timestamp("last_sync_attempt_at", { withTimezone: true }),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const invoiceSyncState = pgTable(
  "invoice_sync_state",
  {
    stripeInvoiceId: text("stripe_invoice_id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    externalSource: text("external_source").default("nextcloud").notNull(),
    externalId: text("external_id"),
    syncStatus: text("sync_status", { enum: ["synced", "pending", "failed"] })
      .default("pending")
      .notNull(),
    syncError: text("sync_error"),
    syncAttempts: integer("sync_attempts").default(0).notNull(),
    lastSyncAttemptAt: timestamp("last_sync_attempt_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    invoiceSyncStateClientIdIdx: index("invoice_sync_state_client_id_idx").on(table.clientId),
    invoiceSyncStateExternalIdIdx: index("invoice_sync_state_external_id_idx").on(
      table.externalId
    ),
  })
);

export const admins = pgTable("admins", {
  id: text("id").primaryKey(),
  username: text("username").unique().notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").default("admin"),
  active: boolean("active").default(true),
  setupConfirmed: boolean("setup_confirmed").default(false),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
