CREATE TABLE "connect_invoice_sends" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"client_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connect_invoice_sends_invoice_key_uniq" UNIQUE("invoice_id","key_hash"),
	CONSTRAINT "connect_invoice_sends_state_check" CHECK ("connect_invoice_sends"."state" IN ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "connect_invoices" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "connect_invoices" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "connect_invoice_sends" ADD CONSTRAINT "connect_invoice_sends_invoice_id_connect_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."connect_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_invoice_sends" ADD CONSTRAINT "connect_invoice_sends_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;