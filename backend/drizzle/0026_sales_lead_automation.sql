CREATE TABLE "sales_lead_submissions" (
	"form_id" integer NOT NULL,
	"submission_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_token" text,
	"last_error_code" text,
	"table_row_id" integer,
	"contact_uid" text,
	"folder_name" text,
	"folder_file_id" bigint,
	"links_backfilled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_lead_submissions_form_id_submission_id_pk" PRIMARY KEY("form_id","submission_id"),
	CONSTRAINT "sales_lead_submissions_status_check" CHECK ("sales_lead_submissions"."status" IN ('pending', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "sales_lead_sync_state" (
	"form_id" integer PRIMARY KEY NOT NULL,
	"baseline_submission_id" integer NOT NULL,
	"baselined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sales_lead_submissions_due_idx" ON "sales_lead_submissions" USING btree ("status","next_attempt_at");