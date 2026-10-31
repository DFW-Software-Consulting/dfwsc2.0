import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db/client";
import { salesLeadSubmissions, salesLeadSyncState } from "../../db/schema";
import { SALES_LEAD_MAX_ATTEMPTS } from "../../lib/constants";
import { openNextcloudBreakerForTests, resetNextcloudBreakerForTests } from "../../lib/nextcloud";
import {
  getSalesLeadSyncStats,
  resetSalesLeadSyncStateForTests,
  runSalesLeadCycle,
  startSalesLeadPoller,
} from "../../lib/sales-lead-sync";
import {
  COLUMN_IDS,
  FAKE_FORM_ID,
  FakeNextcloud,
  type LeadAnswers,
  salesLeadEnv,
} from "../helpers/fake-nextcloud";

type Logger = Parameters<typeof runSalesLeadCycle>[0]["logger"];

function captureLogger() {
  const lines: { level: string; text: string }[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push({ level, text: JSON.stringify(args) });
    };
  const logger = {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  } as unknown as Logger;
  return { logger, lines };
}

const FULL_LEAD: LeadAnswers = {
  Company: "Zephyrine Widgets LLC",
  "Contact name": "Ophelia Quartermaine",
  Email: "ophelia@zephyrine.example",
  Phone: "+1 214 555 0199",
  Source: "Referral",
  Temperature: "Warm",
  "Estimated value": "$12,500",
  "Next follow-up": "2026-11-15",
  Notes: "Wants a quote for the warehouse portal",
};

let fake: FakeNextcloud;
let log: ReturnType<typeof captureLogger>;
const env = salesLeadEnv();

const cycle = (overrideEnv: NodeJS.ProcessEnv = env) =>
  runSalesLeadCycle({ logger: log.logger, env: overrideEnv });

async function submissionRow(submissionId: number) {
  const [row] = await db
    .select()
    .from(salesLeadSubmissions)
    .where(
      and(
        eq(salesLeadSubmissions.formId, FAKE_FORM_ID),
        eq(salesLeadSubmissions.submissionId, submissionId)
      )
    );
  return row;
}

/** Records the baseline (no submissions yet) so later submissions are processed. */
async function baseline() {
  const result = await cycle();
  expect(result.status).toBe("ok");
}

async function makeDue(submissionId: number) {
  await db
    .update(salesLeadSubmissions)
    .set({ nextAttemptAt: new Date(Date.now() - 1000) })
    .where(eq(salesLeadSubmissions.submissionId, submissionId));
}

