ALTER TABLE "clients" DROP CONSTRAINT IF EXISTS "clients_status_check";--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_status_check" CHECK ("status" IN ('active', 'inactive', 'pending', 'failed', 'archived'));
