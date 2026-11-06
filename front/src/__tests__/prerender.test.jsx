// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { faqItems, hostingPlans } from "../content/pricing.js";
import { render } from "../entry-server.jsx";

const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("prerender entry", () => {
  it("renders real page content for lazy routes, with no Suspense fallback or inline scripts", async () => {
    for (const path of ["/", "/pricing", "/team", "/privacy", "/docs", "/404"]) {
      const html = await render(path);
      expect(html, path).not.toContain("animate-spin");
      expect(html, path).not.toContain("<script");
      expect(html, path).toContain("<h1");
    }
  });

  it("renders the pricing plans and FAQ as visible text", async () => {
    const copy = text(await render("/pricing"));
    for (const plan of hostingPlans) expect(copy).toContain(plan.name);
    for (const { question, answer } of faqItems) {
      expect(copy).toContain(question);
      expect(copy).toContain(answer);
    }
  });

  it("renders the not-found page for unknown paths", async () => {
    expect(text(await render("/404"))).toContain("Page Not Found");
  });
});

describe("render timeout", () => {
  it("rejects instead of hanging when a render does not finish in time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const pending = expect(render("/docs", 5000)).rejects.toThrow(/did not finish within 5000ms/);
      vi.advanceTimersByTime(5000); // before the render's own async work can finish
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
});
