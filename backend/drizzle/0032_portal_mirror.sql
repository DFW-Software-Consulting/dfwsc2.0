CREATE TABLE "portal_mirror_rows" (
	"kind" text NOT NULL,
	"source_id" text NOT NULL,
	"nc_row_id" integer,
	"content_hash" text,
	"synced_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_mirror_rows_kind_source_id_pk" PRIMARY KEY("kind","source_id"),
	CONSTRAINT "portal_mirror_rows_kind_check" CHECK ("portal_mirror_rows"."kind" IN ('account'))
);
