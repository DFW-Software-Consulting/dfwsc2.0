ALTER TABLE "client_groups" ADD COLUMN "workspace" text DEFAULT 'client_portal' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "workspace" text DEFAULT 'client_portal' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "billing_contact_name" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "address_line1" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "address_line2" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "default_payment_terms_days" integer;