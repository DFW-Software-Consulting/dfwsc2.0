CREATE SCHEMA "cerebo";
--> statement-breakpoint
CREATE TABLE "cerebo"."audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_actor_type_check" CHECK ("cerebo"."audit_events"."actor_type" IN ('admin', 'system')),
	CONSTRAINT "audit_events_action_check" CHECK ("cerebo"."audit_events"."action" IN ('create', 'update', 'delete'))
);
--> statement-breakpoint
CREATE TABLE "cerebo"."milestones" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"due_on" date,
	"completed_at" timestamp with time zone,
	"client_visible" boolean DEFAULT false NOT NULL,
	"stripe_invoice_id" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "milestones_status_check" CHECK ("cerebo"."milestones"."status" IN ('planned', 'in_progress', 'done', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "cerebo"."projects" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_client_id_unique" UNIQUE("client_id","id"),
	CONSTRAINT "projects_status_check" CHECK ("cerebo"."projects"."status" IN ('planned', 'active', 'paused', 'completed', 'canceled')),
	CONSTRAINT "projects_dates_check" CHECK ("cerebo"."projects"."ends_on" IS NULL OR "cerebo"."projects"."starts_on" IS NULL OR "cerebo"."projects"."ends_on" >= "cerebo"."projects"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "cerebo"."resource_links" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"project_id" text,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_links_client_kind_external_unique" UNIQUE("client_id","kind","external_id"),
	CONSTRAINT "resource_links_kind_check" CHECK ("cerebo"."resource_links"."kind" IN ('deck_board', 'files_folder', 'talk_room', 'collective', 'contact', 'calendar'))
);
--> statement-breakpoint
ALTER TABLE "cerebo"."audit_events" ADD CONSTRAINT "audit_events_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cerebo"."milestones" ADD CONSTRAINT "milestones_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cerebo"."milestones" ADD CONSTRAINT "milestones_project_fk" FOREIGN KEY ("client_id","project_id") REFERENCES "cerebo"."projects"("client_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cerebo"."projects" ADD CONSTRAINT "projects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cerebo"."resource_links" ADD CONSTRAINT "resource_links_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cerebo"."resource_links" ADD CONSTRAINT "resource_links_project_fk" FOREIGN KEY ("client_id","project_id") REFERENCES "cerebo"."projects"("client_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "cerebo"."audit_events" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_client_created_idx" ON "cerebo"."audit_events" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "milestones_project_order_idx" ON "cerebo"."milestones" USING btree ("client_id","project_id","sort_order");--> statement-breakpoint
CREATE INDEX "projects_client_status_idx" ON "cerebo"."projects" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "resource_links_project_idx" ON "cerebo"."resource_links" USING btree ("client_id","project_id");