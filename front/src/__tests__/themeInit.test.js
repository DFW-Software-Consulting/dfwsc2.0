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

  describe("stale asset rescue", () => {
    const reload = vi.fn();
    const fetchMock = vi.fn();
    let listener;

    const install = () => {
      const add = vi.spyOn(window, "addEventListener");
      run();
      const call = add.mock.calls.find(([type]) => type === "error");
      expect(call[2]).toBe(true); // capture phase: link/script error events do not bubble
      listener = call[1];
    };
    const failing = (html) => {
      const holder = document.createElement("div");
      holder.innerHTML = html;
      return { target: holder.firstChild };
    };

    afterEach(() => sessionStorage.clear());

    const setup = () => {
      sessionStorage.clear();
      reload.mockClear();
      fetchMock.mockReset().mockResolvedValue({});
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal("location", { origin: window.location.origin, reload });
      install();
    };

    it("refetches a failed /assets/ script bypassing the cache, then reloads once", async () => {
      setup();
      const url = `${window.location.origin}/assets/index-abc.js`;
      listener(failing(`<script type="module" src="${url}"></script>`));
      expect(fetchMock).toHaveBeenCalledWith(url, { cache: "reload" });
      await new Promise((r) => setTimeout(r, 0));
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("handles stylesheets too", () => {
      setup();
      const url = `${window.location.origin}/assets/index-abc.css`;
      listener(failing(`<link rel="stylesheet" href="${url}">`));
      expect(fetchMock).toHaveBeenCalledWith(url, { cache: "reload" });
    });

    it("ignores failures outside /assets/ and non-link/script targets", () => {
      setup();
      listener(failing(`<script src="${window.location.origin}/other.js"></script>`));
      listener(failing(`<img src="${window.location.origin}/assets/a.png">`));
      listener({ target: window });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("recovers at most once per 30s (shared guard key)", () => {
      setup();
      const url = `${window.location.origin}/assets/a.js`;
      listener(failing(`<script src="${url}"></script>`));
      listener(failing(`<script src="${url}"></script>`));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sessionStorage.getItem("preload-reloaded-at")).not.toBeNull();
    });
  });
});
