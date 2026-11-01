CREATE TABLE "connect_customers" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"connected_account_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"external_ref" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connect_customers_account_customer_uniq" UNIQUE("connected_account_id","stripe_customer_id"),
	CONSTRAINT "connect_customers_client_idempotency_key_uniq" UNIQUE("client_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "connect_invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"connected_account_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"creation_state" text DEFAULT 'reserved' NOT NULL,
	"stripe_invoice_id" text,
	"stripe_fee_item_id" text,
	"line_item_ids" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" text NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"fee_amount_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"amount_paid_cents" integer DEFAULT 0 NOT NULL,
	"amount_remaining_cents" integer NOT NULL,
	"number" text,
	"due_date" timestamp with time zone,
	"hosted_invoice_url" text,
	"invoice_pdf" text,
	"send_count" integer DEFAULT 0 NOT NULL,
	"finalized_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"last_stripe_event_created_at" integer,
	"last_synced_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connect_invoices_client_idempotency_key_uniq" UNIQUE("client_id","idempotency_key"),
	CONSTRAINT "connect_invoices_creation_state_check" CHECK ("connect_invoices"."creation_state" IN ('reserved', 'invoice_created', 'lines_added', 'complete')),
	CONSTRAINT "connect_invoices_status_check" CHECK ("connect_invoices"."status" IN ('draft', 'open', 'paid', 'void', 'uncollectible', 'deleted'))
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "invoicing_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "connect_customers" ADD CONSTRAINT "connect_customers_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_invoices" ADD CONSTRAINT "connect_invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connect_customers_client_external_ref_uniq" ON "connect_customers" USING btree ("client_id","external_ref") WHERE "connect_customers"."external_ref" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "connect_invoices_stripe_invoice_id_uniq" ON "connect_invoices" USING btree ("stripe_invoice_id") WHERE "connect_invoices"."stripe_invoice_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "connect_invoices_client_created_idx" ON "connect_invoices" USING btree ("client_id","created_at" DESC,"id");--> statement-breakpoint
CREATE INDEX "connect_invoices_client_status_idx" ON "connect_invoices" USING btree ("client_id","status");