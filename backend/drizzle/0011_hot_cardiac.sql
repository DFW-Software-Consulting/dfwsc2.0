DROP TABLE "invoice_sync_state" CASCADE;--> statement-breakpoint
DROP TABLE "profile_sync_state" CASCADE;--> statement-breakpoint
ALTER TABLE "clients" DROP COLUMN "last_contact_at";--> statement-breakpoint
ALTER TABLE "clients" DROP COLUMN "next_action";--> statement-breakpoint
ALTER TABLE "clients" DROP COLUMN "follow_up_at";--> statement-breakpoint
ALTER TABLE "clients" DROP COLUMN "payment_status";--> statement-breakpoint
ALTER TABLE "clients" DROP COLUMN "payment_status_synced_at";--> statement-breakpoint
ALTER TABLE "clients" DROP COLUMN "suspended_at";--> statement-breakpoint
ALTER TABLE "clients" DROP COLUMN "suspension_reason";