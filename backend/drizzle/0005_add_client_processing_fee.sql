ALTER TABLE "clients" ADD COLUMN "processing_fee_percent" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "processing_fee_cents" integer;
