import { describe, expect, it } from "vitest";
import {
  buildClientVCard,
  buildProjectRowData,
  clientFolderName,
  extractIntake,
  formatProjectCode,
  type Intake,
  isNextcloudUser,
  mergeClientVCard,
  normalizeName,
  OnboardingConfigError,
  OnboardingInvalidError,
  parseLeadReference,
  parseProjectNumber,
  projectBriefContent,
  projectPageTitle,
  resolveIntakeQuestions,
  resolvePipelineColumns,
  resolveProjectColumns,
  slugify,
  vCardMatches,
  vCardUid,
} from "../../lib/client-onboarding-mapping";
import { sanitizeFolderName } from "../../lib/sales-lead-mapping";
import {
  INTAKE_QUESTIONS,
  pipelineColumns,
  projectColumns,
} from "../helpers/fake-nextcloud-onboarding";

const questions = Object.entries(INTAKE_QUESTIONS).map(([name, id]) => ({ id, name }));
const map = resolveIntakeQuestions(questions);
const answer = (name: keyof typeof INTAKE_QUESTIONS, text: string) => ({
  questionId: INTAKE_QUESTIONS[name],
  text,
});
const base: Intake = { company: "Acme", projectName: "Portal", summary: "Build it" };
const NOW = new Date("2026-10-31T12:00:00.000Z");

describe("resolveIntakeQuestions", () => {
  it("lists every missing technical name", () => {
    const err = (() => {
      try {
        resolveIntakeQuestions(questions.filter((q) => !["summary", "lead_link"].includes(q.name)));
      } catch (e) {
        return e as OnboardingConfigError;
      }
    })();
    expect(err).toBeInstanceOf(OnboardingConfigError);
    expect(err?.detail).toEqual(["summary", "lead_link"]);
  });
});

describe("extractIntake", () => {
  it("keeps only answered fields, trimmed", () => {
    const intake = extractIntake(
      [
        answer("company", " Acme "),
        answer("project_name", "Portal"),
        answer("summary", "Build it"),
        answer("email", "  "),
        answer("phone", "214 555 0100"),
      ],
      map
    );
    expect(intake).toEqual({ ...base, phone: "214 555 0100" });
  });

  it.each([
    ["company", "missing_company"],
    ["project_name", "missing_project_name"],
    ["summary", "missing_summary"],
  ] as const)("rejects a submission without %s", (field, code) => {
    const answers = (["company", "project_name", "summary"] as const)
      .filter((f) => f !== field)
      .map((f) => answer(f, "x"));
    expect(() => extractIntake(answers, map)).toThrow(new OnboardingInvalidError(code));
  });
});

describe("isNextcloudUser", () => {
  it("rejects anonymous and empty submitters", () => {
    expect(isNextcloudUser("messyginger0804")).toBe(true);
    expect(isNextcloudUser("anon-user-1a2b")).toBe(false);
    expect(isNextcloudUser("")).toBe(false);
    expect(isNextcloudUser(null)).toBe(false);
  });
});

describe("project codes", () => {
  it("formats and parses CP-### codes", () => {
    expect(formatProjectCode(3)).toBe("CP-003");
    expect(formatProjectCode(1234)).toBe("CP-1234");
    expect(parseProjectNumber("CP-002")).toBe(2);
    expect(parseProjectNumber(" CP-010 ")).toBe(10);
    expect(parseProjectNumber("CP-01a")).toBeUndefined();
    expect(parseProjectNumber("XP-001")).toBeUndefined();
    expect(parseProjectNumber(null)).toBeUndefined();
  });
});

describe("parseLeadReference", () => {
  it("reads table and view row links", () => {
    expect(
      parseLeadReference("https://cloud.dfwsc.com/apps/tables/#/table/8/row/12", "Acme")
    ).toEqual({ kind: "row", tableId: 8, rowId: 12 });
    expect(
      parseLeadReference("https://cloud.dfwsc.com/index.php/apps/tables/#/view/3/row/40", "Acme")
    ).toEqual({ kind: "row", tableId: null, rowId: 40 });
  });

  it("treats anything else as a company name, defaulting to the company", () => {
    expect(parseLeadReference("Acme Holdings", "Acme")).toEqual({
      kind: "name",
      name: "Acme Holdings",
    });
    expect(parseLeadReference("  ", "Acme")).toEqual({ kind: "name", name: "Acme" });
    expect(parseLeadReference(undefined, "Acme")).toEqual({ kind: "name", name: "Acme" });
    expect(parseLeadReference("https://cloud/apps/tables/#/table/8/row/12x", "Acme").kind).toBe(
      "name"
    );
  });
});

