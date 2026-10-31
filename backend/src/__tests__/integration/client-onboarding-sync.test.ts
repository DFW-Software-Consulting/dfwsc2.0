import { and, eq, isNotNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db/client";
import { clientOnboardingSubmissions, clientOnboardingSyncState } from "../../db/schema";
import {
  allocateProjectCode,
  claimNextOnboarding,
  getClientOnboardingStats,
  resetClientOnboardingStateForTests,
  runClientOnboardingCycle,
  startClientOnboarding,
} from "../../lib/client-onboarding-sync";
import { CLIENT_ONBOARDING_MAX_ATTEMPTS } from "../../lib/constants";
import { openNextcloudBreakerForTests, resetNextcloudBreakerForTests } from "../../lib/nextcloud";
import {
  FakeOnboardingNextcloud,
  type IntakeAnswers,
  ONB_COLLECTIVE_PATH,
  ONB_FORM_ID,
  ONB_PROJECTS_PAGE_ID,
  ONB_PROJECTS_TABLE,
  onboardingEnv,
  PIPELINE_COLUMNS,
  PROJECT_COLUMNS,
} from "../helpers/fake-nextcloud-onboarding";

type Logger = Parameters<typeof runClientOnboardingCycle>[0]["logger"];

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

const LEAD_ROW = 301;

const FULL: IntakeAnswers = {
  company: "Zephyrine Widgets LLC",
  contact_name: "Ophelia Quartermaine",
  email: "ophelia@zephyrine.example",
  phone: "+1 214 555 0199",
  project_name: "Warehouse Portal",
  start_date: "2026-11-02",
  target_date: "2027-01-29",
  summary: "Build the warehouse portal MVP",
  lead_link: `https://cloud.test/apps/tables/#/table/8/row/${LEAD_ROW}`,
};

let fake: FakeOnboardingNextcloud;
let log: ReturnType<typeof captureLogger>;
const env = onboardingEnv();

const cycle = (overrideEnv: NodeJS.ProcessEnv = env) =>
  runClientOnboardingCycle({ logger: log.logger, env: overrideEnv });

async function sub(submissionId: number) {
  const [row] = await db
    .select()
    .from(clientOnboardingSubmissions)
    .where(
      and(
        eq(clientOnboardingSubmissions.formId, ONB_FORM_ID),
        eq(clientOnboardingSubmissions.submissionId, submissionId)
      )
    );
  return row;
}

async function baseline() {
  expect((await cycle()).status).toBe("ok");
}

async function makeDue(submissionId: number) {
  await db
    .update(clientOnboardingSubmissions)
    .set({ nextAttemptAt: new Date(Date.now() - 1000) })
    .where(eq(clientOnboardingSubmissions.submissionId, submissionId));
}

const newProjectRows = () => fake.projectRows().filter((r) => r.id >= 1000);

beforeEach(async () => {
  await db.delete(clientOnboardingSubmissions);
  await db.delete(clientOnboardingSyncState);
  resetNextcloudBreakerForTests();
  resetClientOnboardingStateForTests();
  fake = new FakeOnboardingNextcloud();
  fake.addLead(LEAD_ROW, "Zephyrine Widgets LLC");
  log = captureLogger();
  vi.stubGlobal("fetch", vi.fn(fake.fetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetNextcloudBreakerForTests();
  resetClientOnboardingStateForTests();
});

describe("client onboarding: flag and config", () => {
  it("does nothing, and calls no Nextcloud API, when the flag is off", async () => {
    const off = onboardingEnv({ CLIENT_ONBOARDING_ENABLED: undefined });
    expect((await cycle(off)).status).toBe("disabled");
    expect(startClientOnboarding(log.logger, off)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(log.lines).toHaveLength(0);
  });

  it("logs an invalid config once and never calls Nextcloud", async () => {
    const bad = onboardingEnv({ CLIENT_ONBOARDING_PROJECTS_TABLE_ID: "six" });
    expect((await cycle(bad)).status).toBe("invalid_config");
    expect((await cycle(bad)).status).toBe("invalid_config");
    expect(fetch).not.toHaveBeenCalled();
    const errors = log.lines.filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].text).toContain("CLIENT_ONBOARDING_PROJECTS_TABLE_ID");
  });

  it("refuses a short webhook secret and does not start", () => {
    const short = onboardingEnv({ CLIENT_ONBOARDING_WEBHOOK_SECRET: "short" });
    expect(startClientOnboarding(log.logger, short)).toBeNull();
    expect(log.lines[0].text).toContain("CLIENT_ONBOARDING_WEBHOOK_SECRET");
    expect(log.lines[0].text).not.toContain('short"');
  });

  it("stops on a missing form question, releases the claim and logs once", async () => {
    await baseline();
    fake.questions = fake.questions.filter((q) => q.name !== "project_name");
    fake.addSubmission(1, FULL);
    expect((await cycle()).status).toBe("config_error");
    expect((await cycle()).status).toBe("config_error");
    expect(await sub(1)).toMatchObject({ status: "pending", attempts: 0, claimToken: null });
    expect(fake.writes()).toHaveLength(0);
    const errors = log.lines.filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].text).toContain("project_name");
  });

  it("stops when the Projects page is missing from the collective", async () => {
    await baseline();
    fake.pages = fake.pages.filter((p) => p.id !== ONB_PROJECTS_PAGE_ID);
    fake.addSubmission(1, FULL);
    expect((await cycle()).status).toBe("config_error");
    expect(fake.writes()).toHaveLength(0);
  });
});

describe("client onboarding: baseline", () => {
  it("never processes submissions that existed before the first cycle", async () => {
    fake.addSubmission(3, FULL);
    expect(await cycle()).toMatchObject({ status: "ok", discovered: 0 });
    const [state] = await db.select().from(clientOnboardingSyncState);
    expect(state).toMatchObject({ formId: ONB_FORM_ID, baselineSubmissionId: 3 });
    expect(await cycle()).toMatchObject({ discovered: 0 });
    expect(fake.writes()).toHaveLength(0);
  });
});

