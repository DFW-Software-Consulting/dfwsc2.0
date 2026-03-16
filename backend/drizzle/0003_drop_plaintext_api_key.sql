-- Remove plaintext api_key column; all keys must be hashed (api_key_hash + api_key_lookup)
-- Run migrate-api-keys script before applying this migration if any plaintext keys exist
ALTER TABLE "clients" DROP COLUMN IF EXISTS "api_key";