describe("columns", () => {
  it("resolves the live table titles", () => {
    expect(resolveProjectColumns(projectColumns()).projectCode.id).toBe(26);
    expect(resolvePipelineColumns(pipelineColumns()).clientProject.id).toBe(57);
  });

  it("finds the lead link column under the new and the legacy title", () => {
    for (const title of ["Client Project", "Cerebo Project"]) {
      const renamed = pipelineColumns().map((c) => (c.id === 57 ? { ...c, title } : c));
      expect(resolvePipelineColumns(renamed).clientProject.id).toBe(57);
    }
  });

  it("stops when a status or stage option is missing", () => {
    const noIntake = projectColumns().map((c) =>
      c.title === "Status" ? { ...c, selectionOptions: [{ id: 1, label: "Active" }] } : c
    );
    expect(() => resolveProjectColumns(noIntake)).toThrow(/status_option_missing/);
    const noWon = pipelineColumns().map((c) =>
      c.title === "Stage" ? { ...c, selectionOptions: [{ id: 0, label: "New Lead" }] } : c
    );
    expect(() => resolvePipelineColumns(noWon)).toThrow(/stage_option_missing/);
    expect(() => resolvePipelineColumns([])).toThrow(/Client Project/);
  });

  it("builds the row with Intake, an owner and only valid dates", () => {
    const cols = resolveProjectColumns(projectColumns());
    const data = buildProjectRowData(
      { ...base, startDate: "2026-11-02", targetDate: "next spring" },
      cols,
      "CP-003",
      "jc"
    );
    expect(data).toEqual({
      26: "CP-003",
      27: "Portal",
      28: 0,
      29: [{ id: "jc", type: 0 }],
      30: "2026-11-02",
      35: "Build it",
    });
    expect(buildProjectRowData(base, cols, "CP-003", null)).not.toHaveProperty("29");
  });
});

describe("vCards", () => {
  const existing = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "UID:lead-1",
    "FN:Ada Lovelace",
    "N:Lovelace;Ada;;;",
    "ORG:Acme\\; Sales;Dept",
    "item1.EMAIL;TYPE=WORK:ada@acme.example",
    "TEL:+1 (214) 555-0100",
    "NOTE:keep me",
    "REV:20260101T000000Z",
    "END:VCARD",
    "",
  ].join("\r\n");

  it("builds a card with only the given fields", () => {
    const card = buildClientVCard({ ...base, company: "Acme, Inc; West" }, "dfwsc-client-2-5", NOW);
    expect(card).toContain("UID:dfwsc-client-2-5\r\n");
    expect(card).toContain("FN:Acme\\, Inc\\; West\r\n");
    expect(card).toContain("ORG:Acme\\, Inc\\; West\r\n");
    expect(card).not.toMatch(/EMAIL|TEL/);
    expect(card).toContain("REV:20261031T120000Z");
  });

  it("matches by email, else by company and contact name", () => {
    expect(vCardMatches(existing, { ...base, email: "ADA@acme.example" })).toBe(true);
    expect(vCardMatches(existing, { ...base, company: "Acme; Sales", email: "x@y.z" })).toBe(false);
    expect(vCardMatches(existing, { ...base, company: "acme;  sales" })).toBe(true);
    expect(
      vCardMatches(existing, { ...base, company: "Acme; Sales", contactName: "ada lovelace" })
    ).toBe(true);
    expect(vCardMatches(existing, { ...base, company: "Acme; Sales", contactName: "Bob" })).toBe(
      false
    );
    expect(vCardMatches(existing, base)).toBe(false);
    expect(vCardUid(existing)).toBe("lead-1");
  });

  it("returns null when the card already has everything", () => {
    const intake = {
      ...base,
      company: "Acme; Sales",
      contactName: "Ada Lovelace",
      email: "ada@ACME.example",
      phone: "214-555-0100 ",
    };
    // Same digits once the country code is included.
    expect(mergeClientVCard(existing, { ...intake, phone: "+1 214 555 0100" }, NOW)).toBeNull();
  });

  it("sets ORG and adds missing fields without removing anything", () => {
    const merged = mergeClientVCard(
      existing,
      { ...base, email: "billing@acme.example", phone: "+44 20 7946 0000" },
      NOW
    ) as string;
    expect(merged).toContain("ORG:Acme\r\n");
    expect(merged).not.toContain("ORG:Acme\\; Sales");
    expect(merged).toContain("item1.EMAIL;TYPE=WORK:ada@acme.example");
    expect(merged).toContain("EMAIL;TYPE=WORK:billing@acme.example");
    expect(merged).toContain("TEL;TYPE=WORK:+44 20 7946 0000");
    expect(merged).toContain("NOTE:keep me");
    expect(merged).toContain("FN:Ada Lovelace");
    expect(merged.match(/REV:/g)).toHaveLength(1);
    expect(merged).toMatch(/REV:20261031T120000Z\r\nEND:VCARD\r\n$/);
  });

  it("replaces the name when a different contact name is given", () => {
    const merged = mergeClientVCard(
      existing,
      { ...base, contactName: "Grace Brewster Hopper" },
      NOW
    );
    expect(merged).toContain("FN:Grace Brewster Hopper");
    expect(merged).toContain("N:Hopper;Grace Brewster;;;");
    expect(merged).not.toContain("Lovelace");
  });

  it("unfolds long lines before merging", () => {
    const folded = existing.replace("NOTE:keep me", `NOTE:${"x".repeat(80)}\r\n ${"y".repeat(10)}`);
    const merged = mergeClientVCard(folded, base, NOW) as string;
    expect(merged.replace(/\r\n /g, "")).toContain(`NOTE:${"x".repeat(80)}${"y".repeat(10)}`);
  });
});