describe("client onboarding: steps", () => {
  it("runs every step for a full submission", async () => {
    await baseline();
    fake.addSubmission(5, FULL);
    expect(await cycle()).toMatchObject({ status: "ok", discovered: 1, completed: 1 });
    const done = await sub(5);

    // 1. Client folder with the CP-001 layout.
    const folder = "clients/Zephyrine Widgets LLC";
    for (const path of [
      folder,
      `${folder}/Meetings`,
      `${folder}/Decisions`,
      `${folder}/Deliverables`,
    ]) {
      expect(fake.folders.has(path)).toBe(true);
    }
    expect(done.folderFileId).toBe(fake.folders.get(folder));

    // 2. Contact card, ORG = company, only the given fields.
    const card = fake.cards.get("dfwsc-client-2-5.vcf")?.data ?? "";
    expect(card).toContain("ORG:Zephyrine Widgets LLC");
    expect(card).toContain("FN:Ophelia Quartermaine");
    expect(card).toContain("EMAIL;TYPE=WORK:ophelia@zephyrine.example");
    expect(card).toContain("TEL;TYPE=WORK:+1 214 555 0199");
    expect(done).toMatchObject({ contactStatus: "created", contactUid: "dfwsc-client-2-5" });

    // 3. Projects row: next code after CP-001 / CP-002, Intake, owner, dates, summary.
    const [row] = newProjectRows();
    const cell = (title: keyof typeof PROJECT_COLUMNS) =>
      fake.rowCell(row.id, PROJECT_COLUMNS[title]);
    expect(cell("Project Code")).toBe("CP-003");
    expect(cell("Project Name")).toBe("Warehouse Portal");
    expect(cell("Status")).toBe(0);
    expect(cell("Owner")).toEqual([{ id: "messyginger0804", type: 0 }]);
    expect(cell("Start Date")).toBe("2026-11-02");
    expect(cell("Target Date")).toBe("2027-01-29");
    expect(cell("Summary")).toBe("Build the warehouse portal MVP");
    expect(done).toMatchObject({ projectCode: "CP-003", projectNumber: 3, tableRowId: row.id });
    // No contact details on the project row.
    const create = fake.requests.find((r) => r.method === "POST" && r.path.endsWith("/rows"));
    expect(create?.body).not.toContain("ophelia");

    // 4. Collectives page under Projects, with links.
    const page = fake.pages.find((p) => p.title === "CP-003 — Warehouse Portal");
    expect(page?.parentId).toBe(ONB_PROJECTS_PAGE_ID);
    expect(done.pageUrl).toBe(
      `https://cloud.test/index.php/apps/collectives/Cerebo-Pilot-1/CP-003-Warehouse-Portal-${page?.id}`
    );
    const content = fake.files.get(`${ONB_COLLECTIVE_PATH}/Projects/CP-003 — Warehouse Portal.md`);
    expect(content).toContain(`(https://cloud.test/index.php/apps/tables/#/table/6/row/${row.id})`);
    expect(content).toContain(`(https://cloud.test/index.php/f/${done.folderFileId})`);

    // Links on the row, written as "Title (url)" and stored as Tables' JSON.
    expect(fake.linkUrl(row.id, PROJECT_COLUMNS["Project Folder"])).toBe(
      `https://cloud.test/index.php/f/${done.folderFileId}`
    );
    expect(fake.linkUrl(row.id, PROJECT_COLUMNS["Project Page"])).toBe(done.pageUrl);
    expect(fake.linkUrl(row.id, PROJECT_COLUMNS["Intake Submission"])).toBe(
      "https://cloud.test/index.php/apps/forms/9KaxpC5GXeGoWY44/results"
    );
    expect(
      JSON.parse(fake.rowCell(row.id, PROJECT_COLUMNS["Intake Submission"]) as string).title
    ).toBe("Intake submission #5");

    // 5. Sales Pipeline lead set to Won with the project link.
    expect(fake.rowCell(LEAD_ROW, PIPELINE_COLUMNS.Stage)).toBe(4);
    expect(fake.linkUrl(LEAD_ROW, PIPELINE_COLUMNS["Cerebo Project"])).toBe(
      `https://cloud.test/index.php/apps/tables/#/table/6/row/${row.id}`
    );
    expect(done).toMatchObject({
      status: "completed",
      leadStatus: "won",
      leadRowId: LEAD_ROW,
      claimToken: null,
      lastErrorCode: null,
    });
    expect(done.linksBackfilledAt).toBeInstanceOf(Date);
    expect(done.pageContentAt).toBeInstanceOf(Date);
  });

  it("is idempotent: later cycles make no further writes", async () => {
    await baseline();
    fake.addSubmission(5, FULL);
    await cycle();
    const before = fake.writes().length;
    for (let i = 0; i < 3; i++) await cycle();
    expect(fake.writes()).toHaveLength(before);
    expect(newProjectRows()).toHaveLength(1);
  });

  it("puts only the given fields on a new card and leaves Owner empty for anonymous submitters", async () => {
    await baseline();
    fake.addSubmission(
      5,
      { company: "Faceless Corp", project_name: "Ops", summary: "Ops work" },
      "anon-user-4f1a"
    );
    await cycle();
    const card = fake.cards.get("dfwsc-client-2-5.vcf")?.data ?? "";
    expect(card).toContain("ORG:Faceless Corp");
    expect(card).toContain("FN:Faceless Corp");
    expect(card).not.toContain("EMAIL");
    expect(card).not.toContain("TEL");
    const [row] = newProjectRows();
    expect(fake.rowCell(row.id, PROJECT_COLUMNS.Owner)).toBeUndefined();
    expect(fake.rowCell(row.id, PROJECT_COLUMNS["Start Date"])).toBeUndefined();
  });

  it("updates the existing card with the same email instead of adding one", async () => {
    await baseline();
    fake.addCard(
      "dfwsc-lead-4-9.vcf",
      "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:dfwsc-lead-4-9\r\nFN:Ophelia Quartermaine\r\nN:Quartermaine;Ophelia;;;\r\nORG:Zephyrine\r\nEMAIL;TYPE=WORK:Ophelia@Zephyrine.example\r\nCATEGORIES:Lead\r\nEND:VCARD\r\n"
    );
    fake.addSubmission(5, FULL);
    await cycle();
    expect(fake.cards.size).toBe(1);
    const card = fake.cards.get("dfwsc-lead-4-9.vcf")?.data ?? "";
    // Someone else's card: its company is kept, only missing details are added.
    expect(card).toContain("ORG:Zephyrine\r\n");
    expect(card).not.toContain("Zephyrine Widgets LLC");
    expect(card).toContain("TEL;TYPE=WORK:+1 214 555 0199");
    expect(card).toContain("CATEGORIES:Lead,Client");
    expect(card.match(/EMAIL/g)).toHaveLength(1);
    expect(
      fake.requests.find((r) => r.method === "PUT" && r.path.includes("dfwsc-lead-4-9"))?.headers[
        "if-match"
      ]
    ).toBe('"1"');
    expect(await sub(5)).toMatchObject({ contactStatus: "updated", contactUid: "dfwsc-lead-4-9" });
  });

  it("leaves contacts alone when several cards match", async () => {
    await baseline();
    const card = (uid: string) =>
      `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nFN:X\r\nEMAIL:ophelia@zephyrine.example\r\nEND:VCARD\r\n`;
    fake.addCard("a.vcf", card("a"));
    fake.addCard("b.vcf", card("b"));
    fake.addSubmission(5, FULL);
    expect(await cycle()).toMatchObject({ completed: 1 });
    expect(fake.count("PUT", "/addressbooks/")).toBe(0);
    expect(await sub(5)).toMatchObject({
      status: "completed",
      contactStatus: "ambiguous",
      contactUid: null,
    });
  });

  describe("contact matching across address books", () => {
    const STRIPE_CARD =
      "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:stripe-cus_X\r\nFN:Ophelia Quartermaine\r\nORG:Zephyrine Widgets LLC\r\nEMAIL:ophelia@zephyrine.example\r\nEND:VCARD\r\n";

    it("merges a card from another address book in place and creates nothing", async () => {
      await baseline();
      fake.addBook("contacts");
      fake.addCardTo("contacts", "stripe-cus_X.vcf", STRIPE_CARD);
      fake.addSubmission(5, FULL);
      await cycle();
      expect(fake.cards.size).toBe(0);
      const merged = fake.otherBooks.get("contacts")?.cards.get("stripe-cus_X.vcf")?.data ?? "";
      expect(merged).toContain("TEL;TYPE=WORK:+1 214 555 0199");
      expect(fake.otherBooks.get("contacts")?.cards.size).toBe(1);
      expect(await sub(5)).toMatchObject({ contactStatus: "updated", contactUid: "stripe-cus_X" });
      expect(log.lines.some((l) => l.text.includes('"addressbook":"contacts"'))).toBe(true);
    });

    it("skips system address books", async () => {
      await baseline();
      await cycle();
      fake.addSubmission(5, FULL);
      await cycle();
      expect(fake.requests.some((r) => r.path.includes("z-server-generated"))).toBe(false);
    });

    it("flags matches in two address books as ambiguous and writes nothing", async () => {
      await baseline();
      fake.addBook("contacts");
      fake.addCardTo("contacts", "stripe-cus_X.vcf", STRIPE_CARD);
      fake.addCard("a.vcf", STRIPE_CARD.replace("stripe-cus_X", "a"));
      fake.addSubmission(5, FULL);
      expect(await cycle()).toMatchObject({ completed: 1 });
      expect(fake.count("PUT", "/addressbooks/")).toBe(0);
      expect(await sub(5)).toMatchObject({ contactStatus: "ambiguous", contactUid: null });
    });

    it("does not create a duplicate when the matching book is read-only", async () => {
      await baseline();
      fake.addBook("contacts", true);
      fake.addCardTo("contacts", "stripe-cus_X.vcf", STRIPE_CARD);
      fake.addSubmission(5, FULL);
      expect(await cycle()).toMatchObject({ completed: 1 });
      expect(fake.cards.size).toBe(0);
      // Known read-only from the privilege set, so no write is even attempted.
      expect(fake.count("PUT", "/addressbooks/")).toBe(0);
      expect(await sub(5)).toMatchObject({
        status: "completed",
        contactStatus: "read_only",
        contactUid: "stripe-cus_X",
      });
      expect(
        log.lines.some((l) => l.text.includes("read-only") && l.text.includes("contacts"))
      ).toBe(true);
    });

    it("retries and creates nothing when the address books cannot be listed", async () => {
      await baseline();
      fake.addSubmission(5, FULL);
      fake.fail({
        match: (r) => r.method === "PROPFIND" && r.path.includes("/addressbooks/"),
        status: 403,
      });
      expect(await cycle()).toMatchObject({ retried: 1 });
      expect(fake.count("PUT", "/addressbooks/")).toBe(0);
      expect(await sub(5)).toMatchObject({
        status: "pending",
        lastErrorCode: "carddav.discovery_failed",
        contactStatus: null,
      });
    });

    it("retries when another address book cannot be read", async () => {
      await baseline();
      fake.addBook("contacts");
      fake.addSubmission(5, FULL);
      fake.fail({
        match: (r) => r.method === "REPORT" && r.path.includes("/contacts/"),
        status: 500,
      });
      expect(await cycle()).toMatchObject({ retried: 1 });
      expect(fake.count("PUT", "/addressbooks/")).toBe(0);
      expect(await sub(5)).toMatchObject({ lastErrorCode: "carddav.discovery_failed" });
    });

    it("counts its own earlier card as ours on a retry, not as an ambiguity", async () => {
      await baseline();
      fake.addBook("contacts");
      fake.addCardTo("contacts", "stripe-cus_X.vcf", STRIPE_CARD);
      // Created by an earlier attempt whose result was never saved.
      fake.addCard("dfwsc-client-2-5.vcf", STRIPE_CARD.replace("stripe-cus_X", "dfwsc-client-2-5"));
      fake.addSubmission(5, FULL);
      await cycle();
      expect(fake.count("PUT", "/addressbooks/")).toBe(0);
      expect(await sub(5)).toMatchObject({
        contactStatus: "created",
        contactUid: "dfwsc-client-2-5",
      });
    });

    it("falls back to the 403 when a read-only book does not advertise its privileges", async () => {
      await baseline();
      fake.addBook("contacts", true, false);
      fake.addCardTo("contacts", "stripe-cus_X.vcf", STRIPE_CARD);
      fake.addSubmission(5, FULL);
      expect(await cycle()).toMatchObject({ completed: 1 });
      expect(fake.cards.size).toBe(0);
      expect(fake.count("PUT", "/addressbooks/")).toBe(1);
      expect(await sub(5)).toMatchObject({ contactStatus: "read_only" });
    });

    it("skips an address book it cannot read and still creates in the configured one", async () => {
      await baseline();
      fake.addBook("revoked");
      fake.fail({
        match: (r) => r.method === "REPORT" && r.path.includes("/revoked/"),
        status: 403,
      });
      fake.addSubmission(5, FULL);
      expect(await cycle()).toMatchObject({ completed: 1 });
      expect(fake.cards.has("dfwsc-client-2-5.vcf")).toBe(true);
      expect(
        log.lines.some((l) => l.level === "warn" && l.text.includes('"addressbook":"revoked"'))
      ).toBe(true);
    });

    it("never overwrites the name or company of a card matched only by email", async () => {
      await baseline();
      fake.addBook("contacts");
      fake.addCardTo(
        "contacts",
        "shared.vcf",
        "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:shared\r\nFN:Front Desk\r\nN:Desk;Front;;;\r\nORG:Another Company\r\nEMAIL:ophelia@zephyrine.example\r\nEND:VCARD\r\n"
      );
      fake.addSubmission(5, FULL);
      await cycle();
      const card = fake.otherBooks.get("contacts")?.cards.get("shared.vcf")?.data ?? "";
      expect(card).toContain("FN:Front Desk");
      expect(card).toContain("ORG:Another Company");
      expect(card).toContain("TEL;TYPE=WORK:+1 214 555 0199");
      expect(fake.cards.size).toBe(0);
    });

    it("lists the address books once per cycle and sees cards created earlier in it", async () => {
      await baseline();
      for (const id of [5, 6]) {
        fake.addSubmission(id, { ...FULL, project_name: `P${id}`, lead_link: undefined });
      }
      expect(await cycle()).toMatchObject({ completed: 2 });
      // Same email twice: the second submission merges into the first one's card.
      expect(fake.cards.size).toBe(1);
      expect(fake.count("PROPFIND", "/addressbooks/")).toBe(1);
      expect(await sub(5)).toMatchObject({ contactStatus: "created" });
      expect(await sub(6)).toMatchObject({
        contactStatus: "updated",
        contactUid: "dfwsc-client-2-5",
      });
    });

    it("creates in the configured address book when no book has a match", async () => {
      await baseline();
      fake.addBook("contacts");
      fake.addCardTo(
        "contacts",
        "other.vcf",
        "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:other\r\nFN:Someone Else\r\nORG:Elsewhere Inc\r\nEMAIL:else@elsewhere.example\r\nEND:VCARD\r\n"
      );
      fake.addSubmission(5, FULL);
      await cycle();
      expect(fake.cards.has("dfwsc-client-2-5.vcf")).toBe(true);
      expect(fake.otherBooks.get("contacts")?.cards.size).toBe(1);
      expect(await sub(5)).toMatchObject({
        contactStatus: "created",
        contactUid: "dfwsc-client-2-5",
      });
    });
  });

  it("reuses a returning client's folder", async () => {
    await baseline();
    fake.folders.set("clients/Zephyrine Widgets LLC", 42);
    fake.addSubmission(5, FULL);
    await cycle();
    expect((await sub(5)).folderFileId).toBe(42);
    expect(fake.folders.has("clients/Zephyrine Widgets LLC/Meetings")).toBe(true);
  });

  it("still completes when the collective is not mounted in the service account's files", async () => {
    await baseline();
    fake.collectiveMounted = false;
    fake.addSubmission(5, FULL);
    expect(await cycle()).toMatchObject({ completed: 1 });
    expect(fake.count("PUT", "/files/")).toBe(0);
    expect(log.lines.some((l) => l.text.includes("page content skipped"))).toBe(true);
  });

  describe("project brief", () => {
    const PAGE_FILE = `${ONB_COLLECTIVE_PATH}/Projects/CP-003 — Warehouse Portal.md`;
    const pageWrites = () =>
      fake.requests.filter((r) => r.method === "PUT" && r.path.endsWith(".md"));

    it("writes the Project Brief with the submitted values", async () => {
      await baseline();
      fake.addSubmission(5, FULL);
      await cycle();
      const content = fake.files.get(PAGE_FILE) ?? "";
      expect(content.startsWith("# Project Brief\n")).toBe(true);
      expect(content).toContain("| Project code | CP-003 |");
      expect(content).toContain("| Purpose | Build the warehouse portal MVP |");
      expect(content).toContain("| Target date | 2027-01-29 |");
      expect(content).toContain("| Owner | |");
      expect(content).toContain("| Intake results | [Intake submission \\#5]");
      expect(content).not.toContain("ophelia");
      expect(pageWrites()[0].headers["if-match"]).toBeTruthy();
    });

    it("does not overwrite an existing body", async () => {
      await baseline();
      fake.addSubmission(5, FULL);
      fake.fail({
        match: (r) => r.method === "POST" && r.path.includes("/collectives/"),
        timeout: true,
        afterApply: true,
      });
      await cycle();
      fake.editFile(PAGE_FILE, "Human notes");
      await makeDue(5);
      expect(await cycle()).toMatchObject({ completed: 1 });
      expect(fake.files.get(PAGE_FILE)).toBe("Human notes");
      expect(pageWrites()).toHaveLength(0);
      expect((await sub(5)).pageContentAt).toBeInstanceOf(Date);
    });

    const warned = (text: string) =>
      log.lines.some((l) => l.level === "warn" && l.text.includes(text));

    it("treats a real If-Match race (file changed between GET and PUT) as skip and done", async () => {
      await baseline();
      fake.addSubmission(5, FULL);
      fake.beforePut = (rel) => fake.editFile(rel, "Edited just now");
      expect(await cycle()).toMatchObject({ completed: 1 });
      expect(fake.files.get(PAGE_FILE)).toBe("Edited just now");
      expect((await sub(5)).pageContentAt).toBeInstanceOf(Date);
      expect(warned("brief skipped")).toBe(true);
    });

    it("writes into a whitespace-only body", async () => {
      await baseline();
      fake.addSubmission(5, FULL);
      fake.seedPageFile = "  \n\n ";
      await cycle();
      expect(fake.files.get(PAGE_FILE)).toContain("# Project Brief");
    });

    it("writes over a title-only seed", async () => {
      await baseline();
      fake.addSubmission(5, FULL);
      fake.seedPageFile = "# CP-003 — Warehouse Portal\n";
      await cycle();
      expect(fake.files.get(PAGE_FILE)).toContain("# Project Brief");
    });

    it("skips a human-edited body", async () => {
      await baseline();
      fake.addSubmission(5, FULL);
      fake.seedPageFile = "# CP-003 — Warehouse Portal\n\nOur notes";
      await cycle();
      expect(fake.files.get(PAGE_FILE)).toBe("# CP-003 — Warehouse Portal\n\nOur notes");
      expect(pageWrites()).toHaveLength(0);
    });

    it("skips with a warning when the page file is missing (404)", async () => {
      await baseline();
      fake.addSubmission(5, FULL);
      fake.seedPageFile = null;
      expect(await cycle()).toMatchObject({ completed: 1 });
      expect(pageWrites()).toHaveLength(0);
      expect(warned("file not found")).toBe(true);
      expect((await sub(5)).pageContentAt).toBeInstanceOf(Date);
    });

    it("strips W/ from a weak ETag before If-Match and the write succeeds", async () => {
      await baseline();
      fake.addSubmission(5, FULL);
      fake.etagMode = "weak";
      await cycle();
      expect(pageWrites()[0].headers["if-match"]).toBe('"f0"');
      expect(fake.files.get(PAGE_FILE)).toContain("# Project Brief");
    });

    it("writes without If-Match and warns when there is no ETag", async () => {
      await baseline();
      fake.addSubmission(5, FULL);
      fake.etagMode = "none";
      await cycle();
      expect(pageWrites()[0].headers["if-match"]).toBeUndefined();
      expect(fake.files.get(PAGE_FILE)).toContain("# Project Brief");
      expect(warned("no ETag")).toBe(true);
    });

    it("resumes after a failed write without redoing earlier steps", async () => {
      await baseline();
      fake.addSubmission(5, FULL);
      fake.fail({ match: (r) => r.method === "PUT" && r.path.endsWith(".md"), status: 503 });
      expect(await cycle()).toMatchObject({ retried: 1 });
      const failed = await sub(5);
      expect(failed).toMatchObject({ lastErrorCode: "webdav.put_page:503", pageContentAt: null });
      expect(failed.pageId).not.toBeNull();
      await makeDue(5);
      expect(await cycle()).toMatchObject({ completed: 1 });
      expect(fake.files.get(PAGE_FILE)).toContain("# Project Brief");
      expect(fake.count("POST", "/collectives/")).toBe(1);
    });

    it("re-checks after a lost write response and does not write twice", async () => {
      await baseline();
      fake.addSubmission(5, FULL);
      fake.fail({
        match: (r) => r.method === "PUT" && r.path.endsWith(".md"),
        timeout: true,
        afterApply: true,
      });
      expect(await cycle()).toMatchObject({ retried: 1 });
      await makeDue(5);
      expect(await cycle()).toMatchObject({ completed: 1 });
      expect(pageWrites()).toHaveLength(1);
      expect(fake.files.get(PAGE_FILE)).toContain("# Project Brief");
    });

    it("a second cycle makes no further page requests", async () => {
      await baseline();
      fake.addSubmission(5, FULL);
      await cycle();
      const before = fake.files.get(PAGE_FILE);
      const requests = fake.requests.length;
      await cycle();
      expect(fake.files.get(PAGE_FILE)).toBe(before);
      expect(fake.requests.slice(requests).filter((r) => r.path.endsWith(".md"))).toHaveLength(0);
    });
  });
});

