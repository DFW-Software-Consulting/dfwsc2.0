import { pgTable, unique, text, jsonb, timestamp, foreignKey, numeric, integer, index, boolean } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const webhookEvents = pgTable("webhook_events", {
	id: text().primaryKey().notNull(),
	stripeEventId: text("stripe_event_id").notNull(),
	type: text().notNull(),
	payload: jsonb().notNull(),
	processedAt: timestamp("processed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	unique("webhook_events_stripe_event_id_unique").on(table.stripeEventId),
]);

export const onboardingTokens = pgTable("onboarding_tokens", {
	id: text().primaryKey().notNull(),
	clientId: text("client_id").notNull(),
	token: text().notNull(),
	status: text().notNull(),
	email: text().notNull(),
	state: text(),
	stateExpiresAt: timestamp("state_expires_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	foreignKey({
			columns: [table.clientId],
			foreignColumns: [clients.id],
			name: "onboarding_tokens_client_id_clients_id_fk"
		}).onDelete("cascade"),
	unique("onboarding_tokens_token_unique").on(table.token),
]);

export const clientGroups = pgTable("client_groups", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	status: text().default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	processingFeePercent: numeric("processing_fee_percent", { precision: 5, scale:  2 }),
	processingFeeCents: integer("processing_fee_cents"),
	paymentSuccessUrl: text("payment_success_url"),
	paymentCancelUrl: text("payment_cancel_url"),
});

export const clients = pgTable("clients", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	email: text().notNull(),
	apiKey: text("api_key"),
	apiKeyHash: text("api_key_hash"),
	stripeAccountId: text("stripe_account_id"),
	status: text().default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	apiKeyLookup: text("api_key_lookup"),
	paymentSuccessUrl: text("payment_success_url"),
	paymentCancelUrl: text("payment_cancel_url"),
	processingFeePercent: numeric("processing_fee_percent", { precision: 5, scale:  2 }),
	processingFeeCents: integer("processing_fee_cents"),
	groupId: text("group_id"),
	stripeCustomerId: text("stripe_customer_id"),
}, (table) => [
	index("clients_api_key_hash_idx").using("btree", table.apiKeyHash.asc().nullsLast().op("text_ops")),
	index("clients_api_key_lookup_idx").using("btree", table.apiKeyLookup.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.groupId],
			foreignColumns: [clientGroups.id],
			name: "clients_group_id_fkey"
		}),
	unique("clients_api_key_unique").on(table.apiKey),
	unique("clients_api_key_hash_unique").on(table.apiKeyHash),
	unique("clients_api_key_lookup_key").on(table.apiKeyLookup),
]);

export const admins = pgTable("admins", {
	id: text().primaryKey().notNull(),
	username: text().notNull(),
	passwordHash: text("password_hash").notNull(),
	role: text().default('admin'),
	active: boolean().default(true),
	setupConfirmed: boolean("setup_confirmed").default(false),
	lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	unique("admins_username_key").on(table.username),
]);
