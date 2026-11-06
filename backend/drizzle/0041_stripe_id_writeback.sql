CREATE TABLE "stripe_id_writebacks" (
	"target" text NOT NULL,
	"target_key" text NOT NULL,
	"nc_row_id" integer,
	"addressbook" text,
	"card_href" text,
	"desired_hash" text,
	"written_hash" text,
	"written_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"status" text DEFAULT 'ok' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_id_writebacks_target_target_key_pk" PRIMARY KEY("target","target_key"),
	CONSTRAINT "stripe_id_writebacks_target_check" CHECK ("stripe_id_writebacks"."target" IN ('project_row', 'contact_card')),
	CONSTRAINT "stripe_id_writebacks_status_check" CHECK ("stripe_id_writebacks"."status" IN ('ok', 'not_found', 'ambiguous', 'read_only', 'forbidden', 'error'))
);
