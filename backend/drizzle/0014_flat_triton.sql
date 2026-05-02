CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"invoice_number" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"due_date" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"stripe_invoice_id" text,
	"nextcloud_id" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;