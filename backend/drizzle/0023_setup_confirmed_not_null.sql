UPDATE "admins" SET "setup_confirmed" = false WHERE "setup_confirmed" IS NULL;--> statement-breakpoint
ALTER TABLE "admins" ALTER COLUMN "setup_confirmed" SET NOT NULL;