describe("client onboarding: Sales Pipeline lead", () => {
  const stage = () => fake.rowCell(LEAD_ROW, PIPELINE_COLUMNS.Stage);
  const pipelineWrites = () =>
    fake.requests.filter((r) => r.method === "PUT" && /\/rows\/(301|302|303)$/.test(r.path));

  it("matches a view link to the row", async () => {
    await baseline();
    fake.addSubmission(5, {
      ...FULL,
      lead_link: `https://cloud.test/apps/tables/#/view/3/row/${LEAD_ROW}`,
    });
    await cycle();
    expect(stage()).toBe(4);
    expect((await sub(5)).leadStatus).toBe("won");
  });

  it("falls back to an exact company match, ignoring case and spacing", async () => {
    await baseline();
    fake.addSubmission(5, { ...FULL, lead_link: undefined, company: "zephyrine  widgets llc" });
    await cycle();
    expect(stage()).toBe(4);
    expect(await sub(5)).toMatchObject({ leadStatus: "won", leadRowId: LEAD_ROW });
  });

  it("matches lead_link given as a company name", async () => {
    await baseline();
    fake.addSubmission(5, { ...FULL, company: "ZW Holdings", lead_link: "Zephyrine Widgets LLC" });
    await cycle();
    expect(stage()).toBe(4);
  });

  it("flags no match without touching the pipeline", async () => {
    await baseline();
    fake.addSubmission(5, { ...FULL, lead_link: "Nobody Inc" });
    expect(await cycle()).toMatchObject({ completed: 1, failed: 0 });
    expect(await sub(5)).toMatchObject({
      status: "completed",
      leadStatus: "no_match",
      leadRowId: null,
    });
    expect(pipelineWrites()).toHaveLength(0);
    expect(stage()).toBe(0);
  });

  it("flags a link to a missing row or another table as no match", async () => {
    await baseline();
    fake.addSubmission(5, {
      ...FULL,
      lead_link: "https://cloud.test/apps/tables/#/table/8/row/999",
    });
    fake.addSubmission(6, {
      ...FULL,
      lead_link: "https://cloud.test/apps/tables/#/table/6/row/27",
    });
    await cycle();
    expect((await sub(5)).leadStatus).toBe("no_match");
    expect((await sub(6)).leadStatus).toBe("no_match");
    expect(pipelineWrites()).toHaveLength(0);
  });

  it("flags several matching companies as ambiguous and changes none", async () => {
    await baseline();
    fake.addLead(302, "Zephyrine Widgets LLC");
    fake.addSubmission(5, { ...FULL, lead_link: undefined });
    await cycle();
    expect(await sub(5)).toMatchObject({ status: "completed", leadStatus: "ambiguous" });
    expect(pipelineWrites()).toHaveLength(0);
    const warn = log.lines.find((l) => l.text.includes("needs an operator"));
    expect(warn?.text).toContain('"matches":2');
  });

  it("does not overwrite a lead already linked to another project", async () => {
    await baseline();
    fake.rows = fake.rows.filter((r) => r.id !== LEAD_ROW);
    fake.addLead(LEAD_ROW, "Zephyrine Widgets LLC", {
      57: '{"title":"CP-001","value":"https:\\/\\/cloud.test\\/index.php\\/apps\\/tables\\/#\\/table\\/6\\/row\\/27","providerId":"url"}',
    });
    fake.addSubmission(5, FULL);
    await cycle();
    expect(await sub(5)).toMatchObject({ leadStatus: "already_linked", leadRowId: LEAD_ROW });
    expect(pipelineWrites()).toHaveLength(0);
  });

  const leadAt = (stageCell: unknown) => {
    fake.rows = fake.rows.filter((r) => r.id !== LEAD_ROW);
    fake.addLead(LEAD_ROW, "Zephyrine Widgets LLC", { 49: stageCell });
  };

  it.each([
    [0, "New Lead"],
    [2, "Qualified"],
    [3, "Proposal Sent"],
    [6, "Nurture"],
  ])("promotes a lead in the open stage %i (%s) to Won", async (stageId) => {
    await baseline();
    leadAt(stageId);
    fake.addSubmission(5, FULL);
    await cycle();
    expect(stage()).toBe(4);
    expect(await sub(5)).toMatchObject({ status: "completed", leadStatus: "won" });
    expect(fake.linkUrl(LEAD_ROW, 57)).toContain("/table/6/row/");
  });

  it("leaves a Won lead's stage alone and still links the project", async () => {
    await baseline();
    leadAt(4);
    fake.addSubmission(5, FULL);
    await cycle();
    expect(stage()).toBe(4);
    expect(await sub(5)).toMatchObject({ status: "completed", leadStatus: "won" });
    expect(fake.linkUrl(LEAD_ROW, 57)).toContain("/table/6/row/");
    expect(fake.requests.some((r) => r.body.includes('"49"'))).toBe(false);
  });

  it.each([
    ["Lost", 5],
    ["empty", null],
    ["unknown", 99],
  ])("flags a lead in a %s stage and leaves its row untouched", async (_name, stageCell) => {
    await baseline();
    leadAt(stageCell);
    fake.addSubmission(5, FULL);
    await cycle();
    expect(await sub(5)).toMatchObject({
      status: "completed",
      leadStatus: "ambiguous",
      leadRowId: LEAD_ROW,
    });
    expect(stage()).toBe(stageCell);
    expect(fake.linkUrl(LEAD_ROW, 57)).toBeUndefined();
    expect(pipelineWrites()).toHaveLength(0);
    expect(log.lines.some((l) => l.text.includes("lead_stage_not_promotable"))).toBe(true);
    // The rest of the onboarding still completed.
    expect(newProjectRows()).toHaveLength(1);
  });
});

