import { readFileSync } from "node:fs";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Team from "../pages/Team.jsx";
import { renderWithProviders } from "../test/renderWithProviders.jsx";

// Regression guard: the member cards once stayed invisible forever because their reveal
// observer sat on a `display: contents` wrapper, which has no box and never intersects.
// The IntersectionObserver stub below behaves like a browser in that respect (boxless
// elements never intersect) and the real stylesheets are applied so display is computed.

let style;

beforeEach(() => {
  window.scrollTo = vi.fn();
  style = document.createElement("style");
  style.textContent = ["../styles/studio.css", "../pages/Team.css"]
    .map((file) => readFileSync(new URL(file, import.meta.url), "utf8"))
    .join("\n");
  document.head.appendChild(style);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback) {
        this.callback = callback;
      }
      observe(target) {
        const boxless = getComputedStyle(target).display === "contents";
        queueMicrotask(() =>
          this.callback([{ target, isIntersecting: !boxless, intersectionRatio: boxless ? 0 : 1 }])
        );
      }
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal("matchMedia", (query) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  // Everything below the fold, so cards must be revealed by the observer, not at mount.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => ({
    top: 5000,
    bottom: 5100,
    left: 0,
    right: 0,
    width: 100,
    height: 100,
  }));
});

afterEach(() => {
  style.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Team member reveal", () => {
  it("reveals the card photo and copy once the card intersects", async () => {
    renderWithProviders(<Team />, { initialEntries: ["/team"] });
    const card = screen.getByRole("heading", { name: "Jeremy Ashley" }).closest("article");
    const photo = card.querySelector("a.studio-member-photo");
    const hidden = () =>
      [photo, ...card.querySelectorAll(".studio-member-copy *")].filter(
        (el) => el.style.opacity === "0" || el.style.clipPath.includes("100%")
      );
    await waitFor(() => expect(hidden()).toHaveLength(0), { timeout: 4000 });
  });
});
