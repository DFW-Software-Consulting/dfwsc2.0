CREATE TABLE "contact_stripe_sync_books" (
	"addressbook" text PRIMARY KEY NOT NULL,
	"sync_token" text,
	"synced_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_stripe_sync_cards" (
	"contact_uid" text PRIMARY KEY NOT NULL,
	"client_code" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"href" text,
	"etag" text,
	"last_hash" text,
	"field_hashes" jsonb,
	"baseline_at" timestamp with time zone,
	"baseline_reset_at" timestamp with time zone,
	"last_pushed_at" timestamp with time zone,
	"last_error" text,
	"last_error_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "contact_stripe_sync_cards_customer_idx" ON "contact_stripe_sync_cards" USING btree ("stripe_customer_id");