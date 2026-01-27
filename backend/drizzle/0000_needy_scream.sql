CREATE TABLE "clients" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"api_key" text,
	"api_key_hash" text,
	"stripe_account_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "clients_api_key_unique" UNIQUE("api_key"),
	CONSTRAINT "clients_api_key_hash_unique" UNIQUE("api_key_hash")
);
--> statement-breakpoint
CREATE TABLE "onboarding_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"token" text NOT NULL,
	"status" text NOT NULL,
	"email" text NOT NULL,
	"state" text,
	"state_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "onboarding_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"stripe_event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "webhook_events_stripe_event_id_unique" UNIQUE("stripe_event_id")
);