describe("names, folders and pages", () => {
  it("normalizes names for exact matching", () => {
    expect(normalizeName("  Acme   Widgets ")).toBe("acme widgets");
    expect(normalizeName("Café")).toBe(normalizeName("Cafe\u0301"));
  });

  it("makes a safe client folder name", () => {
    expect(clientFolderName("Acme/West: Inc.", 5)).toBe("Acme West Inc");
    expect(clientFolderName("///", 5)).toBe("Client 5");
  });

  it("keeps the lead folder fallback unchanged", () => {
    expect(sanitizeFolderName("///", 9)).toBe("Lead 9");
  });

  it("titles and slugs pages like the existing CP pages", () => {
    const title = projectPageTitle("CP-001", "Pilot Workspace Validation", 1);
    expect(title).toBe("CP-001 — Pilot Workspace Validation");
    expect(slugify(title)).toBe("CP-001-Pilot-Workspace-Validation");
    expect(slugify("Café Déjà Vu")).toBe("Cafe-Deja-Vu");
    expect(projectPageTitle("CP-003", "A/B tests", 4)).toBe("CP-003 — A B tests");
  });

  describe("projectBriefContent", () => {
    const input = {
      projectCode: "CP-003",
      summary: "Build it",
      targetDate: "2027-01-29",
      rowUrl: "https://c/row",
      folderUrl: "https://c/f/1",
      intakeTitle: "Intake submission #5",
      intakeUrl: "https://c/results",
    };

    it("fills the template and keeps every link", () => {
      expect(projectBriefContent(input)).toBe(
        [
          "# Project Brief",
          "",
          "> This is the DFWSC client-projects workspace; real client data is allowed. Do not store credentials, Stripe data, or production secrets.",
          "",
          "| Field | Value |",
          "|---|---|",
          "| Project code | CP-003 |",
          "| Purpose | Build it |",
          "| Owner | |",
          "| Target date | 2027-01-29 |",
          "| Success criteria | |",
          "| Constraints | |",
          "| Project row | [Project row](https://c/row) |",
          "| Client folder | [Client folder](https://c/f/1) |",
          "| Intake results | [Intake submission \\#5](https://c/results) |",
          "",
        ].join("\n")
      );
    });

    it("escapes markdown in the intake link title", () => {
      expect(projectBriefContent({ ...input, intakeTitle: "Intake *x* [1]" })).toContain(
        "[Intake \\*x\\* \\[1\\]](https://c/results)"
      );
    });

    it("leaves the target date blank when missing", () => {
      expect(projectBriefContent({ ...input, targetDate: undefined })).toContain(
        "| Target date |  |"
      );
    });

    it("keeps a summary with pipes and newlines inside one table cell", () => {
      const content = projectBriefContent({
        ...input,
        summary: "  Line one | with pipe\r\nline two\n\n| x  ",
      });
      expect(content).toContain("| Purpose | Line one \\| with pipe line two \\| x |");
      const purpose = content.split("\n").filter((l) => l.startsWith("| Purpose"));
      expect(purpose).toHaveLength(1);
    });
  });
});
