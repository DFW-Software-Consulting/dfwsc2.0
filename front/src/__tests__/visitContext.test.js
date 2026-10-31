import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function load({ url = "/", referrer = "" } = {}) {
  vi.resetModules();
  window.history.replaceState({}, "", url);
  Object.defineProperty(document, "referrer", { value: referrer, configurable: true });
  return import("../utils/visitContext.js");
}

describe("visitContext", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns an empty object before init", async () => {
    const m = await load();
    expect(m.getVisitContext()).toEqual({});
  });

  it("parses, trims and clamps utm values and omits empty ones", async () => {
    const long = "x".repeat(150);
    const m = await load({
      url: `/pricing?utm_source=%20news%20&utm_medium=email&utm_campaign=${long}&utm_term=&utm_content=a%07b`,
    });
    m.initVisitContext();
    const ctx = m.getVisitContext();
    expect(ctx.utm).toEqual({
      source: "news",
      medium: "email",
      campaign: "x".repeat(100),
      content: "ab",
    });
    expect(ctx.landingPath).toBe("/pricing");
  });

  it("strips Unicode control and line/paragraph separators from utm values", async () => {
    const raw = encodeURIComponent("\u0085Spring   Sale\u0085");
    const m = await load({ url: `/?utm_campaign=${raw}` });
    m.initVisitContext();
    expect(m.getVisitContext().utm).toEqual({ campaign: "Spring Sale" });
  });

  it("truncates utm values to 100 UTF-16 units without splitting emoji", async () => {
    const raw = encodeURIComponent("\u{1F600}".repeat(101));
    const m = await load({ url: `/?utm_content=${raw}` });
    m.initVisitContext();
    const { content } = m.getVisitContext().utm;
    expect(content.length).toBeLessThanOrEqual(100);
    expect(content).toBe("\u{1F600}".repeat(50));
    expect(content).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    );
  });

  it("omits utm when none are present", async () => {
    const m = await load();
    m.initVisitContext();
    expect(m.getVisitContext()).not.toHaveProperty("utm");
  });

  it("keeps an external referrer hostname, lowercased without www", async () => {
    const m = await load({ referrer: "https://WWW.Google.com/search?q=secret" });
    m.initVisitContext();
    expect(m.getVisitContext().referrer).toBe("google.com");
  });

  it.each([
    "https://dfwsc.com/team",
    "https://www.dfwsc.com/",
    "https://api.dfwsc.com/x",
    "http://localhost:5173/",
    "",
    "not a url",
  ])("drops same-site or invalid referrer %s", async (referrer) => {
    const m = await load({ referrer });
    m.initVisitContext();
    expect(m.getVisitContext()).not.toHaveProperty("referrer");
  });

  it("is idempotent", async () => {
    const m = await load({ url: "/?utm_source=a" });
    m.initVisitContext();
    window.history.replaceState({}, "", "/pricing?utm_source=b");
    vi.advanceTimersByTime(5000);
    m.initVisitContext();
    const ctx = m.getVisitContext();
    expect(ctx.utm.source).toBe("a");
    expect(ctx.landingPath).toBe("/");
    expect(ctx.secondsOnSite).toBe(5);
  });

  it("never records non-allowlisted or token paths, including as landing", async () => {
    const m = await load({ url: "/onboarding-success?token=abc123" });
    m.initVisitContext();
    for (const p of [
      "/onboard",
      "/admin",
      "/payment-success",
      "/payment-cancel",
      "/regenerate-key",
      "/request-key-regeneration",
      "/onboarding-success",
      "/docs",
      "/pricing/abc123",
      "/nope",
      "/team/../admin",
    ]) {
      m.recordPage(p);
    }
    const ctx = m.getVisitContext();
    expect(ctx).not.toHaveProperty("landingPath");
    expect(ctx).not.toHaveProperty("pages");
    expect(JSON.stringify(ctx)).not.toContain("abc123");
  });

  it("drops utm when the landing page is not recordable", async () => {
    const m = await load({ url: "/regenerate-key?utm_source=x&token=t" });
    m.initVisitContext();
    expect(m.getVisitContext()).not.toHaveProperty("utm");
  });

  it("records allowlisted pages, strips query/hash, collapses consecutive duplicates", async () => {
    const m = await load();
    m.initVisitContext();
    for (const p of ["/", "/", "/pricing?x=1", "/pricing#a", "/team/", "/", "/privacy"]) {
      m.recordPage(p);
    }
    expect(m.getVisitContext().pages).toEqual(["/", "/pricing", "/team", "/", "/privacy"]);
  });

  it("keeps only the most recent 20 pages", async () => {
    const m = await load();
    m.initVisitContext();
    for (let i = 0; i < 30; i++) m.recordPage(i % 2 ? "/pricing" : "/team");
    const { pages } = m.getVisitContext();
    expect(pages).toHaveLength(20);
    expect(pages[19]).toBe("/pricing");
  });

  it("computes secondsOnSite and caps it at 86400", async () => {
    const m = await load();
    m.initVisitContext();
    vi.advanceTimersByTime(12_900);
    expect(m.getVisitContext().secondsOnSite).toBe(12);
    vi.advanceTimersByTime(200_000_000);
    expect(m.getVisitContext().secondsOnSite).toBe(86400);
  });

  it("returns a fresh object each call", async () => {
    const m = await load();
    m.initVisitContext();
    m.recordPage("/");
    const a = m.getVisitContext();
    a.pages.push("/hacked");
    expect(m.getVisitContext().pages).toEqual(["/"]);
  });

  it("writes nothing to cookies or web storage", async () => {
    const cookieSet = vi.spyOn(document, "cookie", "set");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const m = await load({ url: "/?utm_source=a", referrer: "https://example.org/" });
    m.initVisitContext();
    m.recordPage("/pricing");
    m.getVisitContext();
    expect(cookieSet).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });
});
