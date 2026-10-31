CREATE TABLE "billing_snapshots" (
	"client_code" text PRIMARY KEY NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"rendered" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"dirty_at" timestamp with time zone,
	"refreshed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portal_mirror_rows" DROP CONSTRAINT "portal_mirror_rows_kind_check";--> statement-breakpoint
ALTER TABLE "billing_snapshots" ADD CONSTRAINT "billing_snapshots_client_code_billing_customers_client_code_fk" FOREIGN KEY ("client_code") REFERENCES "public"."billing_customers"("client_code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_mirror_rows" ADD CONSTRAINT "portal_mirror_rows_kind_check" CHECK ("portal_mirror_rows"."kind" IN ('account', 'billing'));