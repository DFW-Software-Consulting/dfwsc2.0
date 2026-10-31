import { sql } from "drizzle-orm";
import { db } from "../db/client";

type TableColumns = {
  table: string;
  columns: string[];
};

export const REQUIRED_TABLES: TableColumns[] = [
  {
    table: "clients",
    columns: [
      "id",
      "name",
      "email",
      "api_key_hash",
      "api_key_lookup",
      "stripe_account_id",
      "stripe_customer_id",
      "status",
      "charges_enabled",
      "payouts_enabled",
      "details_submitted",
      "workspace",
      "group_id",
      "created_at",
      "updated_at",
    ],
  },
  {
    table: "webhook_events",
    columns: ["id", "stripe_event_id", "type", "processed_at", "created_at"],
  },
  {
    table: "onboarding_tokens",
    columns: ["id", "client_id", "token", "status", "email", "created_at", "updated_at"],
  },
  {
    table: "admins",
    columns: [
      "id",
      "username",
      "password_hash",
      "role",
      "active",
      "setup_confirmed",
      "last_login_at",
      "created_at",
      "updated_at",
    ],
  },
  {
    table: "settings",
    columns: ["key", "value", "updated_at"],
  },
  {
    table: "client_groups",
    columns: ["id", "workspace", "name", "status", "created_at", "updated_at"],
  },
  {
    table: "api_key_regeneration_tokens",
    columns: ["id", "client_id", "token", "status", "email", "created_at", "updated_at"],
  },
  {
    table: "payment_ledger",
    columns: [
      "id",
      "idempotency_key",
      "connected_account_id",
      "stripe_session_id",
      "stripe_payment_intent_id",
      "client_id",
      "source",
      "status",
      "base_amount_cents",
      "total_amount_cents",
      "fee_amount_cents",
      "refunded_amount_cents",
      "currency",
      "metadata",
      "last_stripe_event_created_at",
      "created_at",
      "updated_at",
    ],
  },
  {
    table: "sales_lead_submissions",
    columns: [
      "form_id",
      "submission_id",
      "status",
      "attempts",
      "next_attempt_at",
      "claimed_at",
      "claim_token",
      "last_error_code",
      "table_row_id",
      "contact_uid",
      "folder_name",
      "folder_file_id",
      "links_backfilled_at",
      "completed_at",
      "created_at",
      "updated_at",
    ],
  },
  {
    table: "sales_lead_sync_state",
    columns: ["form_id", "baseline_submission_id", "baselined_at"],
  },
  {
    table: "client_onboarding_submissions",
    columns: [
      "form_id",
      "submission_id",
      "status",
      "attempts",
      "next_attempt_at",
      "claimed_at",
      "claim_token",
      "last_error_code",
      "folder_name",
      "folder_file_id",
      "contact_status",
      "contact_uid",
      "project_number",
      "project_code",
      "table_row_id",
      "page_id",
      "page_url",
      "page_content_at",
      "team_id",
      "team_members_at",
      "collective_id",
      "collective_content_at",
      "folder_share_id",
      "links_backfilled_at",
      "lead_status",
      "lead_row_id",
      "completed_at",
      "created_at",
      "updated_at",
    ],
  },
  {
    table: "client_onboarding_sync_state",
    columns: ["form_id", "baseline_submission_id", "baselined_at"],
  },
  {
    table: "contact_stripe_sync_books",
    columns: ["addressbook", "sync_token", "synced_at", "updated_at"],
  },
  {
    table: "contact_stripe_sync_cards",
    columns: [
      "contact_uid",
      "client_code",
      "stripe_customer_id",
      "href",
      "etag",
      "last_hash",
      "field_hashes",
      "baseline_at",
      "baseline_reset_at",
      "last_pushed_at",
      "last_error",
      "last_error_hash",
      "created_at",
      "updated_at",
    ],
  },
];

export async function verifyDatabaseSchema(): Promise<void> {
  for (const { table, columns } of REQUIRED_TABLES) {
    const result = await db.execute(
      sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ${table}
      `
    );

    const rows = (result.rows ?? []) as Array<{ column_name: string }>;
    const existingColumns = new Set<string>(rows.map((row) => row.column_name));

    const missing = columns.filter((column) => !existingColumns.has(column));
    if (missing.length > 0) {
      throw new Error(
        `Database schema incomplete for table "${table}". Missing columns: ${missing.join(
          ", "
        )}. Please run the latest migrations and restart the server.`
      );
    }
  }
}
