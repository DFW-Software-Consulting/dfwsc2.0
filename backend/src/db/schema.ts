import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export const clients = pgTable("clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  stripeAccountId: text("stripe_account_id"),
  status: text("status", { enum: ["active", "inactive"] })
    .default("active")
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

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
  clientId: text("client_id").notNull(),
  token: text("token").notNull().unique(),
  status: text("status").notNull(),
  email: text("email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
