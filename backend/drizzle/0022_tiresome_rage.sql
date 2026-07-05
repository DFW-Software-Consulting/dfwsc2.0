CREATE TABLE "api_key_regeneration_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"token" text NOT NULL,
	"status" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_regeneration_tokens_token_unique" UNIQUE("token"),
	CONSTRAINT "api_key_regeneration_tokens_status_check" CHECK ("api_key_regeneration_tokens"."status" IN ('pending', 'completed', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "clients" DROP CONSTRAINT "clients_status_check";--> statement-breakpoint
ALTER TABLE "api_key_regeneration_tokens" ADD CONSTRAINT "api_key_regeneration_tokens_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_key_regeneration_tokens_client_id_idx" ON "api_key_regeneration_tokens" USING btree ("client_id");--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_status_check" CHECK ("clients"."status" IN ('active', 'inactive', 'pending', 'failed', 'archived'));