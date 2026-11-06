import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(here, "..", "..", "public", "theme-init.js"), "utf-8");
const html = readFileSync(join(here, "..", "..", "index.html"), "utf-8");

const run = () => new Function(script)();

afterEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("public/theme-init.js", () => {
  it("is a blocking external script in the head (CSP allows no inline script)", () => {
    expect(html).toMatch(/<head>[\s\S]*<script src="\/theme-init\.js"><\/script>[\s\S]*<\/head>/);
  });

  it("applies the stored theme", () => {
    localStorage.setItem("theme", "dark");
    run();
    expect(document.documentElement.className).toBe("dark");
  });

  it("falls back to the OS preference", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    run();
    expect(document.documentElement.className).toBe("dark");
  });

  it("survives blocked storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    run();
    expect(document.documentElement.className).toBe("light");
  });
});