describe("client onboarding: resume after a failure", () => {
  it("resumes at the failed step without repeating the ones that succeeded", async () => {
    await baseline();
    fake.addSubmission(5, FULL);
    fake.fail({
      match: (r) => r.method === "PUT" && r.path.includes("/addressbooks/"),
      status: 500,
    });

    expect(await cycle()).toMatchObject({ retried: 1 });
    const failed = await sub(5);
    expect(failed).toMatchObject({
      status: "pending",
      attempts: 1,
      lastErrorCode: "carddav.create_contact:500",
      contactStatus: null,
      projectCode: null,
      claimToken: null,
    });
    expect(failed.folderFileId).not.toBeNull();
    const mkcols = fake.count("MKCOL", "/files/");

    await makeDue(5);
    expect(await cycle()).toMatchObject({ completed: 1 });
    // The folder step is not repeated; the card is.
    expect(fake.count("MKCOL", "/files/")).toBe(mkcols);
    expect(fake.count("PUT", "/addressbooks/")).toBe(2);
    expect(newProjectRows()).toHaveLength(1);
  });

  it("adopts the project row when the create response was lost, keeping its code", async () => {
    await baseline();
    fake.addSubmission(5, FULL);
    fake.fail({
      match: (r) => r.method === "POST" && r.path.endsWith("/tables/6/rows"),
      timeout: true,
      afterApply: true,
    });
    expect(await cycle()).toMatchObject({ retried: 1 });
    expect(await sub(5)).toMatchObject({
      projectCode: "CP-003",
      tableRowId: null,
      lastErrorCode: "tables.create_row:timeout",
    });

    await makeDue(5);
    expect(await cycle()).toMatchObject({ completed: 1 });
    expect(newProjectRows()).toHaveLength(1);
    expect(fake.count("POST", "/tables/6/rows")).toBe(1);
    expect(await sub(5)).toMatchObject({
      projectCode: "CP-003",
      tableRowId: newProjectRows()[0].id,
    });
  });

  it("adopts the page when its create response was lost", async () => {
    await baseline();
    fake.addSubmission(5, FULL);
    fake.fail({
      match: (r) => r.method === "POST" && r.path.includes("/collectives/"),
      timeout: true,
      afterApply: true,
    });
    expect(await cycle()).toMatchObject({ retried: 1 });
    await makeDue(5);
    expect(await cycle()).toMatchObject({ completed: 1 });
    expect(fake.pages.filter((p) => p.title.startsWith("CP-003"))).toHaveLength(1);
    expect(fake.count("POST", "/collectives/")).toBe(1);
  });

  it("retries the links when Tables answers 200 but stores nothing", async () => {
    await baseline();
    fake.addSubmission(5, FULL);
    fake.droppedRowUpdates = 1;
    expect(await cycle()).toMatchObject({ retried: 1 });
    expect(await sub(5)).toMatchObject({
      lastErrorCode: "tables.link_not_persisted",
      linksBackfilledAt: null,
      leadStatus: null,
    });
    await makeDue(5);
    expect(await cycle()).toMatchObject({ completed: 1 });
    expect(fake.linkUrl(newProjectRows()[0].id, PROJECT_COLUMNS["Project Folder"])).toBeDefined();
  });

  it("retries the lead update without redoing the project", async () => {
    await baseline();
    fake.addSubmission(5, FULL);
    fake.fail({
      match: (r) => r.method === "PUT" && r.path.endsWith(`/rows/${LEAD_ROW}`),
      status: 503,
    });
    expect(await cycle()).toMatchObject({ retried: 1 });
    expect(await sub(5)).toMatchObject({
      lastErrorCode: "tables.update_row:503",
      leadStatus: null,
    });
    const writes = fake.writes().length;
    await makeDue(5);
    expect(await cycle()).toMatchObject({ completed: 1 });
    // Only the lead PUT is repeated.
    expect(fake.writes().length - writes).toBe(1);
    expect(fake.rowCell(LEAD_ROW, PIPELINE_COLUMNS.Stage)).toBe(4);
  });

  it("never reuses a code, even after its submission failed for good", async () => {
    await baseline();
    fake.addSubmission(5, FULL);
    fake.fail({
      match: (r) => r.method === "POST" && r.path.endsWith("/tables/6/rows"),
      status: 403,
    });
    expect(await cycle()).toMatchObject({ failed: 1 });
    expect(await sub(5)).toMatchObject({ status: "failed", projectCode: "CP-003" });

    fake.addSubmission(6, { ...FULL, project_name: "Second" });
    await cycle();
    expect(await sub(6)).toMatchObject({ status: "completed", projectCode: "CP-004" });
  });

  const handMade = (id: number, code: string) =>
    fake.rows.push({
      id,
      tableId: ONB_PROJECTS_TABLE,
      data: new Map<number, unknown>([
        [26, code],
        [27, "Hand Made"],
      ]),
    });

  it("allocates a fresh code when someone else's row took the allocated one, and never reuses the burned one", async () => {
    await baseline();
    fake.addSubmission(5, FULL);
    fake.fail({
      match: (r) => r.method === "POST" && r.path.endsWith("/tables/6/rows"),
      status: 503,
    });
    await cycle();
    expect(await sub(5)).toMatchObject({ status: "pending", projectCode: "CP-003" });
    // Meanwhile CP-003 is typed in by hand for another project.
    handMade(77, "CP-003");
    await makeDue(5);
    expect(await cycle()).toMatchObject({ retried: 1, failed: 0 });
    expect(await sub(5)).toMatchObject({ status: "pending", projectCode: "CP-004" });
    expect(newProjectRows()).toHaveLength(0);
    await makeDue(5);
    expect(await cycle()).toMatchObject({ completed: 1, failed: 0 });
    expect(await sub(5)).toMatchObject({ status: "completed", projectCode: "CP-004" });
    expect(newProjectRows()).toHaveLength(1);
    expect(newProjectRows()[0].data.get(26)).toBe("CP-004");
    expect(fake.row(77)?.data.get(27)).toBe("Hand Made");

    fake.addSubmission(6, { ...FULL, project_name: "Second" });
    await cycle();
    expect(await sub(6)).toMatchObject({ status: "completed", projectCode: "CP-005" });
  });

  it("gives up with project_code_taken when the allocated code keeps being taken", async () => {
    await baseline();
    fake.addSubmission(5, FULL);
    fake.fail({
      match: (r) => r.method === "POST" && r.path.endsWith("/tables/6/rows"),
      status: 503,
      times: 100,
    });
    // Before every listing of the Projects table, someone types in the code the
    // submission currently holds.
    const inner = fake.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET" && /\/tables\/6\/rows\?/.test(String(input))) {
          const held = (await sub(5))?.projectCode;
          if (held && !fake.projectRows().some((r) => r.data.get(26) === held)) {
            handMade(800 + fake.rows.length, held);
          }
        }
        return inner(input, init);
      })
    );
    for (let i = 0; i < CLIENT_ONBOARDING_MAX_ATTEMPTS + 1; i++) {
      await makeDue(5);
      await cycle();
    }
    const final = await sub(5);
    expect(final).toMatchObject({
      status: "failed",
      lastErrorCode: "project_code_taken",
      attempts: CLIENT_ONBOARDING_MAX_ATTEMPTS,
    });
    expect(newProjectRows()).toHaveLength(0);
    // The held code is never one that is already in the table.
    const codes = fake.projectRows().map((r) => r.data.get(26));
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("fails permanently, with no writes, when a required answer is missing", async () => {
    await baseline();
    fake.addSubmission(5, { company: "Acme", project_name: "X" });
    expect(await cycle()).toMatchObject({ failed: 1 });
    expect(await sub(5)).toMatchObject({ status: "failed", lastErrorCode: "missing_summary" });
    expect(fake.writes()).toHaveLength(0);
  });

  it("gives up after the maximum number of attempts", async () => {
    await baseline();
    fake.addSubmission(5, FULL);
    await db.insert(clientOnboardingSubmissions).values({
      formId: ONB_FORM_ID,
      submissionId: 5,
      attempts: CLIENT_ONBOARDING_MAX_ATTEMPTS - 1,
    });
    fake.fail({ match: (r) => r.method === "MKCOL", status: 502 });
    expect(await cycle()).toMatchObject({ failed: 1 });
    expect(await sub(5)).toMatchObject({
      status: "failed",
      attempts: CLIENT_ONBOARDING_MAX_ATTEMPTS,
    });
  });

  it("uses no attempt when the Nextcloud circuit is open", async () => {
    await baseline();
    await db.insert(clientOnboardingSubmissions).values({ formId: ONB_FORM_ID, submissionId: 5 });
    openNextcloudBreakerForTests();
    expect(await cycle()).toMatchObject({ status: "nextcloud_unavailable" });
    expect(await sub(5)).toMatchObject({ status: "pending", attempts: 0, claimToken: null });
    expect(getClientOnboardingStats().lastCycleStatus).toBe("nextcloud_unavailable");
  });
});

