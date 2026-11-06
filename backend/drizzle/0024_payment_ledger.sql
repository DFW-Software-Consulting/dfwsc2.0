CREATE TABLE "payment_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"connected_account_id" text NOT NULL,
	"stripe_session_id" text,
	"stripe_payment_intent_id" text,
	"client_id" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"base_amount_cents" integer NOT NULL,
	"total_amount_cents" integer NOT NULL,
	"fee_amount_cents" integer NOT NULL,
	"refunded_amount_cents" integer DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"metadata" text,
	"last_stripe_event_created_at" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_ledger_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "payment_ledger_source_check" CHECK ("payment_ledger"."source" IN ('checkout', 'payment_intent')),
	CONSTRAINT "payment_ledger_status_check" CHECK ("payment_ledger"."status" IN ('created', 'paid', 'expired', 'failed', 'refunded', 'disputed', 'canceled'))
);
--> statement-breakpoint
ALTER TABLE "payment_ledger" ADD CONSTRAINT "payment_ledger_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_ledger_client_id_idx" ON "payment_ledger" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "payment_ledger_session_id_idx" ON "payment_ledger" USING btree ("stripe_session_id") WHERE "payment_ledger"."stripe_session_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payment_ledger_pi_id_idx" ON "payment_ledger" USING btree ("stripe_payment_intent_id") WHERE "payment_ledger"."stripe_payment_intent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payment_ledger_connected_account_idx" ON "payment_ledger" USING btree ("connected_account_id");