beforeEach(async () => {
  await db.delete(salesLeadSubmissions);
  await db.delete(salesLeadSyncState);
  resetNextcloudBreakerForTests();
  resetSalesLeadSyncStateForTests();
  fake = new FakeNextcloud();
  log = captureLogger();
  vi.stubGlobal("fetch", vi.fn(fake.fetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetNextcloudBreakerForTests();
});

describe("sales lead automation: flag and config", () => {
  it("does nothing, and calls no Nextcloud API, when the flag is off", async () => {
    fake.addSubmission(1, FULL_LEAD);
    const result = await cycle(salesLeadEnv({ SALES_AUTOMATION_ENABLED: undefined }));
    expect(result.status).toBe("disabled");
    expect(fetch).not.toHaveBeenCalled();
    expect(await db.select().from(salesLeadSyncState)).toHaveLength(0);
    expect(
      startSalesLeadPoller(log.logger, salesLeadEnv({ SALES_AUTOMATION_ENABLED: "false" }))
    ).toBe(null);
    expect(fetch).not.toHaveBeenCalled();
    expect(log.lines).toHaveLength(0);
  });

  it("logs an invalid config once and never calls Nextcloud", async () => {
    const bad = salesLeadEnv({ SALES_LEAD_FORM_ID: "abc" });
    expect((await cycle(bad)).status).toBe("invalid_config");
    expect((await cycle(bad)).status).toBe("invalid_config");
    expect(fetch).not.toHaveBeenCalled();
    const errors = log.lines.filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].text).toContain("SALES_LEAD_FORM_ID");
    expect(getSalesLeadSyncStats().lastCycleStatus).toBe("invalid_config");
  });

  it("does not start the poller on an invalid config", () => {
    expect(startSalesLeadPoller(log.logger, salesLeadEnv({ NEXTCLOUD_BASE_URL: "http://x" }))).toBe(
      null
    );
    expect(log.lines.map((l) => l.level)).toEqual(["error"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops on a missing column, releases the claim and logs once", async () => {
    await baseline();
    fake.columns = fake.columns.filter((c) => c.title !== "Lead Ref");
    fake.addSubmission(1, FULL_LEAD);
    expect((await cycle()).status).toBe("config_error");
    expect((await cycle()).status).toBe("config_error");
    const row = await submissionRow(1);
    expect(row).toMatchObject({ status: "pending", attempts: 0, claimToken: null });
    expect(fake.rowCreates).toHaveLength(0);
    const errors = log.lines.filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].text).toContain("Lead Ref");
  });

  it("treats a form that is not shared (403) as a config error", async () => {
    fake.fail({ match: (r) => r.path.endsWith("/submissions"), status: 403, times: 2 });
    expect((await cycle()).status).toBe("config_error");
    expect((await cycle()).status).toBe("config_error");
    expect(log.lines.filter((l) => l.level === "error")).toHaveLength(1);
    expect(log.lines[0].text).toContain("forms.list_submissions:403");
  });
});

describe("sales lead automation: baseline", () => {
  it("never processes submissions that existed before the first cycle", async () => {
    fake.addSubmission(3, FULL_LEAD);
    fake.addSubmission(7, { Company: "Older Co" });

    expect(await cycle()).toMatchObject({ status: "ok", discovered: 0, completed: 0 });
    const [state] = await db.select().from(salesLeadSyncState);
    expect(state).toMatchObject({ formId: FAKE_FORM_ID, baselineSubmissionId: 7 });

    expect(await cycle()).toMatchObject({ status: "ok", discovered: 0 });
    expect(fake.rowCreates).toHaveLength(0);
    expect(await db.select().from(salesLeadSubmissions)).toHaveLength(0);

    fake.addSubmission(8, { Company: "Newer Co" });
    expect(await cycle()).toMatchObject({ discovered: 1, completed: 1 });
    expect(fake.rowCreates).toHaveLength(1);
    expect(await submissionRow(3)).toBeUndefined();
  });

  it("uses baseline 0 for an empty form, so the first submission is processed", async () => {
    await baseline();
    const [state] = await db.select().from(salesLeadSyncState);
    expect(state.baselineSubmissionId).toBe(0);
    fake.addSubmission(1, FULL_LEAD);
    expect(await cycle()).toMatchObject({ discovered: 1, completed: 1 });
  });

  it("discovers across several pages of submissions", async () => {
    await baseline();
    for (let id = 1; id <= 60; id++) fake.addSubmission(id, { Company: `Co ${id}` });
    const first = await cycle();
    expect(first.discovered).toBe(60);
    expect(await db.select().from(salesLeadSubmissions)).toHaveLength(60);
  });
});

