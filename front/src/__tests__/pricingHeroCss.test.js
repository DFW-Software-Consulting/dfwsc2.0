import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const all = readFileSync(join(process.cwd(), "src/pages/Pricing.css"), "utf8");
const css = all.slice(all.indexOf("/* Hero art"));

describe("Pricing hero art styles", () => {
  it("only declares its animations under prefers-reduced-motion: no-preference", () => {
    const outside = css.replace(
      /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/,
      ""
    );
    expect(css).toContain("animation: hero-art-drift");
    expect(outside).not.toMatch(/animation:\s*hero-art/);
  });
});
