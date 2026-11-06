CREATE TABLE "billing_customers" (
	"client_code" text PRIMARY KEY NOT NULL,
	"company" text NOT NULL,
	"email" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_customers_source_check" CHECK ("billing_customers"."source" IN ('created', 'matched', 'backfill'))
);
--> statement-breakpoint
ALTER TABLE "client_onboarding_submissions" ADD COLUMN "billing_status" text;--> statement-breakpoint
ALTER TABLE "client_onboarding_submissions" ADD COLUMN "billing_customer_id" text;--> statement-breakpoint
CREATE INDEX "billing_customers_email_idx" ON "billing_customers" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "billing_customers_stripe_customer_id_idx" ON "billing_customers" USING btree ("stripe_customer_id");--> statement-breakpoint
ALTER TABLE "client_onboarding_submissions" ADD CONSTRAINT "client_onboarding_submissions_billing_status_check" CHECK ("client_onboarding_submissions"."billing_status" IS NULL OR "client_onboarding_submissions"."billing_status" IN ('linked', 'ambiguous', 'no_email'));