describe("sales lead automation: processing", () => {
  it("creates the row, contact card and folder, then backfills the links", async () => {
    await baseline();
    fake.addSubmission(5, FULL_LEAD);

    expect(await cycle()).toMatchObject({ status: "ok", discovered: 1, completed: 1 });

    expect(fake.rowCreates).toHaveLength(1);
    const rowId = fake.rows[0].id;
    const cell = (title: keyof typeof COLUMN_IDS) => fake.rowCell(rowId, COLUMN_IDS[title]);
    expect(cell("Company")).toBe("Zephyrine Widgets LLC");
    expect(cell("Contact Name")).toBe("Ophelia Quartermaine");
    expect(cell("Stage")).toBe(1);
    expect(cell("Source")).toBe(1);
    expect(cell("Temperature")).toBe(2);
    expect(cell("Estimated Value")).toBe(12500);
    expect(cell("Next Follow-up")).toBe("2026-11-15");
    expect(cell("Summary")).toBe("Wants a quote for the warehouse portal");
    expect(cell("Lead Ref")).toBe(`${FAKE_FORM_ID}:5`);
    expect(cell("Owner")).toBeUndefined();
    // Email and phone go only on the contact card.
    expect(fake.rowCreates[0].body).not.toContain("ophelia@zephyrine.example");
    expect(fake.rowCreates[0].body).not.toContain("555");

    const card = fake.cards.get("dfwsc-lead-12-5.vcf");
    expect(card).toContain("EMAIL;TYPE=WORK:ophelia@zephyrine.example");
    expect(card).toContain("TEL;TYPE=WORK:+1 214 555 0199");
    expect(card).toContain("ORG:Zephyrine Widgets LLC");
    expect(fake.cardPuts[0].headers["if-none-match"]).toBe("*");

    const fileId = fake.folders.get("DFWSC Sales/Leads/Zephyrine Widgets LLC");
    expect(fileId).toBeDefined();
    // Sent as "Title (url)"; stored by Tables as an escaped JSON string.
    expect(fake.rowUpdates[0].body).toContain(
      `Lead folder (https://cloud.test/index.php/f/${fileId})`
    );
    expect(cell("Notes / Files")).toBe(
      `{"title":"Lead folder","value":"https:\\/\\/cloud.test\\/index.php\\/f\\/${fileId}","providerId":"url"}`
    );
    expect(JSON.parse(cell("Contact Card") as string)).toEqual({
      title: "Contact card",
      value:
        "https://cloud.test/index.php/apps/contacts/direct/contact/dfwsc-lead-12-5~dfwsc-sales",
      providerId: "url",
    });

    const done = await submissionRow(5);
    expect(done.linksBackfilledAt).toBeInstanceOf(Date);
    expect(done).toMatchObject({
      status: "completed",
      tableRowId: rowId,
      contactUid: "dfwsc-lead-12-5",
      folderName: "Zephyrine Widgets LLC",
      folderFileId: fileId,
      claimToken: null,
      lastErrorCode: null,
    });
  });

  it("is idempotent: later cycles make no further writes", async () => {
    await baseline();
    fake.addSubmission(5, FULL_LEAD);
    await cycle();
    const writes = () =>
      fake.requests.filter((r) => !["GET", "PROPFIND"].includes(r.method)).length;
    const before = writes();
    for (let i = 0; i < 3; i++) await cycle();
    expect(writes()).toBe(before);
    expect(fake.rows).toHaveLength(1);
    expect(fake.cards.size).toBe(1);
    expect(fake.mkcols).toHaveLength(1);
  });

  it("skips the contact card when no person was given", async () => {
    await baseline();
    fake.addSubmission(5, { Company: "Faceless Corp", Notes: "Called the main line" });
    await cycle();
    expect(fake.cardPuts).toHaveLength(0);
    expect(fake.rowCell(fake.rows[0].id, COLUMN_IDS["Contact Card"])).toBeUndefined();
    expect(fake.rowCell(fake.rows[0].id, COLUMN_IDS["Notes / Files"])).toBeDefined();
    expect((await submissionRow(5)).contactUid).toBeNull();
  });

  it("leaves out answers that match no option, and says which fields", async () => {
    await baseline();
    fake.addSubmission(5, { Company: "Acme", Temperature: "Lukewarm", "Estimated value": "lots" });
    await cycle();
    const rowId = fake.rows[0].id;
    expect(fake.rowCell(rowId, COLUMN_IDS.Temperature)).toBeUndefined();
    expect(fake.rowCell(rowId, COLUMN_IDS["Estimated Value"])).toBeUndefined();
    const warn = log.lines.find((l) => l.text.includes("left out"));
    expect(warn?.text).toContain("temperature");
    expect(warn?.text).toContain("estimatedValue");
    expect(warn?.text).not.toContain("Lukewarm");
  });

  it("gives a duplicate company its own row and a suffixed folder", async () => {
    await baseline();
    fake.folders.set("DFWSC Sales/Leads/Acme", 42);
    fake.addSubmission(5, { Company: "Acme" });
    fake.addSubmission(6, { Company: "Acme" });
    await cycle();
    expect(fake.rows).toHaveLength(2);
    expect((await submissionRow(5)).folderName).toBe("Acme (2)");
    expect((await submissionRow(6)).folderName).toBe("Acme (3)");
    const warns = log.lines.filter((l) => l.text.includes("duplicateCompany"));
    expect(warns).toHaveLength(2);
    expect(warns[0].text).not.toContain("Acme");
  });
});

