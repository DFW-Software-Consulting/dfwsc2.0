ALTER TABLE "payment_ledger" DROP CONSTRAINT "payment_ledger_idempotency_key_unique";--> statement-breakpoint
DROP INDEX "payment_ledger_session_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "payment_ledger_session_id_uniq" ON "payment_ledger" USING btree ("stripe_session_id") WHERE "payment_ledger"."stripe_session_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_ledger_client_idempotency_key_uniq" ON "payment_ledger" USING btree ("client_id","idempotency_key");