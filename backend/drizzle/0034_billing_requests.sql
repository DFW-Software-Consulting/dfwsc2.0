CREATE TABLE "billing_request_submissions" (
	"form_id" integer NOT NULL,
	"submission_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_token" text,
	"last_error_code" text,
	"requested_by" text,
	"submitted_at" timestamp with time zone,
	"client_code" text,
	"kind" text,
	"amount_cents" integer,
	"plan_interval" text,
	"plan_payments" integer,
	"plan_start_date" text,
	"stripe_started_at" timestamp with time zone,
	"stripe_product_id" text,
	"stripe_invoice_id" text,
	"stripe_invoice_item_id" text,
	"stripe_schedule_id" text,
	"invoice_finalized_at" timestamp with time zone,
	"invoice_sent_at" timestamp with time zone,
	"outcome" text,
	"nc_row_id" integer,
	"nc_row_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "billing_request_submissions_form_id_submission_id_pk" PRIMARY KEY("form_id","submission_id"),
	CONSTRAINT "billing_request_submissions_status_check" CHECK ("billing_request_submissions"."status" IN ('pending', 'completed', 'failed')),
	CONSTRAINT "billing_request_submissions_kind_check" CHECK ("billing_request_submissions"."kind" IS NULL OR "billing_request_submissions"."kind" IN ('one_off', 'recurring')),
	CONSTRAINT "billing_request_submissions_interval_check" CHECK ("billing_request_submissions"."plan_interval" IS NULL OR "billing_request_submissions"."plan_interval" IN ('week', 'bi_weekly', 'month')),
	CONSTRAINT "billing_request_submissions_outcome_check" CHECK ("billing_request_submissions"."outcome" IS NULL OR "billing_request_submissions"."outcome" IN ('sent', 'draft', 'scheduled'))
);
--> statement-breakpoint
CREATE TABLE "billing_request_sync_state" (
	"form_id" integer PRIMARY KEY NOT NULL,
	"baseline_submission_id" integer NOT NULL,
	"baselined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "billing_request_submissions_due_idx" ON "billing_request_submissions" USING btree ("status","next_attempt_at");