describe("client onboarding: CP code allocation", () => {
  async function claimed(submissionIds: number[]) {
    await db.insert(clientOnboardingSubmissions).values(
      submissionIds.map((submissionId) => ({
        formId: ONB_FORM_ID,
        submissionId,
        claimToken: `token-${submissionId}`,
        claimedAt: new Date(),
      }))
    );
    return submissionIds.map((submissionId) => ({
      formId: ONB_FORM_ID,
      submissionId,
      claimToken: `token-${submissionId}`,
    }));
  }

  it("hands out distinct, consecutive codes to concurrent allocations", async () => {
    const rows = await claimed([11, 12, 13, 14, 15, 16, 17, 18]);
    const results = await Promise.all(rows.map((row) => allocateProjectCode(row, 2)));
    const codes = results.map((r) => r.projectCode).sort();
    expect(codes).toEqual([
      "CP-003",
      "CP-004",
      "CP-005",
      "CP-006",
      "CP-007",
      "CP-008",
      "CP-009",
      "CP-010",
    ]);
  });

  it("returns the same code when asked again for the same submission", async () => {
    const [row] = await claimed([21]);
    const first = await allocateProjectCode(row, 2);
    const again = await allocateProjectCode(row, 50);
    expect(again).toEqual(first);
  });

  it("starts above the highest code already in the Projects table", async () => {
    const [row] = await claimed([31]);
    expect((await allocateProjectCode(row, 7)).projectCode).toBe("CP-008");
  });

  it("refuses to allocate for a claim it does not hold", async () => {
    await claimed([41]);
    await expect(
      allocateProjectCode({ formId: ONB_FORM_ID, submissionId: 41, claimToken: "someone-else" }, 2)
    ).rejects.toThrow(/Claim/);
  });

  it("gives each submission its own code when cycles overlap", async () => {
    await baseline();
    for (const id of [5, 6, 7]) {
      fake.addSubmission(id, {
        ...FULL,
        company: `Co ${id}`,
        // Own contact per submission: a shared email makes overlapping cycles race on
        // one address-book card (carddav.contact_changed), leaving one for the next cycle.
        email: `contact${id}@example.test`,
        project_name: `P${id}`,
        lead_link: undefined,
      });
    }
    fake.latencyMs = 5;
    const results = await Promise.all([cycle(), cycle(), cycle()]);
    expect(results.reduce((n, r) => n + r.completed, 0)).toBe(3);
    const codes = newProjectRows().map((r) => r.data.get(PROJECT_COLUMNS["Project Code"]));
    expect(codes.sort()).toEqual(["CP-003", "CP-004", "CP-005"]);
    expect(fake.count("POST", "/tables/6/rows")).toBe(3);
  });
});

