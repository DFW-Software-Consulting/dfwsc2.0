import { describe, expect, it } from "vitest";
import { parseLines } from "../../lib/nextcloud-contacts";
import { buildDesiredState, mergeStripeIdIntoVCard } from "../../lib/stripe-id-writeback-render";

const NOW = new Date("2026-11-05T12:00:00Z");
const card = (...body: string[]) =>
  `${["BEGIN:VCARD", "VERSION:3.0", "UID:dfwsc-client-2-5", "FN:Pat Quartermaine", ...body, "REV:20261101T100000Z", "END:VCARD"].join("\r\n")}\r\n`;
const merge = (data: string, ids: string[]) => mergeStripeIdIntoVCard(data, ids, NOW);
const urls = (data: string) =>
  parseLines(data)
    .filter((l) => l.name === "URL")
    .map((l) => l.value);
const rawLines = (data: string) => parseLines(data).map((l) => l.raw);

describe("mergeStripeIdIntoVCard", () => {
  it("adds a labelled URL entry in Contacts' group form and bumps REV", () => {
    const out = merge(card("EMAIL;TYPE=WORK:ap@example.com"), ["cus_ABC123"]) as string;
    const lines = rawLines(out);
    expect(lines).toContain("NEXTCLOUD1.URL:https://dashboard.stripe.com/customers/cus_ABC123");
    expect(lines).toContain("NEXTCLOUD1.X-ABLABEL:Stripe customer");
    expect(lines).toContain("EMAIL;TYPE=WORK:ap@example.com");
    expect(lines).toContain("REV:20261105T120000Z");
    expect(lines).not.toContain("REV:20261101T100000Z");
    expect(out.endsWith("END:VCARD\r\n")).toBe(true);
    expect(out).not.toMatch(/[^\r]\n/);
  });

  it("is a no-op (null) when the entry is already correct", () => {
    const once = merge(card(), ["cus_ABC123"]) as string;
    expect(merge(once, ["cus_ABC123"])).toBeNull();
  });

  it("uses the next free group number", () => {
    const out = merge(
      card(
        "NEXTCLOUD1.EMAIL;TYPE=HOME:a@example.com",
        "NEXTCLOUD1.X-ABLABEL:Account email",
        "NEXTCLOUD3.TEL:1"
      ),
      ["cus_1"]
    ) as string;
    expect(rawLines(out)).toContain("NEXTCLOUD2.URL:https://dashboard.stripe.com/customers/cus_1");
  });

  it("replaces a stale id and removes its label", () => {
    const stale = merge(card(), ["cus_OLD"]) as string;
    const out = merge(stale, ["cus_NEW"]) as string;
    expect(urls(out)).toEqual(["https://dashboard.stripe.com/customers/cus_NEW"]);
    expect(out).not.toContain("cus_OLD");
    expect(out.match(/X-ABLABEL:Stripe customer/g)).toHaveLength(1);
  });

  it("writes one entry per distinct id, sorted, and drops duplicates", () => {
    const out = merge(card(), ["cus_B", "cus_A", "cus_B"]) as string;
    expect(urls(out)).toEqual([
      "https://dashboard.stripe.com/customers/cus_A",
      "https://dashboard.stripe.com/customers/cus_B",
    ]);
    const dup = card(
      "NEXTCLOUD1.URL:https://dashboard.stripe.com/customers/cus_A",
      "NEXTCLOUD1.X-ABLABEL:Stripe customer",
      "NEXTCLOUD2.URL:https://dashboard.stripe.com/customers/cus_A",
      "NEXTCLOUD2.X-ABLABEL:Stripe customer"
    );
    const deduped = merge(dup, ["cus_A"]) as string;
    expect(urls(deduped)).toHaveLength(1);
  });

  it("preserves other groups, URLs and lines", () => {
    const data = card(
      "ORG:Zephyrine Widgets LLC",
      "URL:https://example.com",
      "NEXTCLOUD1.EMAIL;TYPE=HOME:billing@example.com",
      "NEXTCLOUD1.X-ABLABEL:Account email",
      "NOTE:call after 3pm",
      "item2.URL:https://dashboard.stripe.com/customers/cus_OLD",
      "item2.X-ABLabel:Website"
    );
    const out = merge(data, ["cus_NEW"]) as string;
    const lines = rawLines(out);
    for (const keep of [
      "ORG:Zephyrine Widgets LLC",
      "URL:https://example.com",
      "NEXTCLOUD1.EMAIL;TYPE=HOME:billing@example.com",
      "NEXTCLOUD1.X-ABLABEL:Account email",
      "NOTE:call after 3pm",
    ]) {
      expect(lines).toContain(keep);
    }
    expect(urls(out)).toContain("https://dashboard.stripe.com/customers/cus_NEW");
    expect(out).not.toContain("cus_OLD");
    // The old entry's own group had a foreign label: that label is only dropped when alone.
    expect(lines).not.toContain("item2.X-ABLabel:Website");
  });

  it("keeps a group that still carries other properties when its URL is removed", () => {
    const data = card(
      "NEXTCLOUD4.URL:https://dashboard.stripe.com/customers/cus_OLD",
      "NEXTCLOUD4.NOTE:keep me",
      "NEXTCLOUD4.X-ABLABEL:Stripe customer"
    );
    const out = merge(data, ["cus_NEW"]) as string;
    expect(rawLines(out)).toContain("NEXTCLOUD4.NOTE:keep me");
    expect(rawLines(out)).toContain("NEXTCLOUD4.X-ABLABEL:Stripe customer");
  });

  it("recognises our entry under any group name and label case, so a relabel does not duplicate", () => {
    for (const lines of [
      ["item1.URL:https://dashboard.stripe.com/customers/cus_A", "item1.X-ABLabel:billing"],
      [
        "NEXTCLOUD9.URL;TYPE=WORK:https://dashboard.stripe.com/customers/cus_A",
        "NEXTCLOUD9.X-ABLABEL:STRIPE CUSTOMER",
      ],
      ["url;type=pref:https://dashboard.stripe.com/customers/cus_A"],
    ]) {
      expect(merge(card(...lines), ["cus_A"])).toBeNull();
    }
  });

  it("leaves a test-mode URL for a wanted id alone, and replaces one for a stale id", () => {
    const test = card(
      "NEXTCLOUD1.URL:https://dashboard.stripe.com/test/customers/cus_A",
      "NEXTCLOUD1.X-ABLABEL:Stripe customer"
    );
    expect(merge(test, ["cus_A"])).toBeNull();
    const out = merge(test, ["cus_B"]) as string;
    expect(urls(out)).toEqual(["https://dashboard.stripe.com/customers/cus_B"]);
  });

  it("reads folded lines and CRLF, and writes valid folded CRLF", () => {
    const folded =
      "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:dfwsc-client-2-5\r\nFN:Pat\r\nNEXTCLOUD1.URL:https://dashboard.stripe.com/cust\r\n omers/cus_OLDOLDOLDOLDOLD\r\nNEXTCLOUD1.X-ABLABEL:Stripe customer\r\nNOTE:a very long note that goes on and on and on and on and on and on and on and on and on and on\r\n and on and on\r\nEND:VCARD\r\n";
    expect(merge(folded, ["cus_OLDOLDOLDOLDOLD"])).toBeNull();
    const out = merge(folded, ["cus_NEW"]) as string;
    expect(out).not.toContain("OLDOLD");
    expect(out).not.toMatch(/[^\r]\n/);
    for (const physical of out.split("\r\n")) expect(physical.length).toBeLessThanOrEqual(75);
    expect(parseLines(out).find((l) => l.name === "NOTE")?.value).toContain("on and on and on");
  });

  it("handles bare LF input", () => {
    const lf = "BEGIN:VCARD\nVERSION:3.0\nUID:x\nFN:Pat\nEND:VCARD\n";
    const out = merge(lf, ["cus_A"]) as string;
    expect(out).toContain("NEXTCLOUD1.URL:https://dashboard.stripe.com/customers/cus_A\r\n");
  });
});

