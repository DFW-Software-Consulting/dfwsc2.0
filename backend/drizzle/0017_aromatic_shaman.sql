DROP TABLE "invoices" CASCADE;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "claimed_at" timestamp with time zone;