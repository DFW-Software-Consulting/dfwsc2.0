import { describe, expect, it } from "vitest";
import { formatVisitContext, visitContextSchema } from "../../lib/visit-context";

describe("formatVisitContext", () => {
  it("returns an empty string when there is nothing to show", () => {
    expect(formatVisitContext(undefined)).toBe("");
    expect(formatVisitContext({})).toBe("");
    expect(formatVisitContext({ utm: {}, pages: [] })).toBe("");
  });

  it("formats a full context", () => {
    expect(
      formatVisitContext({
        referrer: "google.com",
        landingPath: "/services",
        utm: {
          source: "linkedin",
          medium: "social",
          campaign: "fall-promo",
          term: "x",
          content: "y",
        },
        pages: ["/services", "/pricing", "/about", "/"],
        secondsOnSite: 192,
      })
    ).toBe(
      [
        "--- Visit context ---",
        "Found us via: google.com",
        "Campaign: linkedin / social / fall-promo (term: x, content: y)",
        "Landed on: /services",
        "Pages viewed (4): /services → /pricing → /about → /",
        "Time on site: 3m 12s",
      ].join("\n")
    );
  });

  it("omits lines with no data and falls back to direct or unknown", () => {
    expect(formatVisitContext({ landingPath: "/" })).toBe(
      "--- Visit context ---\nFound us via: direct or unknown\nLanded on: /"
    );
    expect(formatVisitContext({ utm: { term: "t" } })).toContain("Campaign: (term: t)");
  });

  it.each([
    [0, "0s"],
    [45, "45s"],
    [60, "1m 0s"],
    [192, "3m 12s"],
    [3720, "1h 2m"],
    [86400, "24h 0m"],
  ])("formats %i seconds as %s", (seconds, expected) => {
    expect(formatVisitContext({ secondsOnSite: seconds })).toContain(`Time on site: ${expected}`);
  });

  it("trims the pages list with an ellipsis to stay within 1000 characters", () => {
    const page = `/${"a".repeat(150)}`;
    const out = formatVisitContext({ referrer: "google.com", pages: Array(20).fill(page) });
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out).toContain("Pages viewed (20):");
    expect(out).toContain(" → …");
    expect(out).toContain("Found us via: google.com");
  });

  it("hard-cuts the block when it is still too long without any pages", () => {
    const long = "z".repeat(100);
    const out = formatVisitContext({
      referrer: "a".repeat(253),
      landingPath: `/${"b".repeat(199)}`,
      utm: { source: long, medium: long, campaign: long, term: long, content: long },
      pages: ["/x"],
    });
    expect(out).toHaveLength(1000);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("visitContextSchema", () => {
  it("keeps a valid context", () => {
    const ctx = {
      referrer: "news.example.com",
      landingPath: "/a/b-c_d.e~f",
      utm: { source: "s" },
      pages: ["/", "/x"],
      secondsOnSite: 0,
    };
    expect(visitContextSchema.parse(ctx)).toEqual(ctx);
  });

  it("accepts plain campaign text up to 64 characters", () => {
    const utm = {
      source: "newsletter",
      medium: "e-mail",
      campaign: "Spring Sale_2026 (A|B)",
      term: "web+design.dallas",
      content: "a".repeat(64),
    };
    expect(visitContextSchema.parse({ utm }).utm).toEqual(utm);
  });

  it.each([
    ["referrer with a slash", { referrer: "a.com/x" }],
    ["uppercase referrer", { referrer: "A.com" }],
    ["landingPath without a slash", { landingPath: "x" }],
    ["landingPath with a query", { landingPath: "/x?y=1" }],
    ["21 pages", { pages: Array(21).fill("/") }],
    ["newline in utm", { utm: { source: "a\nb" } }],
    ["control char in utm", { utm: { medium: "a\u0000b" } }],
    ["empty utm value", { utm: { campaign: "" } }],
    ["65-char utm value", { utm: { term: "a".repeat(65) } }],
    ["URL in utm", { utm: { source: "https://evil.example/login" } }],
    ["scheme-less link in utm", { utm: { campaign: "see: evil.example/x" } }],
    ["email address in utm", { utm: { content: "pay@evil.example" } }],
    ["angle brackets in utm", { utm: { medium: "<b>hi</b>" } }],
    ["emoji in utm", { utm: { source: "sale \u{1F600}" } }],
    ["quote in utm", { utm: { term: 'say "hi"' } }],
    ["unknown utm key", { utm: { other: "x" } }],
    ["unknown key", { nope: 1 }],
    ["negative seconds", { secondsOnSite: -1 }],
    ["seconds over a day", { secondsOnSite: 86401 }],
    ["string seconds", { secondsOnSite: "5" }],
  ])("rejects %s", (_label, ctx) => {
    expect(visitContextSchema.safeParse(ctx).success).toBe(false);
  });
});
