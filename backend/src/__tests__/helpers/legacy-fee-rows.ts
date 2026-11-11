import { sql } from "drizzle-orm";
import { db } from "../../db/client";
import { clientGroups, clients } from "../../db/schema";

/**
 * Inserts a row whose processing fee columns break the CHECK constraints from migration 0042.
 *
 * Production keeps such "legacy" rows because the constraints were added NOT VALID. A normal
 * insert can no longer create one, so this drops the table's fee constraints, inserts, and puts the
 * same constraints back as NOT VALID, all in one transaction. That leaves the table exactly as
 * production has it: new writes are checked, the legacy row is not.
 *
 * Dropping and re-adding a constraint takes an ACCESS EXCLUSIVE lock on the table for the whole
 * transaction. That is safe only because vitest runs test files serially (`fileParallelism: false`
 * in backend/vitest.config.ts, line 7); parallel files touching these tables would block or deadlock.
 */
async function insertLegacy<T extends typeof clients | typeof clientGroups>(
  table: T,
  tableName: "clients" | "client_groups",
  values: T["$inferInsert"]
) {
  await db.transaction(async (tx) => {
    const defs = await tx.execute<{ conname: string; def: string }>(sql`
      SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = ${tableName}::regclass AND conname LIKE '%processing_fee%'`);
    for (const { conname } of defs.rows) {
      await tx.execute(sql.raw(`ALTER TABLE "${tableName}" DROP CONSTRAINT "${conname}"`));
    }
    await tx.insert(table).values(values as never);
    for (const { conname, def } of defs.rows) {
      await tx.execute(
        sql.raw(`ALTER TABLE "${tableName}" ADD CONSTRAINT "${conname}" ${def} NOT VALID`)
      );
    }
  });
}

export const insertLegacyClient = (values: typeof clients.$inferInsert) =>
  insertLegacy(clients, "clients", values);

export const insertLegacyGroup = (values: typeof clientGroups.$inferInsert) =>
  insertLegacy(clientGroups, "client_groups", values);
