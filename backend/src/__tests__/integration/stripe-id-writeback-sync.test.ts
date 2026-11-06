import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db/client";
import { billingCustomers, clientOnboardingSubmissions, stripeIdWritebacks } from "../../db/schema";
import { resetNextcloudBreakerForTests } from "../../lib/nextcloud";
import { parseLines } from "../../lib/nextcloud-contacts";
import {
  getStripeIdWritebackStats,
  loadStripeIdWritebackConfig,
  resetStripeIdWritebackStateForTests,
  runStripeIdWritebackCycle,
  startStripeIdWriteback,
  triggerStripeIdWriteback,
} from "../../lib/stripe-id-writeback-sync";
import {
  FakeOnboardingNextcloud,
  ONB_ADDRESSBOOK,
  ONB_FORM_ID,
  ONB_PROJECTS_TABLE,
  onboardingEnv,
} from "../helpers/fake-nextcloud-onboarding";

const on = onboardingEnv({ STRIPE_ID_WRITEBACK: "true" });
const ID_COLUMN = 60;
const idColumn = () => ({
  id: ID_COLUMN,
  title: "Stripe Customer ID",
  type: "text",
  subtype: "line",
});

let fake: FakeOnboardingNextcloud;
let lines: { level: string; text: string }[];
const logger = () => {
  const rec =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push({ level, text: JSON.stringify(args) });
    };
  return { info: rec("info"), warn: rec("warn"), error: rec("error") } as unknown as Parameters<
    typeof runStripeIdWritebackCycle
  >[0]["logger"];
};
const cycle = (env: NodeJS.ProcessEnv = on) =>
  runStripeIdWritebackCycle({ logger: logger(), env, minGapMs: 0 });

const vcard = (uid: string, ...body: string[]) =>
  `${["BEGIN:VCARD", "VERSION:3.0", `UID:${uid}`, "FN:Pat Quartermaine", ...body, "REV:20261101T100000Z", "END:VCARD"].join("\r\n")}\r\n`;
const uidOf = (submissionId: number) => `dfwsc-client-${ONB_FORM_ID}-${submissionId}`;
const cardUrls = (name: string, book = fake.cards) =>
  parseLines(book.get(name)?.data ?? "")
    .filter((l) => l.name === "URL")
    .map((l) => l.value);
const dashboard = (id: string) => `https://dashboard.stripe.com/customers/${id}`;
const cardWrites = () =>
  fake.writes().filter((r) => r.method === "PUT" && r.path.includes("addressbooks"));
const rowWrites = () =>
  fake.writes().filter((r) => r.method === "PUT" && r.path.includes("/rows/"));

async function addClient(opts: {
  code: string;
  customerId: string;
  email?: string;
  submissionId?: number;
  tableRowId?: number | null;
  contactStatus?: "created" | "updated" | "ambiguous" | "read_only" | null;
}) {
  await db.insert(billingCustomers).values({
    clientCode: opts.code,
    company: "Zephyrine Widgets LLC",
    email: opts.email ?? `${opts.code.toLowerCase()}@zephyrine.example`,
    stripeCustomerId: opts.customerId,
    source: "matched",
  });
  if (opts.submissionId !== undefined) {
    await db.insert(clientOnboardingSubmissions).values({
      formId: ONB_FORM_ID,
      submissionId: opts.submissionId,
      status: "completed",
      contactStatus: opts.contactStatus === undefined ? "created" : opts.contactStatus,
      contactUid: uidOf(opts.submissionId),
      projectCode: opts.code,
      tableRowId: opts.tableRowId === undefined ? null : opts.tableRowId,
      billingStatus: "linked",
      billingCustomerId: opts.customerId,
    });
  }
}
const stateOf = async (target: "project_row" | "contact_card", key: string) =>
  (await db.select().from(stripeIdWritebacks).where(eq(stripeIdWritebacks.targetKey, key))).find(
    (r) => r.target === target
  );

