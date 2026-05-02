ALTER TABLE "clients" ADD COLUMN "payment_status" text DEFAULT 'none';--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "payment_status_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "suspension_reason" text;