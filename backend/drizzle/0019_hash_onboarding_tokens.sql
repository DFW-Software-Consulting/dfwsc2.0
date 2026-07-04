CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
UPDATE "onboarding_tokens"
SET "token" = encode(digest("token", 'sha256'), 'hex')
WHERE length("token") <> 64
   OR "token" !~ '^[0-9a-f]{64}$';