describe("client onboarding: logging", () => {
  it("never logs answers, names, emails, phones or paths", async () => {
    await baseline();
    fake.addSubmission(5, FULL);
    fake.addSubmission(6, { ...FULL, lead_link: "Nobody Inc" });
    fake.fail({
      match: (r) => r.method === "PUT" && r.path.includes("/addressbooks/"),
      status: 500,
    });
    await cycle();
    await makeDue(5);
    await makeDue(6);
    await cycle();
    const all = log.lines.map((l) => l.text).join("\n");
    for (const secret of [
      "Zephyrine",
      "Ophelia",
      "Quartermaine",
      "ophelia@zephyrine.example",
      "555",
      "Warehouse",
      "Nobody",
      "app-password-for-tests",
      "clients/",
    ]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe("client onboarding: runner", () => {
  it("runs a cycle at start and turns triggers during a cycle into exactly one more", async () => {
    fake.latencyMs = 5;
    const runner = startClientOnboarding(
      log.logger,
      onboardingEnv({ CLIENT_ONBOARDING_POLL_INTERVAL_MS: "600000" })
    );
    expect(runner).not.toBeNull();
    // Both arrive while the start-up cycle is running.
    runner?.trigger();
    runner?.trigger();
    const listings = () => fake.count("GET", "/forms/2/submissions");
    await vi.waitFor(() => expect(listings()).toBe(2));
    await runner?.stop();
    expect(listings()).toBe(2);
    expect(log.lines.some((l) => l.text.includes("Client onboarding started"))).toBe(true);
  });

  it("ignores triggers after stop", async () => {
    const runner = startClientOnboarding(log.logger, onboardingEnv());
    await runner?.stop();
    const calls = vi.mocked(fetch).mock.calls.length;
    runner?.trigger();
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
  });
});

describe("client onboarding: claiming", () => {
  it("claims exactly one due row per call, lowest id first", async () => {
    await db
      .insert(clientOnboardingSubmissions)
      .values([5, 6, 7].map((submissionId) => ({ formId: ONB_FORM_ID, submissionId })));
    expect((await claimNextOnboarding(ONB_FORM_ID))?.submissionId).toBe(5);
    const claimed = () =>
      db
        .select()
        .from(clientOnboardingSubmissions)
        .where(isNotNull(clientOnboardingSubmissions.claimToken));
    expect(await claimed()).toHaveLength(1);
    expect((await claimNextOnboarding(ONB_FORM_ID))?.submissionId).toBe(6);
    expect(await claimed()).toHaveLength(2);
  });
});
