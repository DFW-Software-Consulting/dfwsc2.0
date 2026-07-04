-- Data reconciliation (idempotent) so the NOT NULL + CHECK constraints below
-- can be applied safely on existing production data without aborting the deploy.
UPDATE "admins" SET "created_at" = now() WHERE "created_at" IS NULL;--> statement-breakpoint
UPDATE "admins" SET "updated_at" = now() WHERE "updated_at" IS NULL;--> statement-breakpoint
UPDATE "client_groups" SET "created_at" = now() WHERE "created_at" IS NULL;--> statement-breakpoint
UPDATE "client_groups" SET "updated_at" = now() WHERE "updated_at" IS NULL;--> statement-breakpoint
UPDATE "clients" SET "created_at" = now() WHERE "created_at" IS NULL;--> statement-breakpoint
UPDATE "clients" SET "updated_at" = now() WHERE "updated_at" IS NULL;--> statement-breakpoint
UPDATE "invoices" SET "created_at" = now() WHERE "created_at" IS NULL;--> statement-breakpoint
UPDATE "invoices" SET "updated_at" = now() WHERE "updated_at" IS NULL;--> statement-breakpoint
UPDATE "onboarding_tokens" SET "created_at" = now() WHERE "created_at" IS NULL;--> statement-breakpoint
UPDATE "onboarding_tokens" SET "updated_at" = now() WHERE "updated_at" IS NULL;--> statement-breakpoint
UPDATE "settings" SET "updated_at" = now() WHERE "updated_at" IS NULL;--> statement-breakpoint
UPDATE "webhook_events" SET "created_at" = now() WHERE "created_at" IS NULL;--> statement-breakpoint
-- Reconcile any drifted workspace values back to the only workspace the app
-- recognizes (see lib/workspace.ts); rows with other values are otherwise
-- invisible to the admin UI yet still authenticate. Review before deploying if
-- a genuine second workspace was ever intended.
UPDATE "clients" SET "workspace" = 'client_portal' WHERE "workspace" <> 'client_portal';--> statement-breakpoint
UPDATE "client_groups" SET "workspace" = 'client_portal' WHERE "workspace" <> 'client_portal';--> statement-breakpoint
ALTER TABLE "admins" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "admins" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "client_groups" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "client_groups" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "onboarding_tokens" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "onboarding_tokens" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_stripe_customer_id_unique_idx" ON "clients" USING btree ("stripe_customer_id") WHERE "clients"."stripe_customer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "invoices_client_id_idx" ON "invoices" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "invoices_stripe_invoice_id_idx" ON "invoices" USING btree ("stripe_invoice_id");--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_idx" ON "webhook_events" USING btree ("processed_at") WHERE "webhook_events"."processed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "client_groups" ADD CONSTRAINT "client_groups_workspace_check" CHECK ("client_groups"."workspace" IN ('client_portal'));--> statement-breakpoint
ALTER TABLE "client_groups" ADD CONSTRAINT "client_groups_status_check" CHECK ("client_groups"."status" IN ('active', 'inactive'));--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_workspace_check" CHECK ("clients"."workspace" IN ('client_portal'));--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_status_check" CHECK ("clients"."status" IN ('active', 'inactive', 'pending', 'failed'));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_status_check" CHECK ("invoices"."status" IN ('draft', 'sent', 'paid', 'overdue', 'void'));--> statement-breakpoint
ALTER TABLE "onboarding_tokens" ADD CONSTRAINT "onboarding_tokens_status_check" CHECK ("onboarding_tokens"."status" IN ('pending', 'in_progress', 'completed', 'revoked'));