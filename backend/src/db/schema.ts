import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const clients = pgTable("clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  apiKeyHash: text("api_key_hash").unique(),
  apiKeyLookup: text("api_key_lookup").unique(),
  stripeAccountId: text("stripe_account_id"),
  status: text("status", { enum: ["active", "inactive"] })
    .default("active")
    .notNull(),
  paymentSuccessUrl: text("payment_success_url"),
  paymentCancelUrl: text("payment_cancel_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => ({
  apiKeyHashIdx: index("clients_api_key_hash_idx").on(table.apiKeyHash),
  apiKeyLookupIdx: index("clients_api_key_lookup_idx").on(table.apiKeyLookup),
}));

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
  clientId: text("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  status: text("status").notNull(),
  email: text("email").notNull(),
  state: text("state"),
  stateExpiresAt: timestamp("state_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
