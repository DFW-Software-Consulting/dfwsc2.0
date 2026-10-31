import fs from "node:fs";
import path from "node:path";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../app";
import { db, pool } from "../../db/client";
import { clientGroups, clients, paymentLedger, portalMirrorRows } from "../../db/schema";
import { createClientWithOnboardingToken } from "../../lib/client-factory";
import {
  getNextcloudBreakerState,
  openPortalMirrorBreakerForTests,
  resetNextcloudBreakerForTests,
} from "../../lib/nextcloud";
import { PortalMirrorNextcloud } from "../../lib/portal-mirror-nextcloud";
import { formatDateTime } from "../../lib/portal-mirror-render";
import {
  loadPortalMirrorConfig,
  resetPortalMirrorStateForTests,
  runPortalMirrorCycle,
  startPortalMirror,
} from "../../lib/portal-mirror-sync";
import { makeAdminToken } from "../helpers/auth";
import { ensureBaseEnv } from "../helpers/env";
import {
  FakeTablesNextcloud,
  MIRROR_NC_URL,
  MIRROR_NC_USER,
  mirrorEnv,
} from "../helpers/fake-nextcloud-tables";

type Logger = Parameters<typeof runPortalMirrorCycle>[0]["logger"];

let fake: FakeTablesNextcloud;
let lines: { level: string; text: string }[];
let app: Awaited<ReturnType<typeof buildServer>>;

const logger = (): Logger => {
  const rec =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push({ level, text: JSON.stringify(args) });
    };
  return { info: rec("info"), warn: rec("warn"), error: rec("error") } as unknown as Logger;
};
const on = mirrorEnv();
const cycle = (env: NodeJS.ProcessEnv = on) =>
  runPortalMirrorCycle({ logger: logger(), env, minGapMs: 0 });

const tableId = () => fake.tables[0].id;
const accountRows = () => fake.rowsOf(tableId());
const rowOf = (id: string) => accountRows().find((r) => fake.cell(r, "Client ID") === id);
const mustRow = (id: string) => {
  const row = rowOf(id);
  if (!row) throw new Error(`no mirror row for ${id}`);
  return row;
};
const cellOf = (id: string, title: string) => {
  const row = rowOf(id);
  if (!row) throw new Error(`no mirror row for ${id}`);
  return fake.cell(row, title);
};
const rowWrites = () =>
  fake.calls.filter((c) => /\/rows/.test(c.path) && ["POST", "PUT", "DELETE"].includes(c.method));

let seq = 0;
async function addClient(values: Partial<typeof clients.$inferInsert> = {}) {
  const id = values.id ?? `pm-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(clients).values({
    id,
    name: `Client ${id}`,
    email: `${id}@example.com`,
    workspace: "client_portal",
    status: "active",
    ...values,
  });
  return id;
}

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
async function addPayment(
  clientId: string,
  values: Partial<typeof paymentLedger.$inferInsert> = {}
) {
  const id = values.id ?? `pay-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(paymentLedger).values({
    id,
    idempotencyKey: id,
    connectedAccountId: "acct_x",
    clientId,
    source: "checkout",
    status: "paid",
    baseAmountCents: 1000,
    totalAmountCents: 1100,
    feeAmountCents: 100,
    currency: "usd",
    ...values,
  });
  return id;
}

/** Pretend everything was synced an hour ago and nothing has changed since (outside the overlap). */
async function settle() {
  await db.execute(sql`UPDATE clients SET updated_at = now() - interval '2 hours'`);
  await db.execute(sql`UPDATE client_groups SET updated_at = now() - interval '2 hours'`);
  await db.execute(sql`UPDATE payment_ledger SET updated_at = now() - interval '2 hours'`);
  await db.execute(sql`UPDATE portal_mirror_rows SET synced_at = now() - interval '1 hour'`);
}

beforeAll(async () => {
  ensureBaseEnv();
  app = await buildServer();
});
afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await db.delete(portalMirrorRows);
  await db.delete(clients);
  await db.delete(clientGroups);
  resetNextcloudBreakerForTests();
  resetPortalMirrorStateForTests();
  lines = [];
  fake = new FakeTablesNextcloud();
  vi.stubGlobal("fetch", vi.fn(fake.fetch));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await db.delete(portalMirrorRows);
  await db.delete(clients);
  await db.delete(clientGroups);
});

