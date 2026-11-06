import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/stripe", async () => {
  const { fakeStripe } = await import("../helpers/fake-stripe-billing");
  return { stripe: fakeStripe.stripe };
});

import { db } from "../../db/client";
import {
  billingCustomers,
  billingSnapshots,
  clients,
  portalMirrorRows,
  portalMirrorState,
} from "../../db/schema";
import {
  loadBillingMirrorConfig,
  resetBillingMirrorStateForTests,
  runBillingMirrorCycle,
  startBillingMirror,
} from "../../lib/billing-mirror-sync";
import { resetBillingSnapshotStateForTests, runBillingRefresh } from "../../lib/billing-snapshot";
import { resetCircuitBreakersForTests } from "../../lib/circuit-breakers";
import {
  openPortalMirrorBreakerForTests,
  resetNextcloudBreakerForTests,
} from "../../lib/nextcloud";
import { resetPortalMirrorStateForTests, runPortalMirrorCycle } from "../../lib/portal-mirror-sync";
import { paidInvoice, sub } from "../helpers/billing-fixtures";
import { FakeTablesNextcloud, mirrorEnv } from "../helpers/fake-nextcloud-tables";
import { fakeStripe } from "../helpers/fake-stripe-billing";

let fake: FakeTablesNextcloud;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const env = (extra: Record<string, string> = {}) => {
  const { PORTAL_MIRROR: _omit, ...rest } = mirrorEnv({ BILLING_MIRROR: "true", ...extra });
  return rest as NodeJS.ProcessEnv;
};
const cycle = (e: NodeJS.ProcessEnv = env()) =>
  runBillingMirrorCycle({ logger, env: e, minGapMs: 0 });
const refreshAll = () => runBillingRefresh({ logger, all: true, gapMs: 0 });

const billingTable = () => {
  const t = fake.tables.find((x) => x.title === "Client Billing");
  if (!t) throw new Error("no Client Billing table");
  return t;
};
const rows = () => fake.rowsOf(billingTable().id);
const rowOf = (code: string) => {
  const row = rows().find((r) => fake.cell(r, "Client Code") === code);
  if (!row) throw new Error(`no row ${code}`);
  return row;
};
const rowWrites = () =>
  fake.calls.filter((c) => /\/rows/.test(c.path) && ["POST", "PUT", "DELETE"].includes(c.method));

async function addCustomer(clientCode: string, stripeCustomerId: string, company = "Acme") {
  await db.insert(billingCustomers).values({
    clientCode,
    company,
    email: `${clientCode.toLowerCase()}@example.com`,
    stripeCustomerId,
    source: "created",
  });
}

const wipe = async () => {
  await db.delete(portalMirrorRows);
  await db.delete(portalMirrorState);
  await db.delete(billingSnapshots);
  await db.delete(billingCustomers);
  await db.delete(clients);
};
beforeEach(async () => {
  await wipe();
  fakeStripe.reset();
  resetBillingSnapshotStateForTests();
  resetBillingMirrorStateForTests();
  resetPortalMirrorStateForTests();
  resetCircuitBreakersForTests();
  resetNextcloudBreakerForTests();
  vi.clearAllMocks();
  fake = new FakeTablesNextcloud();
  vi.stubGlobal("fetch", vi.fn(fake.fetch));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await wipe();
});

async function seedOne() {
  await addCustomer("CP-001", "cus_1", "Acme Corp");
  fakeStripe.set("cus_1", {
    subscriptions: [sub({ id: "sub_a" })],
    invoices: [paidInvoice("in_1", "sub_a", 150000, 3)],
  });
  await refreshAll();
}

