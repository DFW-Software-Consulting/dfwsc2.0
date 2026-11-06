ALTER TABLE "client_onboarding_submissions" ADD COLUMN "team_id" text;--> statement-breakpoint
ALTER TABLE "client_onboarding_submissions" ADD COLUMN "team_members_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client_onboarding_submissions" ADD COLUMN "collective_id" integer;--> statement-breakpoint
ALTER TABLE "client_onboarding_submissions" ADD COLUMN "collective_content_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client_onboarding_submissions" ADD COLUMN "folder_share_id" integer;