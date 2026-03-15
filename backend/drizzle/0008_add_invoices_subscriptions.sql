CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"description" text NOT NULL,
	"interval" text NOT NULL,
	"total_payments" integer,
	"payments_made" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"next_billing_date" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "subscriptions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"subscription_id" text,
	"amount_cents" integer NOT NULL,
	"description" text NOT NULL,
	"due_date" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"payment_token" text NOT NULL,
	"paid_at" timestamp with time zone,
	"mock_payment_id" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "invoices_payment_token_unique" UNIQUE("payment_token"),
	CONSTRAINT "invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "invoices_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action
);