beforeEach(async () => {
  await db.delete(stripeIdWritebacks);
  await db.delete(clientOnboardingSubmissions);
  await db.delete(billingCustomers);
  resetNextcloudBreakerForTests();
  resetStripeIdWritebackStateForTests();
  lines = [];
  fake = new FakeOnboardingNextcloud();
  fake.columns[ONB_PROJECTS_TABLE].push(idColumn());
  vi.stubGlobal("fetch", vi.fn(fake.fetch));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  resetNextcloudBreakerForTests();
  await db.delete(stripeIdWritebacks);
  await db.delete(clientOnboardingSubmissions);
  await db.delete(billingCustomers);
});

describe("config and flag", () => {
  it("is off by default: nothing starts, nothing is called", async () => {
    expect(startStripeIdWriteback(logger(), onboardingEnv())).toBeNull();
    expect(await cycle(onboardingEnv())).toMatchObject({ status: "disabled" });
    expect(fake.requests).toHaveLength(0);
    triggerStripeIdWriteback();
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects a bad interval or missing config and says why", () => {
    for (const env of [
      { ...on, STRIPE_ID_WRITEBACK_INTERVAL_MS: "30000" },
      { ...on, STRIPE_ID_WRITEBACK_INTERVAL_MS: "soon" },
      { ...on, NEXTCLOUD_BASE_URL: undefined },
      { ...on, CLIENT_ONBOARDING_PROJECTS_TABLE_ID: undefined },
      { ...on, CLIENT_ONBOARDING_ADDRESSBOOK_PATH: "a/b" },
    ]) {
      const config = loadStripeIdWritebackConfig(env as NodeJS.ProcessEnv);
      expect(config.status).toBe("invalid");
      expect(startStripeIdWriteback(logger(), env as NodeJS.ProcessEnv)).toBeNull();
    }
    const ok = loadStripeIdWritebackConfig({ ...on, STRIPE_ID_WRITEBACK_INTERVAL_MS: "60000" });
    expect(ok).toMatchObject({ status: "ready", settings: { intervalMs: 60000, dryRun: false } });
    const dflt = loadStripeIdWritebackConfig(on);
    expect(dflt).toMatchObject({ settings: { intervalMs: 300000 } });
  });

  it("starts a runner that cycles immediately and on trigger, then stops cleanly", async () => {
    await addClient({ code: "CP-001", customerId: "cus_A1", submissionId: 5, tableRowId: 27 });
    fake.addCard(`${uidOf(5)}.vcf`, vcard(uidOf(5)));
    const runner = startStripeIdWriteback(logger(), on);
    expect(runner).not.toBeNull();
    await vi.waitFor(() => expect(fake.rowCell(27, ID_COLUMN)).toBe("cus_A1"));
    await vi.waitFor(() => expect(getStripeIdWritebackStats().lastCycleStatus).toBe("ok"));
    await runner?.stop();
    const requests = fake.requests.length;
    triggerStripeIdWriteback();
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.requests.length).toBe(requests);
  });
});