describe("config and flag", () => {
  it("is off by default and makes no Nextcloud call", async () => {
    await addClient();
    expect((await cycle({})).status).toBe("disabled");
    expect((await cycle(mirrorEnv({ PORTAL_MIRROR: "false" }))).status).toBe("disabled");
    expect(fake.calls).toHaveLength(0);
    expect(startPortalMirror(logger(), {})).toBeNull();
  });

  it("reports an invalid config without throwing, and does not start", async () => {
    const env = { PORTAL_MIRROR: "true", PORTAL_MIRROR_BATCH: "500" };
    const config = loadPortalMirrorConfig(env);
    expect(config.status).toBe("invalid");
    expect((await cycle(env)).status).toBe("invalid_config");
    expect(startPortalMirror(logger(), env)).toBeNull();
    expect(lines.some((l) => l.level === "error")).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("provisioning", () => {
  it("creates the table, every column and read-only shares, once", async () => {
    await addClient();
    expect((await cycle()).status).toBe("ok");
    expect(fake.tables.map((t) => t.title)).toEqual(["Portal Accounts"]);
    const titles = fake.columns.get(tableId())?.map((c) => c.title);
    expect(titles).toEqual([
      "Client ID",
      "Name",
      "Group",
      "Status",
      "Stripe Account",
      "Onboarding",
      "Charges Enabled",
      "Payouts Enabled",
      "Details Submitted",
      "Fee %",
      "Fee $",
      "Last Payment",
      "Payments (30d)",
      "DFWSC Fees (30d)",
      "Created",
      "Updated",
    ]);
    expect(fake.shares.map((s) => s.receiver).sort()).toEqual(["dfwsc-admins", "managers"]);
    for (const s of fake.shares) {
      expect(s).toMatchObject({
        nodeId: tableId(),
        nodeType: "table",
        receiverType: "group",
        permissionRead: true,
        permissionCreate: false,
        permissionUpdate: false,
        permissionDelete: false,
        permissionManage: false,
      });
    }
    // Payments are not mirrored: no second table, nothing payment shaped.
    expect(fake.tables).toHaveLength(1);

    // A new process (fresh state) finds the same table and adds nothing.
    resetPortalMirrorStateForTests();
    const before = fake.calls.length;
    await cycle();
    expect(fake.tables).toHaveLength(1);
    expect(fake.shares).toHaveLength(2);
    expect(fake.callsTo("POST", /\/columns$/).length).toBe(16);
    expect(fake.calls.length).toBeGreaterThan(before);
  });

  it("adds a missing column to an existing table and honors PORTAL_MIRROR_SHARE_GROUPS", async () => {
    const id = 7;
    fake.tables.push({ id, title: "Portal Accounts", ownership: MIRROR_NC_USER });
    fake.columns.set(id, [{ id: 71, title: "Client ID", type: "text" }]);
    await cycle(mirrorEnv({ PORTAL_MIRROR_SHARE_GROUPS: "ops" }));
    expect(fake.tables).toHaveLength(1);
    expect(fake.columns.get(id)).toHaveLength(16);
    expect(fake.shares.map((s) => s.receiver)).toEqual(["ops"]);
  });

  it("ignores a same-titled table owned by someone else", async () => {
    fake.tables.push({ id: 8, title: "Portal Accounts", ownership: "someone-else" });
    fake.columns.set(8, []);
    await cycle();
    expect(fake.tables).toHaveLength(2);
  });

  it("uses a hand-made table by id, does not share it, and needs its columns", async () => {
    fake.tables.push({ id: 9, title: "Hand made", ownership: MIRROR_NC_USER });
    fake.columns.set(9, [{ id: 91, title: "Client ID", type: "text" }]);
    const env = mirrorEnv({ PORTAL_ACCOUNTS_TABLE_ID: "9" });
    expect((await cycle(env)).status).toBe("invalid_config");
    expect(fake.callsTo("POST", /columns|shares/)).toHaveLength(0);
    expect(lines.some((l) => l.text.includes("lacks columns"))).toBe(true);
  });
});

describe("rows", () => {
  it("mirrors clients with labels, yes/no, group and fee, and leaves out PII", async () => {
    await db.insert(clientGroups).values({ id: "g1", name: "Building A", processingFeeCents: 250 });
    const id = await addClient({
      name: "Acme Co",
      groupId: "g1",
      stripeAccountId: "acct_1",
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      phone: "555-0100",
      notes: "private",
      addressLine1: "1 Main St",
    });
    await cycle();
    expect(cellOf(id, "Name")).toBe("Acme Co");
    expect(cellOf(id, "Group")).toBe("Building A");
    expect(cellOf(id, "Status")).toBe("Active");
    expect(cellOf(id, "Onboarding")).toBe("Ready");
    expect(cellOf(id, "Charges Enabled")).toBe("Yes");
    expect(cellOf(id, "Fee $")).toBe(2.5);
    expect(cellOf(id, "Fee %")).toBeNull();
    const dump = JSON.stringify(accountRows().map((r) => [...r.data.entries()]));
    for (const secret of [`${id}@example.com`, "555-0100", "private", "1 Main St"]) {
      expect(dump).not.toContain(secret);
    }
    expect(dump).not.toContain("acct_x");
  });

  it("hides archived clients by default (and shows them with the toggle)", async () => {
    const live = await addClient();
    const archived = await addClient({ status: "archived" });
    await cycle();
    expect(rowOf(live)).toBeDefined();
    expect(rowOf(archived)).toBeUndefined();
    await cycle(mirrorEnv({ PORTAL_MIRROR_INCLUDE_ARCHIVED: "true" }));
    resetPortalMirrorStateForTests();
    fake.rows = [];
    await db.delete(portalMirrorRows);
    await cycle(mirrorEnv({ PORTAL_MIRROR_INCLUDE_ARCHIVED: "true" }));
    expect(rowOf(archived)).toBeDefined();
  });

  it("includes the email column only when asked", async () => {
    const id = await addClient();
    await cycle(mirrorEnv({ PORTAL_MIRROR_INCLUDE_EMAIL: "true" }));
    expect(cellOf(id, "Email")).toBe(`${id}@example.com`);
  });

  it("backfills in batches and skips unchanged rows afterwards", async () => {
    for (let i = 0; i < 60; i++) await addClient();
    const env = mirrorEnv({ PORTAL_MIRROR_BATCH: "25" });
    expect((await cycle(env)).created).toBe(25);
    expect((await cycle(env)).created).toBe(25);
    expect((await cycle(env)).created).toBe(10);
    expect(accountRows()).toHaveLength(60);
    await settle();
    fake.calls = [];
    const idle = await cycle(env);
    expect(idle).toMatchObject({ created: 0, updated: 0, deleted: 0 });
    expect(rowWrites()).toHaveLength(0);
  });

  it("removes the Nextcloud row when a client is deleted or archived", async () => {
    const gone = await addClient();
    const kept = await addClient();
    await cycle();
    await db.delete(clients).where(eq(clients.id, gone));
    await cycle();
    expect(rowOf(gone)).toBeUndefined();
    expect(rowOf(kept)).toBeDefined();
    expect(await db.select().from(portalMirrorRows)).toHaveLength(1);
  });

  it("puts back a row that was deleted in Nextcloud when the client changes", async () => {
    const id = await addClient();
    await cycle();
    fake.rows = [];
    await db.update(clients).set({ name: "Renamed" }).where(eq(clients.id, id));
    await cycle();
    expect(cellOf(id, "Name")).toBe("Renamed");
    const [map] = await db.select().from(portalMirrorRows);
    expect(map.ncRowId).toBe(rowOf(id)?.id);
  });
});

describe("payment aggregates", () => {
  it("counts paid and partially refunded payments in the last 30 days, USD fees only", async () => {
    const id = await addClient();
    await addPayment(id, { createdAt: daysAgo(5), feeAmountCents: 100 });
    await addPayment(id, {
      createdAt: daysAgo(10),
      status: "refunded",
      refundedAmountCents: 50,
      feeAmountCents: 200,
    });
    await addPayment(id, { createdAt: daysAgo(29.9), feeAmountCents: 50 });
    await addPayment(id, { createdAt: daysAgo(30.1), feeAmountCents: 800 });
    const euro = await addPayment(id, {
      createdAt: daysAgo(2),
      currency: "EUR",
      feeAmountCents: 999,
    });
    // Never counted: full refund, dispute, created, expired, failed, canceled.
    await addPayment(id, {
      createdAt: daysAgo(1),
      status: "refunded",
      refundedAmountCents: 1100,
      feeAmountCents: 7,
    });
    for (const status of ["disputed", "created", "expired", "failed", "canceled"] as const) {
      await addPayment(id, { createdAt: daysAgo(1), status, feeAmountCents: 7 });
    }
    await cycle();
    expect(cellOf(id, "Payments (30d)")).toBe(4);
    expect(cellOf(id, "DFWSC Fees (30d)")).toBe(3.5);
    const [eur] = await db.select().from(paymentLedger).where(eq(paymentLedger.id, euro));
    expect(cellOf(id, "Last Payment")).toBe(formatDateTime(eur.createdAt));
    expect(lines.filter((l) => l.text.includes("non-USD"))).toHaveLength(1);
    expect(JSON.stringify([...(rowOf(id)?.data ?? [])])).not.toContain("pay-");
  });

  it("is zero and blank without payments, and outside the window", async () => {
    const none = await addClient();
    const old = await addClient();
    await addPayment(old, { createdAt: daysAgo(40) });
    await cycle();
    expect(cellOf(none, "Last Payment")).toBeNull();
    expect(cellOf(none, "Payments (30d)")).toBe(0);
    expect(cellOf(none, "DFWSC Fees (30d)")).toBe(0);
    expect(cellOf(old, "Payments (30d)")).toBe(0);
    expect(cellOf(old, "Last Payment")).not.toBeNull();
  });

  it("drops a payment that aged out of the window at the daily reconcile", async () => {
    const id = await addClient();
    await addPayment(id, { createdAt: daysAgo(29), feeAmountCents: 300 });
    await cycle();
    expect(cellOf(id, "Payments (30d)")).toBe(1);
    expect(cellOf(id, "DFWSC Fees (30d)")).toBe(3);

    // Time passes with no write at all.
    await db.execute(sql`UPDATE payment_ledger SET created_at = now() - interval '31 days'`);
    await settle();
    await cycle();
    expect(cellOf(id, "Payments (30d)")).toBe(1);

    // The next daily reconcile recomputes every account.
    resetPortalMirrorStateForTests();
    const result = await cycle();
    expect(result.reconciled).toBe(true);
    expect(cellOf(id, "Payments (30d)")).toBe(0);
    expect(cellOf(id, "DFWSC Fees (30d)")).toBe(0);
  });
});

describe("every write path marks the account dirty", () => {
  const post = (url: string, method: "PATCH" | "DELETE", payload?: object) =>
    app.inject({
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${makeAdminToken()}` },
    });

  type Ctx = { id: string; groupId: string };
  const paths: {
    name: string;
    run: (c: Ctx) => Promise<void>;
    check: (c: Ctx) => void;
  }[] = [
    {
      name: "admin PATCH /clients/:id",
      run: async (c) => {
        expect(
          (await post(`/api/v1/clients/${c.id}`, "PATCH", { name: "Patched" })).statusCode
        ).toBe(200);
      },
      check: (c) => expect(cellOf(c.id, "Name")).toBe("Patched"),
    },
    {
      name: "admin DELETE /clients/:id (archive)",
      run: async (c) => {
        expect((await post(`/api/v1/clients/${c.id}`, "DELETE")).statusCode).toBe(204);
      },
      check: (c) => expect(rowOf(c.id)).toBeUndefined(),
    },
    {
      name: "account.updated webhook readiness sync",
      run: async () => {
        await db
          .update(clients)
          .set({
            chargesEnabled: true,
            payoutsEnabled: true,
            detailsSubmitted: true,
            updatedAt: new Date(),
          })
          .where(eq(clients.stripeAccountId, "acct_wh"));
      },
      check: (c) => expect(cellOf(c.id, "Charges Enabled")).toBe("Yes"),
    },
    {
      name: "onboarding callback",
      run: async (c) => {
        await db.transaction(async (tx) => {
          await tx
            .update(clients)
            .set({
              stripeAccountId: "acct_cb",
              chargesEnabled: true,
              payoutsEnabled: false,
              detailsSubmitted: true,
              updatedAt: new Date(),
            })
            .where(eq(clients.id, c.id));
        });
      },
      check: (c) => expect(cellOf(c.id, "Stripe Account")).toBe("acct_cb"),
    },
    {
      name: "Connect account claim (sets no updatedAt itself)",
      run: async (c) => {
        await db
          .update(clients)
          .set({
            stripeAccountId: "acct_claim",
            chargesEnabled: false,
            payoutsEnabled: false,
            detailsSubmitted: false,
          })
          .where(and(eq(clients.id, c.id), isNull(clients.stripeAccountId)));
      },
      check: (c) => expect(cellOf(c.id, "Stripe Account")).toBe("acct_claim"),
    },
    {
      name: "api key regeneration",
      run: async (c) => {
        await db
          .update(clients)
          .set({ apiKeyHash: "h", apiKeyLookup: "l", updatedAt: new Date() })
          .where(eq(clients.id, c.id));
      },
      check: (c) => expect(cellOf(c.id, "Updated")).toBe(formatDateTime(new Date())),
    },
    {
      name: "admin PATCH /groups/:id (group fee)",
      run: async (c) => {
        expect(
          (await post(`/api/v1/groups/${c.groupId}`, "PATCH", { processingFeeCents: 300 }))
            .statusCode
        ).toBe(200);
      },
      check: (c) => expect(cellOf(c.id, "Fee $")).toBe(3),
    },
    {
      name: "payment ledger insert",
      run: async (c) => {
        await addPayment(c.id, { feeAmountCents: 125 });
      },
      check: (c) => {
        expect(cellOf(c.id, "Payments (30d)")).toBe(1);
        expect(cellOf(c.id, "DFWSC Fees (30d)")).toBe(1.25);
      },
    },
    {
      name: "payment ledger webhook update (refund)",
      run: async (c) => {
        const pay = await addPayment(c.id);
        await cycle();
        await settle();
        await db
          .update(paymentLedger)
          .set({ status: "refunded", refundedAmountCents: 1100 })
          .where(eq(paymentLedger.id, pay));
      },
      check: (c) => expect(cellOf(c.id, "Payments (30d)")).toBe(0),
    },
    {
      name: "client factory insert",
      run: async () => {
        await createClientWithOnboardingToken({
          name: "Factory Co",
          email: "factory@example.com",
          workspace: "client_portal",
        });
      },
      check: () => {
        const names = accountRows().map((r) => fake.cell(r, "Name"));
        expect(names).toContain("Factory Co");
      },
    },
  ];

  for (const p of paths) {
    it(p.name, async () => {
      await db.insert(clientGroups).values({ id: "g-wp", name: "Group" });
      const id = await addClient({
        groupId: "g-wp",
        stripeAccountId: p.name.includes("claim") ? null : "acct_wh",
      });
      await cycle();
      await settle();
      // Settled: an idle cycle writes nothing, so the change below is what dirties the row.
      fake.calls = [];
      await cycle();
      expect(rowWrites()).toHaveLength(0);
      const c = { id, groupId: "g-wp" };
      await p.run(c);
      await cycle();
      p.check(c);
    });
  }

  it("has no write path to clients, client_groups or payment_ledger outside the known list", () => {
    // A new writer must be added to this list on purpose, together with a case above.
    const known = new Set([
      "lib/api-key-regeneration.ts",
      "lib/client-factory.ts",
      "lib/stripe-connect-account.ts",
      "routes/clients.ts",
      "routes/connect.ts",
      "routes/groups.ts",
      "routes/payments.ts",
      "routes/webhooks.ts",
    ]);
    const root = path.resolve(__dirname, "../..");
    const found = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__") walk(full);
        } else if (entry.name.endsWith(".ts")) {
          const text = fs.readFileSync(full, "utf8");
          if (/\.(insert|update|delete)\(\s*(clients|clientGroups|paymentLedger)\s*\)/.test(text)) {
            found.add(path.relative(root, full));
          }
        }
      }
    };
    walk(root);
    expect([...found].sort()).toEqual([...known].sort());
  });
});

describe("reconcile", () => {
  it("re-inserts, reverts, de-duplicates and removes strays", async () => {
    const a = await addClient({ name: "Alpha" });
    const b = await addClient({ name: "Beta" });
    const c = await addClient({ name: "Gamma" });
    await cycle();
    await settle();

    const rowA = mustRow(a);
    const rowB = mustRow(b);
    fake.rows = fake.rows.filter((r) => r !== rowA); // deleted in Nextcloud
    rowB.data.set(fake.columnId(tableId(), "Name"), "Edited by hand"); // drift
    fake.rows.push({ ...mustRow(c), id: 9001, data: new Map(mustRow(c).data) }); // duplicate
    fake.rows.push({
      id: 9002,
      tableId: tableId(),
      data: new Map([[fake.columnId(tableId(), "Client ID"), "stray"]]),
    }); // not a client

    resetPortalMirrorStateForTests();
    const result = await cycle();
    expect(result.reconciled).toBe(true);
    expect(cellOf(a, "Name")).toBe("Alpha");
    expect(cellOf(b, "Name")).toBe("Beta");
    expect(accountRows().filter((r) => fake.cell(r, "Client ID") === c)).toHaveLength(1);
    expect(rowOf("stray")).toBeUndefined();
    expect(accountRows()).toHaveLength(3);
    const map = await db.select().from(portalMirrorRows);
    expect(map.every((r) => accountRows().some((row) => row.id === r.ncRowId))).toBe(true);
  });

  it("runs at boot and then not again within a day", async () => {
    await addClient();
    expect((await cycle()).reconciled).toBe(true);
    expect((await cycle()).reconciled).toBe(false);
  });
});

describe("failure handling", () => {
  it("backs a failing row off and keeps the others going", async () => {
    const bad = await addClient({ name: "Bad" });
    const good = await addClient({ name: "Good" });
    fake.fail("POST", /\/rows$/, 400, 1);
    const result = await cycle();
    expect(result.failed).toBe(1);
    expect(result.created).toBe(1);
    const mapped = await db.select().from(portalMirrorRows);
    const failed = mapped.find((r) => r.attempts > 0);
    if (!failed) throw new Error("no failed row");
    expect((failed.nextAttemptAt as Date).getTime()).toBeGreaterThan(Date.now());
    expect(failed.lastError).toContain("NextcloudHttpError:400");
    expect([rowOf(bad), rowOf(good)].filter(Boolean)).toHaveLength(1);

    await cycle(); // still backing off: nothing retried
    expect(accountRows()).toHaveLength(1);

    await db.execute(
      sql`UPDATE portal_mirror_rows SET next_attempt_at = now() - interval '1 second'`
    );
    await cycle();
    expect(accountRows()).toHaveLength(2);
    expect((await db.select().from(portalMirrorRows)).every((r) => r.attempts === 0)).toBe(true);
  });

  it.each([429, 503])("stops the cycle early on %i instead of hammering", async (status) => {
    for (let i = 0; i < 10; i++) await addClient();
    await cycle(); // provisioned and written
    await db.execute(sql`UPDATE clients SET name = name || 'x'`);
    fake.calls = [];
    fake.fail("PUT", /\/rows\//, status, 100);
    const result = await cycle();
    expect(result.status).toBe("nextcloud_unavailable");
    expect(fake.callsTo("PUT", /\/rows\//).length).toBe(1);
  });

  it("backs the whole mirror off after a rejected app password", async () => {
    await addClient();
    fake.fail("GET", /\/tables$/, 401, 5);
    expect((await cycle()).status).toBe("nextcloud_unavailable");
    expect((await cycle()).status).toBe("backoff");
  });

  it("uses a breaker of its own", async () => {
    await addClient();
    openPortalMirrorBreakerForTests();
    expect((await cycle()).status).toBe("nextcloud_unavailable");
    expect(getNextcloudBreakerState().open).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it("runs one cycle at a time across instances", async () => {
    await addClient();
    const holder = await pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtext($1))", ["portal_mirror_cycle"]);
      expect((await cycle()).status).toBe("busy");
      expect(fake.calls).toHaveLength(0);
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtext($1))", ["portal_mirror_cycle"]);
      holder.release();
    }
    expect((await cycle()).status).toBe("ok");
  });
});

describe("throttle", () => {
  it("spaces Nextcloud calls out", async () => {
    const nc = new PortalMirrorNextcloud(
      { baseUrl: MIRROR_NC_URL, username: MIRROR_NC_USER, appPassword: "x" },
      40
    );
    const started = Date.now();
    await nc.listTables();
    await nc.listTables();
    await nc.listTables();
    expect(Date.now() - started).toBeGreaterThanOrEqual(75);
  });
});