describe("sales lead automation: partial failure", () => {
  it("resumes after a failed step without repeating the steps that succeeded", async () => {
    await baseline();
    fake.addSubmission(5, FULL_LEAD);
    fake.fail({
      match: (r) => r.method === "PUT" && r.path.includes("/addressbooks/"),
      status: 500,
    });

    expect(await cycle()).toMatchObject({ retried: 1, completed: 0 });
    const afterFailure = await submissionRow(5);
    expect(afterFailure).toMatchObject({
      status: "pending",
      attempts: 1,
      lastErrorCode: "carddav.put_contact:500",
      contactUid: null,
      claimToken: null,
    });
    expect(afterFailure.tableRowId).toBe(fake.rows[0].id);
    expect(afterFailure.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000);

    // Not due yet: nothing happens.
    expect(await cycle()).toMatchObject({ completed: 0, retried: 0 });

    await makeDue(5);
    expect(await cycle()).toMatchObject({ completed: 1 });
    expect(fake.rowCreates).toHaveLength(1);
    expect(fake.cardPuts).toHaveLength(2);
    expect(await submissionRow(5)).toMatchObject({ status: "completed", attempts: 1 });
  });

  it("adopts the row by Lead Ref when the create response was lost", async () => {
    await baseline();
    fake.addSubmission(5, FULL_LEAD);
    fake.fail({
      match: (r) => r.method === "POST" && r.path.endsWith("/rows"),
      timeout: true,
      afterApply: true,
    });

    expect(await cycle()).toMatchObject({ retried: 1 });
    expect(fake.rows).toHaveLength(1);
    expect(await submissionRow(5)).toMatchObject({
      tableRowId: null,
      lastErrorCode: "tables.create_row:timeout",
    });

    await makeDue(5);
    expect(await cycle()).toMatchObject({ completed: 1 });
    expect(fake.rowCreates).toHaveLength(1);
    expect(fake.rows).toHaveLength(1);
    expect((await submissionRow(5)).tableRowId).toBe(fake.rows[0].id);
  });

  it("treats its own folder as created when MKCOL succeeded but the id lookup failed", async () => {
    await baseline();
    fake.addSubmission(5, { Company: "Acme" });
    fake.fail({
      match: (r) => r.method === "PROPFIND" && r.body.includes("fileid"),
      status: 503,
    });
    expect(await cycle()).toMatchObject({ retried: 1 });
    expect((await submissionRow(5)).folderName).toBe("Acme");

    await makeDue(5);
    expect(await cycle()).toMatchObject({ completed: 1 });
    expect(fake.mkcols).toHaveLength(2);
    expect(fake.folders.has("DFWSC Sales/Leads/Acme (2)")).toBe(false);
    expect((await submissionRow(5)).folderName).toBe("Acme");
  });

  it("retries the links when Tables answers 200 but does not store them", async () => {
    await baseline();
    fake.addSubmission(5, FULL_LEAD);
    fake.droppedRowUpdates = 1;

    expect(await cycle()).toMatchObject({ retried: 1, completed: 0 });
    const afterFailure = await submissionRow(5);
    expect(afterFailure).toMatchObject({
      status: "pending",
      attempts: 1,
      lastErrorCode: "tables.link_not_persisted",
      linksBackfilledAt: null,
      claimToken: null,
    });
    expect(fake.rowCell(fake.rows[0].id, COLUMN_IDS["Notes / Files"])).toBeUndefined();

    await makeDue(5);
    expect(await cycle()).toMatchObject({ completed: 1 });
    expect(fake.rowUpdates).toHaveLength(2);
    expect(fake.rowCreates).toHaveLength(1);
    expect(
      JSON.parse(fake.rowCell(fake.rows[0].id, COLUMN_IDS["Notes / Files"]) as string).value
    ).toContain("https://cloud.test/index.php/f/");
    const done = await submissionRow(5);
    expect(done.status).toBe("completed");
    expect(done.linksBackfilledAt).toBeInstanceOf(Date);
  });

  it("fails permanently, with no writes, when the company is missing", async () => {
    await baseline();
    fake.addSubmission(5, { "Contact name": "Nobody" });
    expect(await cycle()).toMatchObject({ failed: 1 });
    expect(await submissionRow(5)).toMatchObject({
      status: "failed",
      attempts: 1,
      lastErrorCode: "missing_company",
    });
    expect(fake.rowCreates).toHaveLength(0);
    await makeDue(5);
    expect(await cycle()).toMatchObject({ failed: 0, completed: 0 });
  });

  it("fails permanently when the submission was deleted", async () => {
    await baseline();
    fake.addSubmission(5, FULL_LEAD);
    // Recorded earlier, then deleted from the form before it was processed.
    await db.insert(salesLeadSubmissions).values({ formId: FAKE_FORM_ID, submissionId: 4 });
    expect(await cycle()).toMatchObject({ completed: 1, failed: 1 });
    expect((await submissionRow(4)).lastErrorCode).toBe("submission_not_found");
  });

  it("fails permanently on a 403 from a step", async () => {
    await baseline();
    fake.addSubmission(5, FULL_LEAD);
    fake.fail({ match: (r) => r.method === "POST", status: 403 });
    expect(await cycle()).toMatchObject({ failed: 1 });
    expect((await submissionRow(5)).lastErrorCode).toBe("tables.create_row:403");
  });

  it("gives up after the maximum number of attempts", async () => {
    await baseline();
    fake.addSubmission(5, FULL_LEAD);
    await db.insert(salesLeadSubmissions).values({
      formId: FAKE_FORM_ID,
      submissionId: 5,
      attempts: SALES_LEAD_MAX_ATTEMPTS - 1,
    });
    fake.fail({ match: (r) => r.method === "POST", status: 502 });
    expect(await cycle()).toMatchObject({ failed: 1 });
    expect(await submissionRow(5)).toMatchObject({
      status: "failed",
      attempts: SALES_LEAD_MAX_ATTEMPTS,
      lastErrorCode: "tables.create_row:502",
    });
  });

  it("uses no attempt when the Nextcloud circuit is open", async () => {
    await baseline();
    await db.insert(salesLeadSubmissions).values({ formId: FAKE_FORM_ID, submissionId: 5 });
    openNextcloudBreakerForTests();
    expect(await cycle()).toMatchObject({ status: "nextcloud_unavailable" });
    expect(await submissionRow(5)).toMatchObject({
      status: "pending",
      attempts: 0,
      claimToken: null,
    });
    expect(getSalesLeadSyncStats().lastCycleStatus).toBe("nextcloud_unavailable");

    resetNextcloudBreakerForTests();
    fake.addSubmission(5, FULL_LEAD);
    expect(await cycle()).toMatchObject({ status: "ok", completed: 1 });
    expect(getSalesLeadSyncStats().lastCycleStatus).toBe("ok");
  });

  it("skips the cycle, without losing anything, when Nextcloud cannot be reached", async () => {
    await baseline();
    fake.addSubmission(5, FULL_LEAD);
    fake.fail({ match: () => true, timeout: true });
    expect(await cycle()).toMatchObject({ status: "nextcloud_unavailable", discovered: 0 });
    expect(await cycle()).toMatchObject({ status: "ok", discovered: 1, completed: 1 });
  });
});