describe("config", () => {
  it("is off by default and reports problems without throwing", async () => {
    expect(loadBillingMirrorConfig({}).status).toBe("disabled");
    expect((await cycle({})).status).toBe("disabled");
    expect(startBillingMirror(logger, {})).toBeNull();
    const bad = { BILLING_MIRROR: "true", BILLING_SWEEP_INTERVAL_MS: "5" };
    expect(loadBillingMirrorConfig(bad).status).toBe("invalid");
    expect((await cycle(bad)).status).toBe("invalid_config");
    expect(startBillingMirror(logger, bad)).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it("defaults: hourly sweep and read-only groups dfwsc-admins and managers", () => {
    const config = loadBillingMirrorConfig(env());
    if (config.status !== "ready") throw new Error("not ready");
    expect(config.settings.sweepIntervalMs).toBe(3_600_000);
    expect(config.settings.shareGroups).toEqual(["dfwsc-admins", "managers"]);
  });
});

describe("provisioning", () => {
  it("creates Client Billing, its columns in order, and read-only shares for both default groups", async () => {
    await seedOne();
    expect((await cycle()).status).toBe("ok");
    expect(fake.tables.map((t) => t.title)).toEqual(["Client Billing"]);
    expect(fake.columns.get(billingTable().id)?.map((c) => c.title)).toEqual([
      "Client",
      "Client Code",
      "Up to date",
      "Status",
      "Subscription",
      "Payments Made",
      "Amount Paid",
      "Next Due",
      "Open Balance",
      "Overdue Amount",
      "Last Payment",
      "Stripe Customer",
      "Updated",
      "Last Checked",
    ]);
    expect(fake.shares.map((s) => s.receiver).sort()).toEqual(["dfwsc-admins", "managers"]);
    for (const s of fake.shares) {
      expect(s).toMatchObject({
        permissionRead: true,
        permissionCreate: false,
        permissionUpdate: false,
        permissionDelete: false,
        permissionManage: false,
      });
    }
    const [state] = await db
      .select()
      .from(portalMirrorState)
      .where(eq(portalMirrorState.key, "billing_table_id"));
    expect(state.value).toBe(String(billingTable().id));

    await cycle();
    expect(fake.tables).toHaveLength(1);
    expect(fake.shares).toHaveLength(2);
  });

  it("honors BILLING_MIRROR_SHARE_GROUPS", async () => {
    await seedOne();
    await cycle(env({ BILLING_MIRROR_SHARE_GROUPS: "dfwsc-admins" }));
    expect(fake.shares.map((s) => s.receiver)).toEqual(["dfwsc-admins"]);
  });

  it("re-creates a deleted column and coexists with the Portal Accounts table", async () => {
    await seedOne();
    await cycle();
    const columns = fake.columns.get(billingTable().id) ?? [];
    fake.columns.set(
      billingTable().id,
      columns.filter((c) => c.title !== "Status")
    );
    await cycle();
    expect(fake.columns.get(billingTable().id)?.map((c) => c.title)).toContain("Status");

    const portal = await runPortalMirrorCycle({
      logger,
      env: mirrorEnv(),
      minGapMs: 0,
    });
    expect(portal.status).toBe("ok");
    expect(fake.tables.map((t) => t.title).sort()).toEqual(["Client Billing", "Portal Accounts"]);
    const keys = (await db.select().from(portalMirrorState)).map((r) => r.key).sort();
    expect(keys).toEqual(["accounts_table_id", "billing_table_id"]);
  });
});

describe("rows", () => {
  it("writes a row with the verified shapes and links the Stripe Customer as text", async () => {
    await seedOne();
    const out = await cycle();
    expect(out).toMatchObject({ status: "ok", created: 1 });
    const row = rowOf("CP-001");
    expect(fake.cell(row, "Client")).toBe("Acme Corp");
    expect(fake.cell(row, "Status")).toBe("Active");
    expect(fake.cell(row, "Up to date")).toBe("Yes");
    expect(fake.cell(row, "Subscription")).toBe("$1,500/week");
    expect(fake.cell(row, "Payments Made")).toBe("1");
    expect(fake.cell(row, "Amount Paid")).toBe(1500);
    expect(fake.cell(row, "Open Balance")).toBe(0);
    expect(fake.cell(row, "Stripe Customer")).toBe("https://dashboard.stripe.com/customers/cus_1");
    expect(String(fake.cell(row, "Updated"))).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
    const money = fake.columns.get(billingTable().id)?.find((c) => c.title === "Amount Paid");
    expect(money).toMatchObject({ type: "number", numberPrefix: "$", numberDecimals: 2 });
  });

  it("writes nothing on an unchanged cycle, and updates the row when the snapshot changes", async () => {
    await seedOne();
    await cycle();
    fake.calls = [];
    expect((await cycle()).unchanged).toBe(1);
    expect(rowWrites()).toHaveLength(0);

    fakeStripe.set("cus_1", {
      subscriptions: [sub({ id: "sub_a" })],
      invoices: [paidInvoice("in_1", "sub_a", 150000, 3), paidInvoice("in_2", "sub_a", 150000, 10)],
    });
    await refreshAll();
    expect((await cycle()).updated).toBe(1);
    expect(fake.cell(rowOf("CP-001"), "Amount Paid")).toBe(3000);
    expect(rowWrites()).toHaveLength(1);
  });

  it("moves Last Checked on a refresh that finds no content change, leaving Updated alone", async () => {
    await seedOne();
    await cycle();
    const before = rowOf("CP-001");
    const lastChecked = fake.cell(before, "Last Checked");
    const updated = fake.cell(before, "Updated");
    const [snapshotBefore] = await db.select().from(billingSnapshots);

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60 * 60 * 1000 });
    try {
      await refreshAll();
      const [snapshotAfter] = await db.select().from(billingSnapshots);
      expect(snapshotAfter.contentHash).toBe(snapshotBefore.contentHash);
      expect(snapshotAfter.updatedAt).toEqual(snapshotBefore.updatedAt);
      expect(snapshotAfter.refreshedAt?.getTime()).toBeGreaterThan(
        snapshotBefore.refreshedAt?.getTime() ?? 0
      );
      fake.calls = [];
      expect((await cycle()).updated).toBe(1);
      expect(rowWrites()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
    expect(fake.cell(rowOf("CP-001"), "Last Checked")).not.toBe(lastChecked);
    expect(fake.cell(rowOf("CP-001"), "Updated")).toBe(updated);
  });

  it("gives every client code of a shared Customer the same data plus a note", async () => {
    await addCustomer("CP-001", "cus_1", "Acme");
    await addCustomer("CP-002", "cus_1", "Acme");
    fakeStripe.set("cus_1", { subscriptions: [sub({ id: "sub_a" })] });
    await refreshAll();
    await cycle();
    expect(rows()).toHaveLength(2);
    expect(fake.cell(rowOf("CP-001"), "Client")).toBe(
      "Acme (shares a Stripe Customer with CP-002)"
    );
    expect(fake.cell(rowOf("CP-002"), "Client")).toBe(
      "Acme (shares a Stripe Customer with CP-001)"
    );
    for (const title of ["Status", "Subscription", "Stripe Customer"]) {
      expect(fake.cell(rowOf("CP-001"), title)).toBe(fake.cell(rowOf("CP-002"), title));
    }
  });

  it("removes the row of a deleted billing customer", async () => {
    await seedOne();
    await cycle();
    await db.delete(billingCustomers);
    expect((await cycle()).deleted).toBe(1);
    expect(rows()).toHaveLength(0);
    expect(await db.select().from(portalMirrorRows)).toHaveLength(0);
  });

  it("reverts a hand edit and re-creates a deleted row at the reconcile", async () => {
    await seedOne();
    await cycle();
    fake.cell(rowOf("CP-001"), "Status");
    rowOf("CP-001").data.set(fake.columnId(billingTable().id, "Status"), "Ended");
    resetBillingMirrorStateForTests();
    await cycle();
    expect(fake.cell(rowOf("CP-001"), "Status")).toBe("Active");

    fake.rows = fake.rows.filter((r) => r.tableId !== billingTable().id);
    resetBillingMirrorStateForTests();
    await cycle();
    expect(rows()).toHaveLength(1);
  });

  it("reports an outage without failing, and backs off on a rejected password", async () => {
    await seedOne();
    fake.fail("GET", /\/tables$/, 500, 1);
    expect((await cycle()).status).toBe("nextcloud_unavailable");
    fake.fail("GET", /\/tables$/, 401, 1);
    expect((await cycle()).status).toBe("nextcloud_unavailable");
    expect((await cycle()).status).toBe("backoff");
  });
});

describe("staleness", () => {
  it("gives a Customer without a snapshot a Pending row, then the real one", async () => {
    await addCustomer("CP-001", "cus_1", "Acme Corp");
    expect((await cycle()).created).toBe(1);
    const pending = rowOf("CP-001");
    expect(fake.cell(pending, "Status")).toBe("Pending");
    expect(fake.cell(pending, "Up to date")).toBe("");
    expect(fake.cell(pending, "Subscription")).toBe("");
    expect(fake.cell(pending, "Last Checked")).toBeNull();

    fakeStripe.set("cus_1", { subscriptions: [sub({ id: "sub_a" })] });
    await refreshAll();
    expect((await cycle()).updated).toBe(1);
    expect(fake.cell(rowOf("CP-001"), "Status")).toBe("Active");
    expect(fake.cell(rowOf("CP-001"), "Last Checked")).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  });

  it("shows Check failed when the first refresh fails", async () => {
    await addCustomer("CP-001", "cus_1");
    fakeStripe.beforeList = () => {
      throw Object.assign(new Error("no such customer"), { statusCode: 404 });
    };
    await refreshAll();
    await cycle();
    expect(fake.cell(rowOf("CP-001"), "Status")).toBe("Check failed");
    expect(fake.cell(rowOf("CP-001"), "Up to date")).toBe("");
  });

  it("updates the row to Check failed (was Active) when a later refresh fails, and back on success", async () => {
    await seedOne();
    await cycle();
    expect(fake.cell(rowOf("CP-001"), "Status")).toBe("Active");

    fakeStripe.beforeList = () => {
      throw Object.assign(new Error("gone"), { statusCode: 404 });
    };
    await refreshAll();
    expect((await cycle()).updated).toBe(1);
    expect(fake.cell(rowOf("CP-001"), "Status")).toBe("Check failed (was Active)");
    expect(fake.cell(rowOf("CP-001"), "Up to date")).toBe("");
    expect(fake.cell(rowOf("CP-001"), "Subscription")).toBe("$1,500/week");

    fakeStripe.beforeList = null;
    resetBillingSnapshotStateForTests();
    await refreshAll();
    await cycle();
    expect(fake.cell(rowOf("CP-001"), "Status")).toBe("Active");
  });

  it("uses its own Nextcloud breaker, separate from Portal Accounts", async () => {
    await seedOne();
    openPortalMirrorBreakerForTests();
    expect((await cycle()).status).toBe("ok");
  });
});

describe("startBillingMirror", () => {
  it("sweeps at boot, mirrors, and stops cleanly", async () => {
    await addCustomer("CP-001", "cus_1");
    fakeStripe.set("cus_1", { subscriptions: [sub({ id: "sub_a" })] });
    const runner = startBillingMirror(logger, env());
    expect(runner).not.toBeNull();
    await vi.waitFor(() => expect(rows()).toHaveLength(1), { timeout: 10_000 });
    await runner?.stop();
    expect(fakeStripe.callsTo("subscriptions.list").length).toBeGreaterThanOrEqual(1);
  });
});
