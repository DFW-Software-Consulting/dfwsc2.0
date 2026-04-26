CREATE TABLE IF NOT EXISTS "profile_sync_state" (
  "client_id" text PRIMARY KEY NOT NULL,
  "external_source" text DEFAULT 'nextcloud' NOT NULL,
  "external_id" text,
  "sync_status" text DEFAULT 'pending' NOT NULL,
  "sync_error" text,
  "sync_attempts" integer DEFAULT 0 NOT NULL,
  "last_sync_attempt_at" timestamp with time zone,
  "last_synced_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "profile_sync_state_client_id_clients_id_fk"
    FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "profile_sync_state_sync_status_check"
    CHECK ("sync_status" IN ('synced', 'pending', 'failed'))
);

CREATE INDEX IF NOT EXISTS "profile_sync_state_external_id_idx"
  ON "profile_sync_state" ("external_id");
