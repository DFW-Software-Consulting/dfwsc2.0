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
  workspace: text("workspace", { enum: ["client_portal", "dfwsc"] })
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
    workspace: text("workspace", { enum: ["client_portal", "dfwsc"] })
      .default("client_portal")
      .notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    apiKeyHash: text("api_key_hash").unique(),
    apiKeyLookup: text("api_key_lookup").unique(),
    stripeAccountId: text("stripe_account_id"),
    stripeCustomerId: text("stripe_customer_id"),
    status: text("status", { enum: ["active", "inactive"] })
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
    defaultPaymentTermsDays: integer("default_payment_terms_days"),
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
