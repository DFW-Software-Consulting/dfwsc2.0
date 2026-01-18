-- Add index on api_key_hash for faster lookups
CREATE INDEX IF NOT EXISTS "clients_api_key_hash_idx" ON "clients" ("api_key_hash");
--> statement-breakpoint
-- Add foreign key constraint on onboarding_tokens.client_id
ALTER TABLE "onboarding_tokens" ADD CONSTRAINT "onboarding_tokens_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
