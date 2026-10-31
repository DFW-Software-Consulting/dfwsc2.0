CREATE TABLE "client_onboarding_submissions" (
	"form_id" integer NOT NULL,
	"submission_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_token" text,
	"last_error_code" text,
	"folder_name" text,
	"folder_file_id" bigint,
	"contact_status" text,
	"contact_uid" text,
	"project_number" integer,
	"project_code" text,
	"table_row_id" integer,
	"page_id" integer,
	"page_url" text,
	"page_content_at" timestamp with time zone,
	"links_backfilled_at" timestamp with time zone,
	"lead_status" text,
	"lead_row_id" integer,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_onboarding_submissions_form_id_submission_id_pk" PRIMARY KEY("form_id","submission_id"),
	CONSTRAINT "client_onboarding_submissions_status_check" CHECK ("client_onboarding_submissions"."status" IN ('pending', 'completed', 'failed')),
	CONSTRAINT "client_onboarding_submissions_contact_status_check" CHECK ("client_onboarding_submissions"."contact_status" IS NULL OR "client_onboarding_submissions"."contact_status" IN ('created', 'updated', 'ambiguous')),
	CONSTRAINT "client_onboarding_submissions_lead_status_check" CHECK ("client_onboarding_submissions"."lead_status" IS NULL OR "client_onboarding_submissions"."lead_status" IN ('won', 'no_match', 'ambiguous', 'already_linked'))
);
--> statement-breakpoint
CREATE TABLE "client_onboarding_sync_state" (
	"form_id" integer PRIMARY KEY NOT NULL,
	"baseline_submission_id" integer NOT NULL,
	"baselined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "client_onboarding_submissions_due_idx" ON "client_onboarding_submissions" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "client_onboarding_submissions_project_number_idx" ON "client_onboarding_submissions" USING btree ("project_number");--> statement-breakpoint
CREATE UNIQUE INDEX "client_onboarding_submissions_project_code_idx" ON "client_onboarding_submissions" USING btree ("project_code");