describe("linked client with a submission", () => {
  beforeEach(async () => {
    await addClient({ code: "CP-001", customerId: "cus_A1", submissionId: 5, tableRowId: 27 });
    fake.addCard(`${uidOf(5)}.vcf`, vcard(uidOf(5), "EMAIL;TYPE=WORK:ap@zephyrine.example"));
  });

  it("writes the row cell and the card, then a second cycle makes zero writes", async () => {
    expect(await cycle()).toMatchObject({ status: "ok", written: 2, failed: 0 });
    expect(fake.rowCell(27, ID_COLUMN)).toBe("cus_A1");
    expect(cardUrls(`${uidOf(5)}.vcf`)).toEqual([dashboard("cus_A1")]);
    const card = fake.cards.get(`${uidOf(5)}.vcf`)?.data ?? "";
    expect(card).toContain("NEXTCLOUD1.X-ABLABEL:Stripe customer");
    expect(card).toContain("EMAIL;TYPE=WORK:ap@zephyrine.example");

    const before = fake.writes().length;
    const requests = fake.requests.length;
    expect(await cycle()).toMatchObject({ status: "ok", written: 0, failed: 0 });
    expect(fake.writes()).toHaveLength(before);
    // Nothing due: Nextcloud is not even read.
    expect(fake.requests).toHaveLength(requests);

    expect(await stateOf("project_row", "CP-001")).toMatchObject({
      status: "ok",
      ncRowId: 27,
      writtenHash: expect.any(String),
    });
    expect(await stateOf("contact_card", uidOf(5))).toMatchObject({
      status: "ok",
      addressbook: ONB_ADDRESSBOOK,
    });
  });

  it("only writes our cell: a partial update of the Stripe Customer ID column", async () => {
    await cycle();
    expect(rowWrites()).toHaveLength(1);
    expect(JSON.parse(rowWrites()[0].body)).toEqual({ data: { [ID_COLUMN]: "cus_A1" } });
  });

  it("does not log emails or names", async () => {
    await cycle();
    const text = lines.map((l) => l.text).join("\n");
    expect(text).toContain("cus_A1");
    expect(text).not.toMatch(/zephyrine\.example|Quartermaine|Zephyrine Widgets/);
  });

  it("rewrites both when the link changes (DB wins), replacing the old id", async () => {
    await cycle();
    await db
      .update(billingCustomers)
      .set({ stripeCustomerId: "cus_B2" })
      .where(eq(billingCustomers.clientCode, "CP-001"));
    expect(await cycle()).toMatchObject({ written: 2 });
    expect(fake.rowCell(27, ID_COLUMN)).toBe("cus_B2");
    expect(cardUrls(`${uidOf(5)}.vcf`)).toEqual([dashboard("cus_B2")]);
  });

  it("repairs a hand edit, a cleared cell and a deleted URL, only in the daily verify pass", async () => {
    await cycle();
    fake.row(27)?.data.set(ID_COLUMN, "cus_HAND");
    fake.addCard(`${uidOf(5)}.vcf`, vcard(uidOf(5)));
    expect(await cycle()).toMatchObject({ written: 0, verified: false });
    expect(fake.rowCell(27, ID_COLUMN)).toBe("cus_HAND");

    resetStripeIdWritebackStateForTests(); // the verify timer elapsed
    expect(await cycle()).toMatchObject({ written: 2, verified: true });
    expect(fake.rowCell(27, ID_COLUMN)).toBe("cus_A1");
    expect(cardUrls(`${uidOf(5)}.vcf`)).toEqual([dashboard("cus_A1")]);

    resetStripeIdWritebackStateForTests();
    expect(await cycle()).toMatchObject({ written: 0, unchanged: 2, verified: true });
  });

  it("flags a stored row id that no longer points at the project (row deleted) as not_found", async () => {
    await cycle();
    fake.rows = fake.rows.filter((r) => r.id !== 27);
    await db
      .update(billingCustomers)
      .set({ stripeCustomerId: "cus_B2" })
      .where(eq(billingCustomers.clientCode, "CP-001"));
    await cycle();
    expect(await stateOf("project_row", "CP-001")).toMatchObject({
      status: "not_found",
      ncRowId: null,
    });
  });

  it("a card write-back never changes a mapped field and keeps every other line", async () => {
    const original = fake.cards.get(`${uidOf(5)}.vcf`)?.data ?? "";
    await cycle();
    const after = fake.cards.get(`${uidOf(5)}.vcf`)?.data ?? "";
    for (const l of parseLines(original)) {
      if (l.name !== "REV") expect(parseLines(after).map((x) => x.raw)).toContain(l.raw);
    }
  });
});

