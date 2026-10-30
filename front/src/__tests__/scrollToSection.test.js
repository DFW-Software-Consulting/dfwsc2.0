import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrollToSection } from "../utils/scrollToSection.js";

function mockReducedMotion(reduce) {
  window.matchMedia = vi.fn((query) => ({
    matches: query === "(prefers-reduced-motion: reduce)" && reduce,
  }));
}

describe("scrollToSection", () => {
  beforeEach(() => {
    document.body.innerHTML = '<section id="contact"></section>';
    window.scrollTo = vi.fn();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("scrolls smoothly by default", () => {
    mockReducedMotion(false);

    expect(scrollToSection("contact")).toBe(true);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("jumps without animation when the user prefers reduced motion", () => {
    mockReducedMotion(true);

    expect(scrollToSection("contact")).toBe(true);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
  });

  it("returns false and does not scroll when the section is missing", () => {
    mockReducedMotion(false);

    expect(scrollToSection("missing")).toBe(false);
    expect(window.scrollTo).not.toHaveBeenCalled();
  });
});
