import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsFolder = path.join(__dirname, "..", "..", "..", "drizzle");
const TARGET_TAG = "0025_payment_ledger_per_client_idempotency";

/**
 * Applies migrations up to 0024 on a throwaway database, fills payment_ledger with
 * representative rows, then applies 0025 on top, so the upgrade path is proven on
 * populated data rather than on an empty schema. The scratch database is created and
 * dropped here and never touches the database the other suites use.
 */
describe("migration 0025 upgrade path on a populated 0024 database", () => {
  const scratchDb = `ledger_0025_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let tmpRoot: string;

  function scratchUrl(): string {
    const url = new URL(process.env.DATABASE_URL as string);
    url.pathname = `/${scratchDb}`;
    return url.toString();
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    await adminPool.query(`CREATE DATABASE "${scratchDb}"`);
    pool = new Pool({ connectionString: scratchUrl(), max: 2 });

    // Folder with the journal cut off before 0025, so the migrator stops at 0024.
    tmpRoot = mkdtempSync(path.join(tmpdir(), "ledger-0025-"));
    const before = path.join(tmpRoot, "before");
    mkdirSync(path.join(before, "meta"), { recursive: true });
    const journal = JSON.parse(
      readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")
    );
    const kept = journal.entries.filter((e: { tag: string }) => e.tag !== TARGET_TAG);
    expect(kept.length).toBe(journal.entries.length - 1);
    writeFileSync(
      path.join(before, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: kept })
    );
    for (const e of kept)
      cpSync(path.join(migrationsFolder, `${e.tag}.sql`), path.join(before, `${e.tag}.sql`));
  });

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS "${scratchDb}" WITH (FORCE)`);
      await adminPool.end();
    }
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("keeps every row and enforces the new per-client and per-session uniqueness", async () => {
    const scratch = drizzle(pool);
    await migrate(scratch, { migrationsFolder: path.join(tmpRoot, "before") });

    // State before 0025: the old global constraint is present, the new indexes are not.
    const before = await pool.query(
      `SELECT conname FROM pg_constraint WHERE conname = 'payment_ledger_idempotency_key_unique'`
    );
    expect(before.rowCount).toBe(1);

    const clientIds = ["client-a", "client-b", "client-c"];
    for (const id of clientIds) {
      await pool.query(
        `INSERT INTO clients (id, name, email, api_key_hash, api_key_lookup, status)
         VALUES ($1, $1, $1 || '@example.com', 'hash-' || $1, $1, 'active')`,
        [id]
      );
    }

    // Several clients, several keys, rows with and without a Stripe session id.
    const rows: Array<[string, string, string, string | null]> = [];
    for (const [ci, clientId] of clientIds.entries()) {
      for (let k = 0; k < 4; k++) {
        const sessionId = k === 3 ? null : `cs_test_${clientId}_${k}`;
        rows.push([`row-${clientId}-${k}`, `key-${ci}-${k}`, clientId, sessionId]);
      }
    }
    for (const [id, key, clientId, sessionId] of rows) {
      await pool.query(
        `INSERT INTO payment_ledger
           (id, idempotency_key, connected_account_id, stripe_session_id, client_id, source,
            status, base_amount_cents, total_amount_cents, fee_amount_cents, currency)
         VALUES ($1, $2, 'acct_test', $3, $4, 'checkout', 'created', 5000, 5000, 0, 'usd')`,
        [id, key, sessionId, clientId]
      );
    }
    const snapshot = async () =>
      (
        await pool.query(
          `SELECT id, idempotency_key, stripe_session_id, client_id, status, total_amount_cents
           FROM payment_ledger ORDER BY id`
        )
      ).rows;
    const dataBefore = await snapshot();
    expect(dataBefore).toHaveLength(12);

    // Apply 0025 on top of the populated database.
    await migrate(scratch, { migrationsFolder });

    expect(await snapshot()).toEqual(dataBefore);

    const gone = await pool.query(
      `SELECT conname FROM pg_constraint WHERE conname = 'payment_ledger_idempotency_key_unique'`
    );
    expect(gone.rowCount).toBe(0);
    const indexes = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'payment_ledger' ORDER BY indexname`
    );
    const names = indexes.rows.map((r) => r.indexname);
    expect(names).toContain("payment_ledger_session_id_uniq");
    expect(names).toContain("payment_ledger_client_idempotency_key_uniq");
    expect(names).not.toContain("payment_ledger_session_id_idx");

    const insert = (id: string, key: string, clientId: string, sessionId: string | null) =>
      pool.query(
        `INSERT INTO payment_ledger
           (id, idempotency_key, connected_account_id, stripe_session_id, client_id, source,
            status, base_amount_cents, total_amount_cents, fee_amount_cents, currency)
         VALUES ($1, $2, 'acct_test', $3, $4, 'checkout', 'created', 100, 100, 0, 'usd')`,
        [id, key, sessionId, clientId]
      );

    // The same key can now be used by a different client...
    await insert("new-1", "key-0-0", "client-b", "cs_test_new_1");
    // ...but not twice by the same client.
    await expect(insert("new-2", "key-0-0", "client-a", "cs_test_new_2")).rejects.toMatchObject({
      code: "23505",
      constraint: "payment_ledger_client_idempotency_key_uniq",
    });
    // A Stripe session id belongs to exactly one row.
    await expect(
      insert("new-3", "fresh-key", "client-c", "cs_test_client-a_0")
    ).rejects.toMatchObject({ code: "23505", constraint: "payment_ledger_session_id_uniq" });
    // Rows without a session id are not constrained against each other.
    await insert("new-4", "null-1", "client-a", null);
    await insert("new-5", "null-2", "client-a", null);
  });
});