describe("a client linked by the backfill script (no submission)", () => {
  it("finds the row by Project Code and the card by its billing email", async () => {
    fake.rows.push({
      id: 40,
      tableId: ONB_PROJECTS_TABLE,
      data: new Map<number, unknown>([
        [26, "CP-004"],
        [27, "Legacy"],
      ]),
    });
    await addClient({ code: "CP-004", customerId: "cus_LEG", email: "billing@legacy.example" });
    fake.addCard("legacy.vcf", vcard("legacy-uid", "EMAIL;TYPE=WORK:Billing@Legacy.example"));
    fake.addCard("other.vcf", vcard("other-uid", "EMAIL;TYPE=WORK:someone@else.example"));
    expect(await cycle()).toMatchObject({ status: "ok", written: 2, failed: 0 });
    expect(fake.rowCell(40, ID_COLUMN)).toBe("cus_LEG");
    expect(cardUrls("legacy.vcf")).toEqual([dashboard("cus_LEG")]);
    expect(cardUrls("other.vcf")).toEqual([]);
    expect(await stateOf("contact_card", "client:CP-004")).toMatchObject({ status: "ok" });
    expect(await cycle()).toMatchObject({ written: 0 });
  });

  it("is ambiguous when the email matches two cards, and writes neither", async () => {
    fake.rows.push({
      id: 40,
      tableId: ONB_PROJECTS_TABLE,
      data: new Map<number, unknown>([[26, "CP-004"]]),
    });
    await addClient({ code: "CP-004", customerId: "cus_LEG", email: "billing@legacy.example" });
    fake.addCard("a.vcf", vcard("a", "EMAIL:billing@legacy.example"));
    fake.addCard("b.vcf", vcard("b", "EMAIL:billing@legacy.example"));
    const result = await cycle();
    expect(result).toMatchObject({ written: 1, failed: 1 });
    expect(fake.rowCell(40, ID_COLUMN)).toBe("cus_LEG");
    expect(cardWrites()).toHaveLength(0);
    expect(await stateOf("contact_card", "client:CP-004")).toMatchObject({
      status: "ambiguous",
      lastError: "email_matches_several",
    });
  });

  it("is not_found when no card has the email, and never creates a card", async () => {
    await addClient({ code: "CP-004", customerId: "cus_LEG", email: "billing@legacy.example" });
    await cycle();
    expect(await stateOf("contact_card", "client:CP-004")).toMatchObject({ status: "not_found" });
    expect(await stateOf("project_row", "CP-004")).toMatchObject({ status: "not_found" });
    expect(fake.cards.size).toBe(0);
    expect(
      fake.writes().filter((r) => r.method === "POST" && r.path.includes("rows"))
    ).toHaveLength(0);
  });

  it("does not count a matching card in a read-only book", async () => {
    await addClient({ code: "CP-004", customerId: "cus_LEG", email: "billing@legacy.example" });
    fake.addBook("shared-ro", true);
    fake.addCardTo("shared-ro", "ro.vcf", vcard("ro", "EMAIL:billing@legacy.example"));
    fake.addCard("mine.vcf", vcard("mine", "EMAIL:billing@legacy.example"));
    await cycle();
    expect(cardUrls("mine.vcf")).toEqual([dashboard("cus_LEG")]);
  });
});

