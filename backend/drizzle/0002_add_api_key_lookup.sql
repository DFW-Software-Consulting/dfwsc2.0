-- Add api_key_lookup column for O(1) API key authentication
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "api_key_lookup" text UNIQUE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clients_api_key_lookup_idx" ON "clients" ("api_key_lookup");
