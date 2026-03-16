CREATE TABLE IF NOT EXISTS "client_groups" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);

ALTER TABLE "clients" ADD COLUMN "group_id" text REFERENCES "client_groups"("id");