describe("sales lead automation: concurrency", () => {
  it("processes each submission once when cycles overlap", async () => {
    await baseline();
    for (const id of [5, 6, 7]) fake.addSubmission(id, { ...FULL_LEAD, Company: `Company ${id}` });
    fake.latencyMs = 5;

    const results = await Promise.all([cycle(), cycle(), cycle()]);
    expect(results.reduce((n, r) => n + r.completed, 0)).toBe(3);
    expect(fake.rowCreates).toHaveLength(3);
    expect(fake.cardPuts).toHaveLength(3);
    expect(fake.mkcols).toHaveLength(3);
    expect(fake.rowUpdates).toHaveLength(3);
    const rows = await db.select().from(salesLeadSubmissions);
    expect(rows.map((r) => r.status)).toEqual(["completed", "completed", "completed"]);
  });

  it("reclaims a stale claim but leaves a live one alone", async () => {
    await baseline();
    fake.addSubmission(5, FULL_LEAD);
    fake.addSubmission(6, { Company: "Live Claim Co" });
    await db.insert(salesLeadSubmissions).values([
      {
        formId: FAKE_FORM_ID,
        submissionId: 5,
        claimedAt: new Date(Date.now() - 11 * 60 * 1000),
        claimToken: "crashed-process",
      },
      {
        formId: FAKE_FORM_ID,
        submissionId: 6,
        claimedAt: new Date(),
        claimToken: "busy-process",
      },
    ]);
    expect(await cycle()).toMatchObject({ completed: 1 });
    expect((await submissionRow(5)).status).toBe("completed");
    expect(await submissionRow(6)).toMatchObject({ status: "pending", claimToken: "busy-process" });
  });
});

