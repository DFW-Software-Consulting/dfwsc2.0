import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { clients } from "../db/schema";

// Cerebo lives in its own Postgres schema so its tables stay apart from the
// payment tables while sharing the database, migrations and admin auth. Every
// row carries client_id, and every reference between Cerebo rows is a composite
// (client_id, id) foreign key, so the database refuses a link that crosses
// clients even if an application query forgets to filter.
export const cerebo = pgSchema("cerebo");

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const PROJECT_STATUSES = ["planned", "active", "paused", "completed", "canceled"] as const;
export const MILESTONE_STATUSES = ["planned", "in_progress", "done", "canceled"] as const;
export const RESOURCE_KINDS = [
  "deck_board",
  "files_folder",
  "talk_room",
  "collective",
  "contact",
  "calendar",
] as const;
export const AUDIT_ACTOR_TYPES = ["admin", "system"] as const;
export const AUDIT_ACTIONS = ["create", "update", "delete"] as const;

function inList(values: readonly string[]) {
  return sql.raw(values.map((v) => `'${v}'`).join(", "));
}

// Clients are archived rather than deleted, so a client that still has Cerebo
// rows cannot be deleted out from under them (the default NO ACTION).
const clientId = () =>
  text("client_id")
    .notNull()
    .references(() => clients.id);

export const projects = cerebo.table(
  "projects",
  {
    id: text("id").primaryKey(),
    clientId: clientId(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status", { enum: PROJECT_STATUSES }).notNull().default("planned"),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    ...timestamps,
  },
  (table) => ({
    clientIdUnique: unique("projects_client_id_unique").on(table.clientId, table.id),
    clientStatusIdx: index("projects_client_status_idx").on(table.clientId, table.status),
    statusCheck: check(
      "projects_status_check",
      sql`${table.status} IN (${inList(PROJECT_STATUSES)})`
    ),
    datesCheck: check(
      "projects_dates_check",
      sql`${table.endsOn} IS NULL OR ${table.startsOn} IS NULL OR ${table.endsOn} >= ${table.startsOn}`
    ),
  })
);

export const milestones = cerebo.table(
  "milestones",
  {
    id: text("id").primaryKey(),
    clientId: clientId(),
    projectId: text("project_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status", { enum: MILESTONE_STATUSES }).notNull().default("planned"),
    dueOn: date("due_on"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Shown to the client once the client portal exists; internal by default.
    clientVisible: boolean("client_visible").notNull().default(false),
    stripeInvoiceId: text("stripe_invoice_id"),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (table) => ({
    projectFk: foreignKey({
      name: "milestones_project_fk",
      columns: [table.clientId, table.projectId],
      foreignColumns: [projects.clientId, projects.id],
    }).onDelete("cascade"),
    projectOrderIdx: index("milestones_project_order_idx").on(
      table.clientId,
      table.projectId,
      table.sortOrder
    ),
    statusCheck: check(
      "milestones_status_check",
      sql`${table.status} IN (${inList(MILESTONE_STATUSES)})`
    ),
  })
);

// Where a client's or project's work lives outside the portal. external_id is
// whatever the target system addresses it by: Deck board id, WebDAV path, Talk
// room token, Collectives id, vCard uid, CalDAV calendar uri.
export const resourceLinks = cerebo.table(
  "resource_links",
  {
    id: text("id").primaryKey(),
    clientId: clientId(),
    // Null for client-level resources (a client's contact card or collective).
    projectId: text("project_id"),
    kind: text("kind", { enum: RESOURCE_KINDS }).notNull(),
    externalId: text("external_id").notNull(),
    url: text("url"),
    label: text("label"),
    ...timestamps,
  },
  (table) => ({
    // Nullable project_id: MATCH SIMPLE skips the check when it is NULL.
    projectFk: foreignKey({
      name: "resource_links_project_fk",
      columns: [table.clientId, table.projectId],
      foreignColumns: [projects.clientId, projects.id],
    }).onDelete("cascade"),
    externalUnique: unique("resource_links_client_kind_external_unique").on(
      table.clientId,
      table.kind,
      table.externalId
    ),
    projectIdx: index("resource_links_project_idx").on(table.clientId, table.projectId),
    kindCheck: check(
      "resource_links_kind_check",
      sql`${table.kind} IN (${inList(RESOURCE_KINDS)})`
    ),
  })
);

// Append-only record of every Cerebo write, in the same transaction as the
// change it describes.
export const auditEvents = cerebo.table(
  "audit_events",
  {
    id: text("id").primaryKey(),
    clientId: clientId(),
    actorType: text("actor_type", { enum: AUDIT_ACTOR_TYPES }).notNull(),
    actorId: text("actor_id"),
    action: text("action", { enum: AUDIT_ACTIONS }).notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    changes: jsonb("changes").$type<Record<string, unknown>>().notNull().default({}),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    entityIdx: index("audit_events_entity_idx").on(
      table.entityType,
      table.entityId,
      table.createdAt
    ),
    clientCreatedIdx: index("audit_events_client_created_idx").on(table.clientId, table.createdAt),
    actorTypeCheck: check(
      "audit_events_actor_type_check",
      sql`${table.actorType} IN (${inList(AUDIT_ACTOR_TYPES)})`
    ),
    actionCheck: check(
      "audit_events_action_check",
      sql`${table.action} IN (${inList(AUDIT_ACTIONS)})`
    ),
  })
);