describe("failures", () => {
  it("marks a deleted card not_found (submission UID) and still writes the row", async () => {
    await addClient({ code: "CP-001", customerId: "cus_A1", submissionId: 5, tableRowId: 27 });
    expect(await cycle()).toMatchObject({ written: 1, failed: 1 });
    expect(fake.rowCell(27, ID_COLUMN)).toBe("cus_A1");
    expect(await stateOf("contact_card", uidOf(5))).toMatchObject({
      status: "not_found",
      lastError: "card_not_found",
    });
  });

  it("falls back to the Project Code when the stored row id is gone, and marks no row not_found", async () => {
    await addClient({ code: "CP-001", customerId: "cus_A1", submissionId: 5, tableRowId: 999 });
    fake.addCard(`${uidOf(5)}.vcf`, vcard(uidOf(5)));
    await cycle();
    expect(fake.rowCell(27, ID_COLUMN)).toBe("cus_A1");
    expect(await stateOf("project_row", "CP-001")).toMatchObject({ status: "ok", ncRowId: 27 });
  });

  it("is ambiguous when several rows share the project code", async () => {
    await addClient({ code: "CP-009", customerId: "cus_X" });
    for (const id of [41, 42]) {
      fake.rows.push({
        id,
        tableId: ONB_PROJECTS_TABLE,
        data: new Map<number, unknown>([[26, "CP-009"]]),
      });
    }
    await cycle();
    expect(await stateOf("project_row", "CP-009")).toMatchObject({ status: "ambiguous" });
    expect(rowWrites()).toHaveLength(0);
  });

  it("marks a read-only address book read_only and does not write to it", async () => {
    await addClient({ code: "CP-001", customerId: "cus_A1", submissionId: 5, tableRowId: 27 });
    fake.addBook("shared-ro", true);
    fake.addCardTo("shared-ro", "c.vcf", vcard(uidOf(5)));
    await cycle();
    expect(cardWrites()).toHaveLength(0);
    expect(await stateOf("contact_card", uidOf(5))).toMatchObject({ status: "read_only" });
  });

  it("retries a 412 (card edited since it was read) on the next cycle", async () => {
    await addClient({ code: "CP-001", customerId: "cus_A1", submissionId: 5, tableRowId: 27 });
    fake.addCard(`${uidOf(5)}.vcf`, vcard(uidOf(5)));
    fake.fail({ match: (r) => r.method === "PUT" && r.path.includes("addressbooks"), status: 412 });
    await cycle();
    expect(cardUrls(`${uidOf(5)}.vcf`)).toEqual([]);
    expect(await stateOf("contact_card", uidOf(5))).toMatchObject({
      status: "error",
      lastError: "card_changed",
    });
    expect(await cycle()).toMatchObject({ written: 1, failed: 0 });
    expect(cardUrls(`${uidOf(5)}.vcf`)).toEqual([dashboard("cus_A1")]);
    expect(cardWrites().every((r) => r.headers["if-match"])).toBe(true);
  });

  it("detects a row update Tables acknowledged without storing", async () => {
    await addClient({ code: "CP-001", customerId: "cus_A1", submissionId: 5, tableRowId: 27 });
    fake.droppedRowUpdates = 1;
    await cycle();
    expect(await stateOf("project_row", "CP-001")).toMatchObject({
      status: "error",
      lastError: "not_persisted",
      writtenHash: null,
    });
  });

  it("ends the cycle as nextcloud_unavailable on a 5xx and records nothing as written", async () => {
    await addClient({ code: "CP-001", customerId: "cus_A1", submissionId: 5, tableRowId: 27 });
    fake.fail({ match: (r) => r.path.includes("/columns"), status: 503 });
    expect(await cycle()).toMatchObject({ status: "nextcloud_unavailable" });
    expect(getStripeIdWritebackStats().lastCycleStatus).toBe("nextcloud_unavailable");
  });
});

