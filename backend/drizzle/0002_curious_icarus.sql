ALTER TABLE "client_groups" ADD COLUMN "workspace" text DEFAULT 'client_portal' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "workspace" text DEFAULT 'client_portal' NOT NULL;
