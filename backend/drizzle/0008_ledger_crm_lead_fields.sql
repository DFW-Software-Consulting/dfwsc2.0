ALTER TABLE "clients" ADD COLUMN "last_contact_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "next_action" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "follow_up_at" timestamp with time zone;
