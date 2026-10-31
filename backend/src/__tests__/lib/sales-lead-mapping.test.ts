import { describe, expect, it } from "vitest";
import {
  buildRowData,
  buildVCard,
  contactUid,
  extractLead,
  folderNameCandidate,
  hasPerson,
  LEAD_QUESTION_TITLES,
  leadRef,
  linkCellUrl,
  linkValue,
  parseDate,
  parseEstimatedValue,
  resolveColumns,
  resolveQuestions,
  SalesLeadConfigError,
  SalesLeadInvalidError,
  sanitizeFolderName,
} from "../../lib/sales-lead-mapping";
import { defaultColumns } from "../helpers/fake-nextcloud";

const questions = Object.values(LEAD_QUESTION_TITLES).map((text, i) => ({ id: i + 1, text }));
const qmap = resolveQuestions(questions);
const columns = resolveColumns(defaultColumns());

const answer = (title: string, text: string) => ({
  questionId: questions.find((q) => q.text === title)?.id ?? -1,
  text,
});

describe("resolveQuestions", () => {
  it("maps every expected title to its id, ignoring surrounding whitespace", () => {
    const map = resolveQuestions(questions.map((q) => ({ ...q, text: ` ${q.text} ` })));
    expect(map.company).toBe(1);
    expect(map.notes).toBe(9);
  });

  it("lists the missing titles", () => {
    const error = (() => {
      try {
        resolveQuestions(questions.filter((q) => q.text !== "Email" && q.text !== "Notes"));
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(SalesLeadConfigError);
    expect(error).toMatchObject({ code: "form_questions_missing", detail: ["Email", "Notes"] });
  });
});

describe("extractLead", () => {
  it("trims answers, joins multi-answers and omits blanks", () => {
    const lead = extractLead(
      [
        answer("Company", "  Acme  "),
        answer("Source", "Referral"),
        answer("Source", "Website"),
        answer("Phone", "   "),
      ],
      qmap
    );
    expect(lead).toEqual({ company: "Acme", source: "Referral, Website" });
    expect(hasPerson(lead)).toBe(false);
  });

  it("requires a company", () => {
    expect(() => extractLead([answer("Company", " ")], qmap)).toThrow(SalesLeadInvalidError);
  });

  it("counts a name, email or phone as a person", () => {
    for (const title of ["Contact name", "Email", "Phone"]) {
      expect(hasPerson(extractLead([answer("Company", "A"), answer(title, "x")], qmap))).toBe(true);
    }
  });
});

describe("resolveColumns", () => {
  it("lists the missing column titles", () => {
    expect(() => resolveColumns(defaultColumns().filter((c) => c.title !== "Lead Ref"))).toThrow(
      /table_columns_missing: Lead Ref/
    );
  });

  it("requires a New Lead option on Stage", () => {
    const cols = defaultColumns().map((c) =>
      c.title === "Stage" ? { ...c, selectionOptions: [{ id: 2, label: "Qualified" }] } : c
    );
    expect(() => resolveColumns(cols)).toThrow(/stage_option_missing/);
  });

  it("accepts selection options sent as a JSON string", () => {
    const cols = defaultColumns().map((c) =>
      c.title === "Stage" ? { ...c, selectionOptions: JSON.stringify(c.selectionOptions) } : c
    );
    expect(resolveColumns(cols).stage.id).toBe(4);
  });

  it("rejects unusable selection options", () => {
    for (const selectionOptions of ["not json", "{}", null]) {
      const cols = defaultColumns().map((c) =>
        c.title === "Stage" ? { ...c, selectionOptions } : c
      );
      expect(() => resolveColumns(cols)).toThrow(/stage_option_missing/);
    }
  });
});

describe("buildRowData", () => {
  it("maps the lead into cells keyed by column id", () => {
    const { data, dropped } = buildRowData(
      {
        company: "Acme",
        contactName: "Ann",
        email: "ann@acme.test",
        phone: "555",
        source: "website",
        temperature: "HOT",
        estimatedValue: "1,000",
        nextFollowUp: "2026-12-01",
        notes: "Line one\nline two",
      },
      columns,
      "12:5"
    );
    expect(dropped).toEqual([]);
    expect(data).toEqual({
      1: "Acme",
      2: "Ann",
      4: 1,
      5: 1,
      6: 2,
      7: 1000,
      8: "2026-12-01",
      13: "Line one\nline two",
      14: "12:5",
    });
  });

  it("drops answers that do not fit their column", () => {
    const { data, dropped } = buildRowData(
      { company: "Acme", temperature: "Lukewarm", estimatedValue: "TBD", nextFollowUp: "soon" },
      columns,
      "12:5"
    );
    expect(dropped).toEqual(["temperature", "estimatedValue", "nextFollowUp"]);
    expect(Object.keys(data).sort()).toEqual(["1", "14", "4"]);
  });

  it("writes an array for a multi-select column", () => {
    const multi = resolveColumns(
      defaultColumns().map((c) => (c.title === "Source" ? { ...c, subtype: "multi" } : c))
    );
    expect(buildRowData({ company: "A", source: "Referral" }, multi, "r").data[6]).toEqual([1]);
  });
});

describe("value parsing", () => {
  it.each([
    ["$12,500", 12500],
    ["12500.50", 12500.5],
    [" 7 500 USD", 7500],
    ["-3", -3],
    ["about 5k", undefined],
    ["", undefined],
  ])("parseEstimatedValue(%j)", (input, expected) => {
    expect(parseEstimatedValue(input)).toBe(expected);
  });

  it.each([
    ["2026-11-15", "2026-11-15"],
    ["2026-11-15T10:00:00Z", "2026-11-15"],
    ["2026-02-30", undefined],
    ["2026-13-01", undefined],
    ["0000-01-01", undefined],
    ["15/11/2026", undefined],
  ])("parseDate(%j)", (input, expected) => {
    expect(parseDate(input)).toBe(expected);
  });
});

describe("refs and links", () => {
  it("builds the lead ref, contact uid and link cell value", () => {
    expect(leadRef(12, 5)).toBe("12:5");
    expect(contactUid(12, 5)).toBe("dfwsc-lead-12-5");
    expect(linkValue("Lead folder", "https://c.test/f/1")).toBe("Lead folder (https://c.test/f/1)");
  });
});

describe("linkCellUrl", () => {
  it("reads the URL from the JSON string Tables stores, escaped slashes included", () => {
    expect(
      linkCellUrl(
        '{"title":"Lead folder","value":"https:\\/\\/cloud.dfwsc.com\\/index.php\\/f\\/4624","providerId":"url"}'
      )
    ).toBe("https://cloud.dfwsc.com/index.php/f/4624");
  });

  it("keeps %-encoding and base64 padding as written", () => {
    const url = "https://c.test/apps/contacts/direct/contact/a%7Eb%3D~ZGZ3c2M=";
    expect(linkCellUrl(JSON.stringify({ title: "Contact card", value: url }))).toBe(url);
  });

  it.each([
    [undefined, null],
    [null, null],
    ["", null],
    [42, null],
    ["Lead folder (https://c.test/f/1)", "Lead folder (https://c.test/f/1)"],
    ["https://c.test/f/1", "https://c.test/f/1"],
    ['{"title":"no value"}', '{"title":"no value"}'],
    ['{"value":7}', '{"value":7}'],
    ['"https://c.test/f/1"', '"https://c.test/f/1"'],
  ])("linkCellUrl(%j)", (input, expected) => {
    expect(linkCellUrl(input)).toBe(expected);
  });
});

describe("buildVCard", () => {
  const now = new Date("2026-10-30T12:34:56.789Z");

  it("writes a CRLF vCard 3.0 with escaped values", () => {
    const card = buildVCard(
      {
        company: "Smith, Jones; Co",
        contactName: "Mary Ann Smith",
        email: "mary@example.test",
        phone: "+1 555",
      },
      "dfwsc-lead-1-2",
      now
    );
    expect(card.endsWith("\r\n")).toBe(true);
    const lines = card.trimEnd().split("\r\n");
    expect(lines).toEqual([
      "BEGIN:VCARD",
      "VERSION:3.0",
      "PRODID:-//DFW Software Consulting//Sales Lead Automation//EN",
      "UID:dfwsc-lead-1-2",
      "FN:Mary Ann Smith",
      "N:Smith;Mary Ann;;;",
      "ORG:Smith\\, Jones\\; Co",
      "EMAIL;TYPE=WORK:mary@example.test",
      "TEL;TYPE=WORK:+1 555",
      "CATEGORIES:Lead",
      "REV:20261030T123456Z",
      "END:VCARD",
    ]);
  });

  it("falls back to email, phone, then company for the display name", () => {
    expect(buildVCard({ company: "A", email: "e@x.test" }, "u", now)).toContain("FN:e@x.test");
    expect(buildVCard({ company: "A", phone: "555" }, "u", now)).toContain("FN:555");
    expect(buildVCard({ company: "A\\B\nC" }, "u", now)).toContain("FN:A\\\\B\\nC");
    expect(buildVCard({ company: "A", contactName: "Cher" }, "u", now)).toContain("N:;Cher;;;");
  });

  it("folds lines longer than 75 octets without splitting characters", () => {
    const card = buildVCard({ company: "é".repeat(80), contactName: "X" }, "u", now);
    const org = card.split("\r\n").filter((l, i, all) => {
      const start = all.findIndex((x) => x.startsWith("ORG:"));
      return i >= start && (i === start || l.startsWith(" "));
    });
    expect(org.length).toBeGreaterThan(1);
    for (const line of org) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(org.map((l, i) => (i === 0 ? l : l.slice(1))).join("")).toBe(`ORG:${"é".repeat(80)}`);
  });
});

describe("sanitizeFolderName", () => {
  it.each([
    ["Acme Inc.", "Acme Inc"],
    ['  A/B\\C:D*E?F"G<H>I|J  ', "A B C D E F G H I J"],
    ["..hidden", "hidden"],
    ["Tab\tand\nnewline", "Tab and newline"],
    ["..", "Lead 7"],
    ["/", "Lead 7"],
    ["Café Ünïcode", "Café Ünïcode"],
  ])("%j → %j", (input, expected) => {
    expect(sanitizeFolderName(input, 7)).toBe(expected);
  });

  it("caps the length at 100 characters", () => {
    expect(Array.from(sanitizeFolderName("ü".repeat(150), 1))).toHaveLength(100);
    expect(sanitizeFolderName(`${"a".repeat(99)} b`, 1)).toBe("a".repeat(99));
  });

  it("suffixes later candidates", () => {
    expect(folderNameCandidate("Acme", 1)).toBe("Acme");
    expect(folderNameCandidate("Acme", 2)).toBe("Acme (2)");
  });
});