describe("the Stripe Customer ID column", () => {
  beforeEach(async () => {
    await addClient({ code: "CP-001", customerId: "cus_A1", submissionId: 5, tableRowId: 27 });
    fake.addCard(`${uidOf(5)}.vcf`, vcard(uidOf(5)));
  });

  it("is created once when missing, then rows are written", async () => {
    fake.columns[ONB_PROJECTS_TABLE] = fake.columns[ONB_PROJECTS_TABLE].filter(
      (c) => c.id !== ID_COLUMN
    );
    await cycle();
    const created = fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/columns"));
    expect(created).toHaveLength(1);
    expect(JSON.parse(created[0].body)).toMatchObject({
      title: "Stripe Customer ID",
      type: "text",
      subtype: "line",
    });
    const column = fake.columns[ONB_PROJECTS_TABLE].find((c) => c.title === "Stripe Customer ID");
    expect(fake.rowCell(27, column?.id as number)).toBe("cus_A1");
  });

  it("on a 403 logs once with fix-it instructions, still writes the card, and picks the column up when added by hand", async () => {
    fake.columns[ONB_PROJECTS_TABLE] = fake.columns[ONB_PROJECTS_TABLE].filter(
      (c) => c.id !== ID_COLUMN
    );
    fake.fail({
      match: (r) => r.method === "POST" && r.path.endsWith("/columns"),
      status: 403,
      times: 10,
    });
    expect(await cycle()).toMatchObject({ status: "ok", written: 1, failed: 1 });
    expect(cardUrls(`${uidOf(5)}.vcf`)).toEqual([dashboard("cus_A1")]);
    expect(await stateOf("project_row", "CP-001")).toMatchObject({
      status: "forbidden",
      lastError: "column_missing",
    });
    const errors = lines.filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].text).toContain("by hand");
    expect(errors[0].text).toContain("Stripe Customer ID");

    // Later cycles do not try to create it again and do not repeat the error.
    expect(await cycle()).toMatchObject({ status: "ok" });
    expect(
      fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/columns"))
    ).toHaveLength(1);
    expect(lines.filter((l) => l.level === "error")).toHaveLength(1);

    fake.columns[ONB_PROJECTS_TABLE].push(idColumn());
    expect(await cycle()).toMatchObject({ status: "ok", failed: 0 });
    expect(fake.rowCell(27, ID_COLUMN)).toBe("cus_A1");
  });

  it("refuses a column that is not a single-line text column", async () => {
    fake.columns[ONB_PROJECTS_TABLE] = [
      ...fake.columns[ONB_PROJECTS_TABLE].filter((c) => c.id !== ID_COLUMN),
      { id: ID_COLUMN, title: "Stripe Customer ID", type: "text", subtype: "link" },
    ];
    await cycle();
    expect(rowWrites()).toHaveLength(0);
    expect(await stateOf("project_row", "CP-001")).toMatchObject({ lastError: "column_type" });
  });
});

describe("shared Customers", () => {
  it("gives every code on one Customer the same id", async () => {
    await addClient({ code: "CP-001", customerId: "cus_S", submissionId: 5, tableRowId: 27 });
    await addClient({ code: "CP-002", customerId: "cus_S", submissionId: 6, tableRowId: 28 });
    fake.addCard(`${uidOf(5)}.vcf`, vcard(uidOf(5)));
    fake.addCard(`${uidOf(6)}.vcf`, vcard(uidOf(6)));
    expect(await cycle()).toMatchObject({ written: 4 });
    expect(fake.rowCell(27, ID_COLUMN)).toBe("cus_S");
    expect(fake.rowCell(28, ID_COLUMN)).toBe("cus_S");
    expect(cardUrls(`${uidOf(5)}.vcf`)).toEqual([dashboard("cus_S")]);
    expect(cardUrls(`${uidOf(6)}.vcf`)).toEqual([dashboard("cus_S")]);
  });

  it("writes one URL per distinct Customer on a card shared by two codes, and warns", async () => {
    await addClient({ code: "CP-001", customerId: "cus_B", submissionId: 5, tableRowId: 27 });
    await addClient({ code: "CP-002", customerId: "cus_A", tableRowId: 28 });
    // CP-002's submission reaches the same card.
    await db.insert(clientOnboardingSubmissions).values({
      formId: ONB_FORM_ID,
      submissionId: 6,
      status: "completed",
      contactStatus: "updated",
      contactUid: uidOf(5),
      projectCode: "CP-002",
      tableRowId: 28,
    });
    fake.addCard(`${uidOf(5)}.vcf`, vcard(uidOf(5)));
    await cycle();
    expect(cardUrls(`${uidOf(5)}.vcf`)).toEqual([dashboard("cus_A"), dashboard("cus_B")]);
    expect(cardWrites()).toHaveLength(1);
    expect(
      lines.some((l) => l.level === "warn" && l.text.includes("several Stripe Customers"))
    ).toBe(true);
    expect(fake.rowCell(27, ID_COLUMN)).toBe("cus_B");
    expect(fake.rowCell(28, ID_COLUMN)).toBe("cus_A");
    expect(await cycle()).toMatchObject({ written: 0 });
  });
});

