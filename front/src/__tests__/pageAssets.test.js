// @vitest-environment node
import { describe, expect, it } from "vitest";
import { pageAssets, pageKey } from "../../scripts/page-assets.mjs";

const manifest = {
  "src/pages/Pricing.jsx": {
    file: "assets/Pricing.js",
    css: ["assets/Pricing.css"],
    imports: ["_shared.js", "index.html"],
  },
  "_shared.js": { file: "assets/Shared.js", css: ["assets/Shared.css"] },
  "index.html": { file: "assets/index.js", css: ["assets/index.css"] },
  "src/pages/Privacy.jsx": { file: "assets/Privacy.js" },
};
const template = '<link rel="stylesheet" href="/assets/index.css"><script src="/assets/index.js">';

describe("pageAssets", () => {
  it("maps paths to page modules", () => {
    expect(pageKey("/")).toBe("src/pages/Home.jsx");
    expect(pageKey("/team")).toBe("src/pages/Team.jsx");
  });

  it("links page and shared CSS, then preloads JS, after the template's own links", () => {
    const links = pageAssets(manifest, "/pricing", template)
      .split("\n")
      .map((l) => l.trim());
    expect(links).toEqual([
      '<link rel="stylesheet" crossorigin href="/assets/Pricing.css" />',
      '<link rel="stylesheet" crossorigin href="/assets/Shared.css" />',
      '<link rel="modulepreload" crossorigin href="/assets/Pricing.js" />',
      '<link rel="modulepreload" crossorigin href="/assets/Shared.js" />',
    ]);
  });

  it("skips entry CSS and chunks the template already links", () => {
    const out = pageAssets(manifest, "/pricing", template);
    expect(out).not.toContain("index.css");
    expect(out).not.toContain("index.js");
  });

  it("only preloads JS for a page chunk without CSS", () => {
    expect(pageAssets(manifest, "/privacy", template)).toBe(
      '<link rel="modulepreload" crossorigin href="/assets/Privacy.js" />'
    );
  });

  it("returns nothing when the template already links everything", () => {
    expect(pageAssets(manifest, "/privacy", template + '"/assets/Privacy.js"')).toBe("");
  });

  it("throws when the manifest has no entry for the page", () => {
    expect(() => pageAssets(manifest, "/team", template)).toThrow("src/pages/Team.jsx");
  });
});
