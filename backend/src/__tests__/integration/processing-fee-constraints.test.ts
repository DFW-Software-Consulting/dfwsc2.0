import { vi } from "vitest";

vi.mock("../../lib/stripe", () => ({
  stripe: {
    accounts: { create: vi.fn() },
    accountLinks: { create: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
    paymentIntents: { create: vi.fn(), list: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
  },
}));

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { clientGroups, clients } from "../../db/schema";
import { makeAdminToken } from "../helpers/auth";
import { ensureBaseEnv } from "../helpers/env";
import { insertLegacyClient, insertLegacyGroup } from "../helpers/legacy-fee-rows";

// The processing fee CHECK constraints (migration 0042) mirror addFeeIssues in lib/admin-crud.ts.
// These tests write straight to Postgres, so they prove the database itself enforces them.

const CHECK_VIOLATION = "23514";

type Fee = { processingFeePercent?: string | null; processingFeeCents?: number | null };

const groupIds: string[] = [];
const clientIds: string[] = [];

async function insertGroup(fee: Fee) {
  const id = randomUUID();
  groupIds.push(id);
  await db.insert(clientGroups).values({ id, name: `fee-check-${id}`, ...fee });
  return id;
}

async function insertClient(fee: Fee) {
  const id = randomUUID();
  clientIds.push(id);
  await db
    .insert(clients)
    .values({ id, name: `fee-check-${id}`, email: `${id}@example.com`, ...fee });
  return id;
}

/** Resolves to the Postgres error code and constraint name of a failed write (drizzle wraps it in `cause`). */
async function violation(write: Promise<unknown>) {
  try {
    await write;
  } catch (err) {
    const pg = (err as { cause?: { code?: string; constraint?: string } }).cause ?? (err as object);
    return pg as { code?: string; constraint?: string };
  }
  return null;
}

describe("processing fee CHECK constraints", () => {
  beforeAll(() => ensureBaseEnv());

  afterAll(async () => {
    if (clientIds.length) await db.delete(clients).where(inArray(clients.id, clientIds));
    if (groupIds.length) await db.delete(clientGroups).where(inArray(clientGroups.id, groupIds));
  });

  it("registers all six constraints", async () => {
    const result = await db.execute(sql`
      SELECT conname FROM pg_constraint
      WHERE conname LIKE '%processing_fee%'
      ORDER BY conname`);
    expect(result.rows.map((r) => r.conname)).toEqual([
      "client_groups_processing_fee_cents_check",
      "client_groups_processing_fee_exclusive_check",
      "client_groups_processing_fee_percent_check",
      "clients_processing_fee_cents_check",
      "clients_processing_fee_exclusive_check",
      "clients_processing_fee_percent_check",
    ]);
  });

  describe.each([
    { table: "clients", insert: insertClient, column: clients, label: "clients" },
    { table: "client_groups", insert: insertGroup, column: clientGroups, label: "client_groups" },
  ])("$label", ({ table, insert, column }) => {
    it.each([
      ["NULL fees", {}],
      ["percent 0", { processingFeePercent: "0" }],
      ["percent 0.01", { processingFeePercent: "0.01" }],
      ["percent 2.9", { processingFeePercent: "2.9" }],
      ["percent 100", { processingFeePercent: "100" }],
      ["cents 0", { processingFeeCents: 0 }],
      ["cents 250", { processingFeeCents: 250 }],
    ] as [string, Fee][])("accepts %s", async (_name, fee) => {
      expect(await violation(insert(fee))).toBeNull();
    });

    it.each([
      ["percent -0.01", { processingFeePercent: "-0.01" }, `${table}_processing_fee_percent_check`],
      [
        "percent 100.01",
        { processingFeePercent: "100.01" },
        `${table}_processing_fee_percent_check`,
      ],
      ["percent 150", { processingFeePercent: "150" }, `${table}_processing_fee_percent_check`],
      ["cents -1", { processingFeeCents: -1 }, `${table}_processing_fee_cents_check`],
      [
        "both fee types set",
        { processingFeePercent: "2.9", processingFeeCents: 30 },
        `${table}_processing_fee_exclusive_check`,
      ],
    ] as [string, Fee, string][])("rejects %s on insert", async (_name, fee, constraint) => {
      expect(await violation(insert(fee))).toMatchObject({ code: CHECK_VIOLATION, constraint });
    });

    it("rejects an out-of-range update and leaves the row unchanged", async () => {
      const id = await insert({ processingFeePercent: "3" });
      const bad = await violation(
        db.update(column).set({ processingFeePercent: "101" }).where(eq(column.id, id))
      );
      expect(bad).toMatchObject({ code: CHECK_VIOLATION });

      const [row] = await db.select().from(column).where(eq(column.id, id));
      expect(Number(row.processingFeePercent)).toBe(3);
    });

    it("rejects an update that sets the second fee type without clearing the first", async () => {
      const id = await insert({ processingFeeCents: 100 });
      const bad = await violation(
        db.update(column).set({ processingFeePercent: "3" }).where(eq(column.id, id))
      );
      expect(bad).toMatchObject({ code: CHECK_VIOLATION });
    });

    it("accepts an in-range update", async () => {
      const id = await insert({});
      await db.update(column).set({ processingFeeCents: 75 }).where(eq(column.id, id));
      const [row] = await db.select().from(column).where(eq(column.id, id));
      expect(row.processingFeeCents).toBe(75);
    });
  });

  describe("legacy rows (the constraints are NOT VALID)", () => {
    it("keeps a violating row that existed before the constraints", async () => {
      const id = randomUUID();
      clientIds.push(id);
      await insertLegacyClient({
        id,
        name: "legacy",
        email: `${id}@example.com`,
        processingFeePercent: "150",
        processingFeeCents: -5,
      });
      const [row] = await db.select().from(clients).where(eq(clients.id, id));
      expect(Number(row.processingFeePercent)).toBe(150);
      expect(row.processingFeeCents).toBe(-5);
    });

    it("still rejects any update of a legacy row until its fees are fixed", async () => {
      const id = randomUUID();
      groupIds.push(id);
      await insertLegacyGroup({ id, name: "legacy", processingFeeCents: -5 });

      const unrelated = await violation(
        db.update(clientGroups).set({ name: "renamed" }).where(eq(clientGroups.id, id))
      );
      expect(unrelated).toMatchObject({ code: CHECK_VIOLATION });

      const fixed = await violation(
        db
          .update(clientGroups)
          .set({ name: "renamed", processingFeeCents: 0 })
          .where(eq(clientGroups.id, id))
      );
      expect(fixed).toBeNull();
    });

    it("leaves the constraints NOT VALID, so new writes are still checked", async () => {
      const id = randomUUID();
      clientIds.push(id);
      await insertLegacyClient({
        id,
        name: "legacy",
        email: `${id}@example.com`,
        processingFeeCents: -1,
      });
      expect(await violation(insertClient({ processingFeeCents: -1 }))).toMatchObject({
        code: CHECK_VIOLATION,
      });
    });
  });

  describe("everything the admin API accepts is storable", () => {
    let app: Awaited<ReturnType<typeof buildServer>>;

    beforeAll(async () => {
      app = await buildServer();
    });
    afterAll(async () => {
      await app.close();
    });

    const patch = (id: string, payload: object) =>
      app.inject({
        method: "PATCH",
        url: `/api/v1/groups/${id}`,
        headers: {
          authorization: `Bearer ${makeAdminToken()}`,
          "content-type": "application/json",
        },
        payload,
      });

    it("stores a tiny positive percent (rounded to 0.00 by numeric(5,2)) instead of failing", async () => {
      const id = await insertGroup({});
      const res = await patch(id, { processingFeePercent: 0.001 });
      expect(res.statusCode).toBe(200);
      const [row] = await db.select().from(clientGroups).where(eq(clientGroups.id, id));
      expect(Number(row.processingFeePercent)).toBe(0);
    });

    it("stores the maximum percent 100 and rejects 100.01 before it reaches the database", async () => {
      const id = await insertGroup({});
      expect((await patch(id, { processingFeePercent: 100 })).statusCode).toBe(200);
      expect((await patch(id, { processingFeePercent: 100.01 })).statusCode).toBe(400);
    });

    it("switches fee type by clearing the other column, so the exclusive check holds", async () => {
      const id = await insertGroup({ processingFeeCents: 100 });
      expect((await patch(id, { processingFeePercent: 5 })).statusCode).toBe(200);
      const [row] = await db.select().from(clientGroups).where(eq(clientGroups.id, id));
      expect(row.processingFeeCents).toBeNull();
      expect(Number(row.processingFeePercent)).toBe(5);
    });
  });
});