describe("dry run parsing", () => {
  const dry = (value: string | undefined) =>
    loadStripeIdWritebackConfig({ ...on, STRIPE_ID_WRITEBACK_DRY_RUN: value } as NodeJS.ProcessEnv);

  it("reads true/1/yes in any case as a dry run, with no warning", () => {
    for (const v of ["true", "TRUE", " Yes ", "1"]) {
      expect(dry(v)).toMatchObject({ settings: { dryRun: true }, warnings: [] });
    }
  });

  it("reads unset, empty, false/0/no as live, with no warning", () => {
    for (const v of [undefined, "", "false", "False", "0", "no"]) {
      expect(dry(v)).toMatchObject({ settings: { dryRun: false }, warnings: [] });
    }
  });

  it("treats any other value as a dry run and warns, once per process", async () => {
    expect(dry("ture")).toMatchObject({ settings: { dryRun: true } });
    expect((dry("ture") as { warnings: string[] }).warnings).toHaveLength(1);
    await addClient({ code: "CP-001", customerId: "cus_A1", submissionId: 5, tableRowId: 27 });
    fake.addCard(`${uidOf(5)}.vcf`, vcard(uidOf(5)));
    const env = { ...on, STRIPE_ID_WRITEBACK_DRY_RUN: "ture" } as NodeJS.ProcessEnv;
    expect(await cycle(env)).toMatchObject({ planned: 2, written: 0 });
    await cycle(env);
    expect(fake.writes()).toHaveLength(0);
    expect(lines.filter((l) => l.text.includes("config warning"))).toHaveLength(1);
  });
});

describe("per-card due-ness", () => {
  it("leaves a card in backoff alone while another card is written", async () => {
    await addClient({ code: "CP-001", customerId: "cus_A", submissionId: 5, tableRowId: 27 });
    await cycle(); // the card is missing: not_found, in backoff
    const before = await stateOf("contact_card", uidOf(5));
    expect(before).toMatchObject({ status: "not_found", attempts: 1 });
    expect(before?.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now());

    fake.addCard(`${uidOf(5)}.vcf`, vcard(uidOf(5)));
    await addClient({ code: "CP-002", customerId: "cus_B", submissionId: 6, tableRowId: 28 });
    fake.addCard(`${uidOf(6)}.vcf`, vcard(uidOf(6)));
    await cycle();
    expect(cardWrites().map((w) => w.path)).toEqual([expect.stringContaining(uidOf(6))]);
    expect(cardUrls(`${uidOf(5)}.vcf`)).toEqual([]);
    const after = await stateOf("contact_card", uidOf(5));
    expect(after?.attempts).toBe(1);
    expect(after?.nextAttemptAt?.getTime()).toBe(before?.nextAttemptAt?.getTime());
    expect(await stateOf("contact_card", uidOf(6))).toMatchObject({ status: "ok" });
  });

  it("does not rewrite a hand-edited card that is not due until the verify pass", async () => {
    await addClient({ code: "CP-001", customerId: "cus_A", submissionId: 5, tableRowId: 27 });
    fake.addCard(`${uidOf(5)}.vcf`, vcard(uidOf(5)));
    await cycle();
    fake.addCard(`${uidOf(5)}.vcf`, vcard(uidOf(5))); // URL entry hand-deleted
    await addClient({ code: "CP-002", customerId: "cus_B", submissionId: 6, tableRowId: 28 });
    fake.addCard(`${uidOf(6)}.vcf`, vcard(uidOf(6)));
    const writesBefore = cardWrites().length;
    await cycle();
    expect(cardWrites()).toHaveLength(writesBefore + 1);
    expect(cardUrls(`${uidOf(5)}.vcf`)).toEqual([]);
    expect(cardUrls(`${uidOf(6)}.vcf`)).toEqual([dashboard("cus_B")]);

    resetStripeIdWritebackStateForTests(); // the verify timer elapsed
    await cycle();
    expect(cardUrls(`${uidOf(5)}.vcf`)).toEqual([dashboard("cus_A")]);
  });

  it("still writes every id to a card shared by a due and a not due entry, without touching the latter's state", async () => {
    await addClient({ code: "CP-001", customerId: "cus_A", submissionId: 5, tableRowId: 27 });
    fake.addCard(`${uidOf(5)}.vcf`, vcard(uidOf(5), "EMAIL;TYPE=WORK:shared@zephyrine.example"));
    await cycle();
    const first = await stateOf("contact_card", uidOf(5));
    // CP-002 has no submission and reaches the same card by its billing email.
    await addClient({ code: "CP-002", customerId: "cus_B", email: "shared@zephyrine.example" });
    await cycle();
    expect(cardUrls(`${uidOf(5)}.vcf`)).toEqual([dashboard("cus_A"), dashboard("cus_B")]);
    const same = await stateOf("contact_card", uidOf(5));
    expect(same).toMatchObject({ status: "ok", attempts: 0 });
    expect(same?.updatedAt.getTime()).toBe(first?.updatedAt.getTime());
    expect(await stateOf("contact_card", "client:CP-002")).toMatchObject({ status: "ok" });
  });
});