describe("buildDesiredState", () => {
  const link = (clientCode: string, stripeCustomerId: string, email = `${clientCode}@x.test`) => ({
    clientCode,
    stripeCustomerId,
    email,
  });
  it("uses the submission's UID and row, else falls back to the email", () => {
    const state = buildDesiredState(
      [link("CP-003", "cus_3"), link("CP-004", "cus_4")],
      [
        {
          projectCode: "CP-003",
          tableRowId: 41,
          contactUid: "dfwsc-client-2-5",
          contactStatus: "created",
        },
        { projectCode: "CP-003", tableRowId: null, contactUid: null, contactStatus: null },
      ]
    );
    expect(state.rows.get("CP-003")).toMatchObject({ tableRowId: 41, customerId: "cus_3" });
    expect(state.rows.get("CP-004")).toMatchObject({ tableRowId: null });
    expect(state.cards.get("dfwsc-client-2-5")).toMatchObject({
      uid: "dfwsc-client-2-5",
      customerIds: ["cus_3"],
    });
    expect(state.cards.get("client:CP-004")).toMatchObject({ uid: null, email: "cp-004@x.test" });
  });
  it("ignores a contact UID of an ambiguous or read-only contact step", () => {
    const state = buildDesiredState(
      [link("CP-003", "cus_3")],
      [
        {
          projectCode: "CP-003",
          tableRowId: 1,
          contactUid: "dfwsc-client-2-5",
          contactStatus: "ambiguous",
        },
      ]
    );
    expect([...state.cards.keys()]).toEqual(["client:CP-003"]);
  });
  it("gives every code on a shared Customer the same id and merges ids of a shared card", () => {
    const state = buildDesiredState(
      [link("CP-001", "cus_S"), link("CP-002", "cus_S"), link("CP-005", "cus_T")],
      [
        { projectCode: "CP-001", tableRowId: 1, contactUid: "uid-1", contactStatus: "created" },
        { projectCode: "CP-005", tableRowId: 5, contactUid: "uid-1", contactStatus: "updated" },
      ]
    );
    expect(state.rows.get("CP-001")?.customerId).toBe("cus_S");
    expect(state.rows.get("CP-002")?.customerId).toBe("cus_S");
    expect(state.cards.get("uid-1")?.customerIds).toEqual(["cus_S", "cus_T"]);
  });

  it("skips a link whose Stripe id is not a plain Customer id, reporting the client code only", () => {
    const skipped: string[] = [];
    const state = buildDesiredState(
      [
        { clientCode: "CP-001", stripeCustomerId: "cus_OK1", email: "a@x.example" },
        {
          clientCode: "CP-002",
          stripeCustomerId: "cus_BAD\r\nURL:https://evil.example",
          email: "b@x.example",
        },
        { clientCode: "CP-003", stripeCustomerId: "sub_123", email: "c@x.example" },
      ],
      [],
      (code) => skipped.push(code)
    );
    expect([...state.rows.keys()]).toEqual(["CP-001"]);
    expect([...state.cards.values()].flatMap((c) => c.customerIds)).toEqual(["cus_OK1"]);
    expect(skipped).toEqual(["CP-002", "CP-003"]);
  });
});
