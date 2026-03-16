ALTER TABLE "client_groups" ADD COLUMN "processing_fee_percent" numeric(5, 2);
ALTER TABLE "client_groups" ADD COLUMN "processing_fee_cents" integer;
ALTER TABLE "client_groups" ADD COLUMN "payment_success_url" text;
ALTER TABLE "client_groups" ADD COLUMN "payment_cancel_url" text;
