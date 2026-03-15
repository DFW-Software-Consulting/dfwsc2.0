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
import { verifyDatabaseSchema } from "../../lib/schema-check";

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
          ],
        };
      }

      return { rows: [] };
    });

    await expect(verifyDatabaseSchema()).resolves.toBeUndefined();
    expect(mockDb.execute).toHaveBeenCalledTimes(3);
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
});