describe("sales lead automation: logging", () => {
  it("never logs answers, names, emails, phones or folder names", async () => {
    await baseline();
    fake.addSubmission(5, FULL_LEAD);
    fake.addSubmission(6, { ...FULL_LEAD, Temperature: "Scorching" });
    fake.folders.set("DFWSC Sales/Leads/Zephyrine Widgets LLC", 77);
    fake.fail({
      match: (r) => r.method === "PUT" && r.path.includes("/addressbooks/"),
      status: 500,
    });
    await cycle();
    await makeDue(5);
    await makeDue(6);
    await cycle();

    expect(log.lines.length).toBeGreaterThan(3);
    const all = log.lines.map((l) => l.text).join("\n");
    for (const secret of [
      "Zephyrine",
      "Ophelia",
      "Quartermaine",
      "ophelia@zephyrine.example",
      "555",
      "warehouse",
      "Scorching",
      "12,500",
      "app-password-for-tests",
      "DFWSC Sales",
    ]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe("sales lead automation: poller", () => {
  it("runs a cycle as soon as it starts and waits for it on stop", async () => {
    fake.addSubmission(1, FULL_LEAD);
    const poller = startSalesLeadPoller(log.logger, env);
    expect(poller).not.toBeNull();
    await poller?.stop();
    expect(await db.select().from(salesLeadSyncState)).toHaveLength(1);
    expect(log.lines.some((l) => l.text.includes("poller started"))).toBe(true);
    expect(getSalesLeadSyncStats().lastCycleStatus).toBe("ok");
  });
});