describe("dry run", () => {
  it("logs the planned writes and writes nothing to Nextcloud or the state table", async () => {
    await addClient({ code: "CP-001", customerId: "cus_A1", submissionId: 5, tableRowId: 27 });
    fake.addCard(`${uidOf(5)}.vcf`, vcard(uidOf(5)));
    const dry = { ...on, STRIPE_ID_WRITEBACK_DRY_RUN: "true" } as NodeJS.ProcessEnv;
    expect(await cycle(dry)).toMatchObject({ status: "ok", planned: 2, written: 0 });
    expect(fake.writes()).toHaveLength(0);
    expect(fake.rowCell(27, ID_COLUMN)).toBeUndefined();
    expect(cardUrls(`${uidOf(5)}.vcf`)).toEqual([]);
    expect(await db.select().from(stripeIdWritebacks)).toHaveLength(0);
    expect(lines.filter((l) => l.text.includes("dry run")).length).toBeGreaterThanOrEqual(2);
    // Turning dry run off then writes.
    expect(await cycle()).toMatchObject({ written: 2 });
  });

  it("does not create the missing column in a dry run", async () => {
    await addClient({ code: "CP-001", customerId: "cus_A1", submissionId: 5, tableRowId: 27 });
    fake.columns[ONB_PROJECTS_TABLE] = fake.columns[ONB_PROJECTS_TABLE].filter(
      (c) => c.id !== ID_COLUMN
    );
    await cycle({ ...on, STRIPE_ID_WRITEBACK_DRY_RUN: "true" } as NodeJS.ProcessEnv);
    expect(fake.writes()).toHaveLength(0);
  });
});

describe("bookkeeping", () => {
  it("forgets state for a link that no longer exists and leaves Nextcloud alone", async () => {
    await addClient({ code: "CP-001", customerId: "cus_A1", submissionId: 5, tableRowId: 27 });
    fake.addCard(`${uidOf(5)}.vcf`, vcard(uidOf(5)));
    await cycle();
    await db.delete(clientOnboardingSubmissions);
    await db.delete(billingCustomers);
    const writes = fake.writes().length;
    await cycle();
    expect(await db.select().from(stripeIdWritebacks)).toHaveLength(0);
    expect(fake.writes()).toHaveLength(writes);
  });
});
