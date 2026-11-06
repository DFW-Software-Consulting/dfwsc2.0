import { readFileSync } from "node:fs";
import { act, screen, waitFor } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Team from "../pages/Team.jsx";
import { renderWithProviders } from "../test/renderWithProviders.jsx";

// Regression guard: the member cards once stayed invisible forever because their reveal
// observer sat on a `display: contents` wrapper, which has no box and never intersects.
// The IntersectionObserver stub below behaves like a browser in that respect (boxless
// elements never intersect) and the real stylesheets are applied so display is computed.

let style;
let pending; // observer callbacks held until the test releases them

beforeEach(() => {
  pending = [];
  MotionGlobalConfig.skipAnimations = true; // jump to final values, no real animation time
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
        pending.push(() =>
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
  MotionGlobalConfig.skipAnimations = false;
  style.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Team member reveal", () => {
  it("starts hidden, then reveals the card photo and copy once the card intersects", async () => {
    renderWithProviders(<Team />, { initialEntries: ["/team"] });
    const card = screen.getByRole("heading", { name: "Jeremy Ashley" }).closest("article");
    const photo = card.querySelector("a.studio-member-photo");
    const copy = [...card.querySelectorAll(".studio-member-copy > p, .studio-member-copy h3")];
    const hidden = () =>
      [photo, ...copy].filter(
        (el) => el.style.opacity === "0" || el.style.clipPath.includes("100%")
      );

    // Nothing has intersected yet: the photo is wiped shut and every copy line is transparent.
    expect(photo.style.clipPath).toContain("100%");
    expect(copy.length).toBeGreaterThan(0);
    for (const el of copy) expect(el.style.opacity).toBe("0");

    await act(async () => {
      for (const fire of pending) fire();
    });
    await waitFor(() => expect(hidden()).toHaveLength(0));
  });
});
