ALTER TABLE "clients" DROP CONSTRAINT "clients_group_id_client_groups_id_fk";
--> statement-breakpoint
ALTER TABLE "admins" ALTER COLUMN "role" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "admins" ALTER COLUMN "active" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "charges_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "payouts_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "details_submitted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "currency" text DEFAULT 'usd' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_group_id_client_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."client_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_groups_workspace_idx" ON "client_groups" USING btree ("workspace");--> statement-breakpoint
CREATE INDEX "clients_group_id_idx" ON "clients" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "clients_workspace_idx" ON "clients" USING btree ("workspace");--> statement-breakpoint
CREATE INDEX "onboarding_tokens_client_state_idx" ON "onboarding_tokens" USING btree ("client_id","state");--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_stripe_account_id_unique" UNIQUE("stripe_account_id");