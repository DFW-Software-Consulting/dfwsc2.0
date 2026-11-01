import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the db client before importing the module under test
vi.mock("../../db/client", () => ({
  db: {
    execute: vi.fn(),
  },
}));

// Also mock drizzle-orm sql tag
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    sql: Object.assign(
      (strings: TemplateStringsArray, ..._values: unknown[]) => strings.join("?"),
      { empty: "" }
    ),
  };
});

import { db } from "../../db/client";
import { REQUIRED_TABLES, verifyDatabaseSchema } from "../../lib/schema-check";

const mockDb = db as { execute: ReturnType<typeof vi.fn> };

describe("verifyDatabaseSchema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves without throwing when all tables have all required columns", async () => {
    // Return complete column lists for every table that is queried
    mockDb.execute.mockImplementation(async (query: unknown) => {
      const q = String(query);

      if (q.includes("clients") || q.includes("?")) {
        // We can't easily inspect the interpolated table name, so return a
        // superset of all known columns for every call.
        return {
          rows: [
            { column_name: "id" },
            { column_name: "name" },
            { column_name: "email" },
            { column_name: "api_key_hash" },
            { column_name: "api_key_lookup" },
            { column_name: "stripe_account_id" },
            { column_name: "stripe_customer_id" },
            { column_name: "status" },
            { column_name: "charges_enabled" },
            { column_name: "payouts_enabled" },
            { column_name: "details_submitted" },
            { column_name: "workspace" },
            { column_name: "group_id" },
            { column_name: "invoicing_enabled" },
            { column_name: "created_at" },
            { column_name: "updated_at" },
            // webhook_events columns
            { column_name: "stripe_event_id" },
            { column_name: "type" },
            { column_name: "payload" },
            { column_name: "processed_at" },
            // onboarding_tokens columns
            { column_name: "client_id" },
            { column_name: "token" },
            { column_name: "state" },
            { column_name: "state_expires_at" },
            // admins columns
            { column_name: "username" },
            { column_name: "password_hash" },
            { column_name: "role" },
            { column_name: "active" },
            { column_name: "setup_confirmed" },
            { column_name: "last_login_at" }, // now required by schema-check
            // settings columns
            { column_name: "key" },
            { column_name: "value" },
            // client_groups columns
            { column_name: "name" },
            // api_key_regeneration_tokens columns
            { column_name: "client_id" },
            { column_name: "token" },
            { column_name: "status" },
            // payment_ledger columns
            { column_name: "idempotency_key" },
            { column_name: "connected_account_id" },
            { column_name: "stripe_session_id" },
            { column_name: "stripe_payment_intent_id" },
            { column_name: "source" },
            { column_name: "base_amount_cents" },
            { column_name: "total_amount_cents" },
            { column_name: "fee_amount_cents" },
            { column_name: "refunded_amount_cents" },
            { column_name: "currency" },
            { column_name: "metadata" },
            { column_name: "last_stripe_event_created_at" },
            // sales_lead_submissions columns
            { column_name: "form_id" },
            { column_name: "submission_id" },
            { column_name: "attempts" },
            { column_name: "next_attempt_at" },
            { column_name: "claimed_at" },
            { column_name: "claim_token" },
            { column_name: "last_error_code" },
            { column_name: "table_row_id" },
            { column_name: "contact_uid" },
            { column_name: "folder_name" },
            { column_name: "folder_file_id" },
            { column_name: "links_backfilled_at" },
            { column_name: "completed_at" },
            // sales_lead_sync_state columns
            { column_name: "baseline_submission_id" },
            { column_name: "baselined_at" },
            // contact_stripe_sync_* columns
            { column_name: "addressbook" },
            { column_name: "sync_token" },
            { column_name: "synced_at" },
            { column_name: "contact_uid" },
            { column_name: "client_code" },
            { column_name: "href" },
            { column_name: "etag" },
            { column_name: "last_hash" },
            { column_name: "field_hashes" },
            { column_name: "baseline_at" },
            { column_name: "baseline_reset_at" },
            { column_name: "last_pushed_at" },
            { column_name: "last_error" },
            { column_name: "last_error_hash" },
            // client_onboarding_submissions columns (others are listed above)
            { column_name: "contact_status" },
            { column_name: "project_number" },
            { column_name: "project_code" },
            { column_name: "page_id" },
            { column_name: "page_url" },
            { column_name: "page_content_at" },
            { column_name: "team_id" },
            { column_name: "team_members_at" },
            { column_name: "collective_id" },
            { column_name: "collective_content_at" },
            { column_name: "folder_share_id" },
            { column_name: "lead_status" },
            { column_name: "lead_row_id" },
            // billing_request_submissions columns (others are listed above)
            ...[
              "requested_by",
              "submitted_at",
              "kind",
              "amount_cents",
              "plan_interval",
              "plan_payments",
              "plan_start_date",
              "stripe_started_at",
              "stripe_product_id",
              "stripe_invoice_id",
              "stripe_invoice_item_id",
              "stripe_schedule_id",
              "invoice_finalized_at",
              "invoice_sent_at",
              "outcome",
              "nc_row_id",
              "nc_row_hash",
            ].map((column_name) => ({ column_name })),
            // connect_customers / connect_invoices columns (others are listed above)
            ...[
              "external_ref",
              "idempotency_key",
              "request_hash",
              "creation_state",
              "stripe_fee_item_id",
              "line_item_ids",
              "subtotal_cents",
              "total_cents",
              "amount_paid_cents",
              "amount_remaining_cents",
              "number",
              "due_date",
              "hosted_invoice_url",
              "invoice_pdf",
              "send_count",
              "finalized_at",
              "sent_at",
              "paid_at",
              "voided_at",
              "last_synced_at",
              "updated_at",
            ].map((column_name) => ({ column_name })),
          ],
        };
      }

      return { rows: [] };
    });

    await expect(verifyDatabaseSchema()).resolves.toBeUndefined();
    expect(mockDb.execute).toHaveBeenCalledTimes(18);
  });

  it("requires the connected-account invoicing tables and the clients flag", () => {
    const byTable = new Map(REQUIRED_TABLES.map((t) => [t.table, t.columns]));
    expect(byTable.get("clients")).toContain("invoicing_enabled");
    expect(byTable.get("connect_customers")).toEqual(
      expect.arrayContaining(["client_id", "connected_account_id", "stripe_customer_id"])
    );
    expect(byTable.get("connect_invoices")).toEqual(
      expect.arrayContaining(["client_id", "stripe_invoice_id", "creation_state", "send_count"])
    );
  });

  it("throws when a table is missing required columns", async () => {
    // First two calls succeed (clients, webhook_events), third (onboarding_tokens) is missing columns
    mockDb.execute
      .mockResolvedValueOnce({
        rows: [
          { column_name: "id" },
          { column_name: "name" },
          { column_name: "email" },
          { column_name: "api_key_hash" },
          { column_name: "api_key_lookup" },
          { column_name: "stripe_account_id" },
          { column_name: "stripe_customer_id" },
          { column_name: "status" },
          { column_name: "charges_enabled" },
          { column_name: "payouts_enabled" },
          { column_name: "details_submitted" },
          { column_name: "workspace" },
          { column_name: "group_id" },
          { column_name: "invoicing_enabled" },
          { column_name: "created_at" },
          { column_name: "updated_at" },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { column_name: "id" },
          { column_name: "stripe_event_id" },
          { column_name: "type" },
          { column_name: "payload" },
          { column_name: "processed_at" },
          { column_name: "created_at" },
        ],
      })
      .mockResolvedValueOnce({
        // onboarding_tokens: missing 'token' and 'status'
        rows: [
          { column_name: "id" },
          { column_name: "client_id" },
          { column_name: "email" },
          { column_name: "created_at" },
          { column_name: "updated_at" },
        ],
      });

    await expect(verifyDatabaseSchema()).rejects.toThrow(
      /Database schema incomplete for table "onboarding_tokens"/
    );
    await expect(
      // Re-invoke after resetting the mock to get a predictable error message
      (async () => {
        mockDb.execute
          .mockResolvedValueOnce({
            rows: [
              { column_name: "id" },
              { column_name: "name" },
              { column_name: "email" },
              { column_name: "api_key_hash" },
              { column_name: "api_key_lookup" },
              { column_name: "stripe_account_id" },
              { column_name: "stripe_customer_id" },
              { column_name: "status" },
              { column_name: "charges_enabled" },
              { column_name: "payouts_enabled" },
              { column_name: "details_submitted" },
              { column_name: "workspace" },
              { column_name: "group_id" },
              { column_name: "invoicing_enabled" },
              { column_name: "created_at" },
              { column_name: "updated_at" },
            ],
          })
          .mockResolvedValueOnce({
            rows: [
              { column_name: "id" },
              { column_name: "stripe_event_id" },
              { column_name: "type" },
              { column_name: "payload" },
              { column_name: "processed_at" },
              { column_name: "created_at" },
            ],
          })
          .mockResolvedValueOnce({
            rows: [
              { column_name: "id" },
              { column_name: "client_id" },
              { column_name: "email" },
              { column_name: "created_at" },
              { column_name: "updated_at" },
            ],
          });
        await verifyDatabaseSchema();
      })()
    ).rejects.toThrow(/Missing columns: token, status/);
  });

  it("throws with the correct table name when clients table is incomplete", async () => {
    mockDb.execute.mockResolvedValueOnce({
      // clients: missing 'api_key_lookup' and 'stripe_account_id'
      rows: [
        { column_name: "id" },
        { column_name: "name" },
        { column_name: "email" },
        { column_name: "api_key_hash" },
        { column_name: "status" },
        { column_name: "created_at" },
        { column_name: "updated_at" },
      ],
    });

    await expect(verifyDatabaseSchema()).rejects.toThrow(
      /Database schema incomplete for table "clients"/
    );
  });

  it("throws when api_key_regeneration_tokens table is missing required columns", async () => {
    // clients, webhook_events, onboarding_tokens, admins, settings, client_groups all complete;
    // api_key_regeneration_tokens (added by migration 0022) is missing 'token' and 'status'.
    mockDb.execute
      .mockResolvedValueOnce({
        rows: [
          { column_name: "id" },
          { column_name: "name" },
          { column_name: "email" },
          { column_name: "api_key_hash" },
          { column_name: "api_key_lookup" },
          { column_name: "stripe_account_id" },
          { column_name: "stripe_customer_id" },
          { column_name: "status" },
          { column_name: "charges_enabled" },
          { column_name: "payouts_enabled" },
          { column_name: "details_submitted" },
          { column_name: "workspace" },
          { column_name: "group_id" },
          { column_name: "invoicing_enabled" },
          { column_name: "created_at" },
          { column_name: "updated_at" },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { column_name: "id" },
          { column_name: "stripe_event_id" },
          { column_name: "type" },
          { column_name: "processed_at" },
          { column_name: "created_at" },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { column_name: "id" },
          { column_name: "client_id" },
          { column_name: "token" },
          { column_name: "status" },
          { column_name: "email" },
          { column_name: "created_at" },
          { column_name: "updated_at" },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { column_name: "id" },
          { column_name: "username" },
          { column_name: "password_hash" },
          { column_name: "role" },
          { column_name: "active" },
          { column_name: "setup_confirmed" },
          { column_name: "last_login_at" },
          { column_name: "created_at" },
          { column_name: "updated_at" },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ column_name: "key" }, { column_name: "value" }, { column_name: "updated_at" }],
      })
      .mockResolvedValueOnce({
        rows: [
          { column_name: "id" },
          { column_name: "workspace" },
          { column_name: "name" },
          { column_name: "status" },
          { column_name: "created_at" },
          { column_name: "updated_at" },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { column_name: "id" },
          { column_name: "client_id" },
          { column_name: "email" },
          { column_name: "created_at" },
          { column_name: "updated_at" },
        ],
      });

    await expect(verifyDatabaseSchema()).rejects.toThrow(
      /Database schema incomplete for table "api_key_regeneration_tokens"/
    );
    await expect(
      (async () => {
        mockDb.execute
          .mockResolvedValueOnce({
            rows: [
              { column_name: "id" },
              { column_name: "name" },
              { column_name: "email" },
              { column_name: "api_key_hash" },
              { column_name: "api_key_lookup" },
              { column_name: "stripe_account_id" },
              { column_name: "stripe_customer_id" },
              { column_name: "status" },
              { column_name: "charges_enabled" },
              { column_name: "payouts_enabled" },
              { column_name: "details_submitted" },
              { column_name: "workspace" },
              { column_name: "group_id" },
              { column_name: "invoicing_enabled" },
              { column_name: "created_at" },
              { column_name: "updated_at" },
            ],
          })
          .mockResolvedValueOnce({
            rows: [
              { column_name: "id" },
              { column_name: "stripe_event_id" },
              { column_name: "type" },
              { column_name: "processed_at" },
              { column_name: "created_at" },
            ],
          })
          .mockResolvedValueOnce({
            rows: [
              { column_name: "id" },
              { column_name: "client_id" },
              { column_name: "token" },
              { column_name: "status" },
              { column_name: "email" },
              { column_name: "created_at" },
              { column_name: "updated_at" },
            ],
          })
          .mockResolvedValueOnce({
            rows: [
              { column_name: "id" },
              { column_name: "username" },
              { column_name: "password_hash" },
              { column_name: "role" },
              { column_name: "active" },
              { column_name: "setup_confirmed" },
              { column_name: "last_login_at" },
              { column_name: "created_at" },
              { column_name: "updated_at" },
            ],
          })
          .mockResolvedValueOnce({
            rows: [{ column_name: "key" }, { column_name: "value" }, { column_name: "updated_at" }],
          })
          .mockResolvedValueOnce({
            rows: [
              { column_name: "id" },
              { column_name: "workspace" },
              { column_name: "name" },
              { column_name: "status" },
              { column_name: "created_at" },
              { column_name: "updated_at" },
            ],
          })
          .mockResolvedValueOnce({
            rows: [
              { column_name: "id" },
              { column_name: "client_id" },
              { column_name: "email" },
              { column_name: "created_at" },
              { column_name: "updated_at" },
            ],
          });
        await verifyDatabaseSchema();
      })()
    ).rejects.toThrow(/Missing columns: token, status/);
  });

  it("checks every table's own columns, in order, and names the table and column that is missing", async () => {
    for (let target = 0; target < REQUIRED_TABLES.length; target++) {
      const { table, columns } = REQUIRED_TABLES[target];
      const dropped = columns[columns.length - 1];
      let call = 0;
      mockDb.execute.mockReset();
      mockDb.execute.mockImplementation(async () => {
        const wanted = REQUIRED_TABLES[call++];
        const cols = wanted.table === table ? wanted.columns.slice(0, -1) : wanted.columns;
        return { rows: cols.map((column_name) => ({ column_name })) };
      });
      await expect(verifyDatabaseSchema()).rejects.toThrow(
        new RegExp(`table "${table}"\\. Missing columns: ${dropped}`)
      );
    }
    expect(REQUIRED_TABLES.map((t) => t.table)).toEqual(
      expect.arrayContaining(["contact_stripe_sync_books", "contact_stripe_sync_cards"])
    );
  });
});
