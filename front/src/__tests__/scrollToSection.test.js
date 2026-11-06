import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrollToSection } from "../utils/scrollToSection.js";
import { setSmoothScroll } from "../utils/smoothScroll.js";

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
    setSmoothScroll(null);
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

  it("uses Lenis with the sticky-header offset when it is active", () => {
    mockReducedMotion(false);
    document.body.innerHTML = '<header></header><section id="contact"></section>';
    Object.defineProperty(document.querySelector("header"), "offsetHeight", { value: 80 });
    const lenis = { scrollTo: vi.fn() };
    setSmoothScroll(lenis);

    expect(scrollToSection("contact")).toBe(true);
    expect(lenis.scrollTo).toHaveBeenCalledWith(document.getElementById("contact"), {
      offset: -80,
    });
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("ignores Lenis and jumps natively under reduced motion", () => {
    mockReducedMotion(true);
    const lenis = { scrollTo: vi.fn() };
    setSmoothScroll(lenis);

    expect(scrollToSection("contact")).toBe(true);
    expect(lenis.scrollTo).not.toHaveBeenCalled();
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
  });
});

describe("scrollToTop", () => {
  afterEach(() => setSmoothScroll(null));

  it("uses Lenis when active, otherwise native smooth, instant under reduced motion", async () => {
    const { scrollToTop } = await import("../utils/scrollToSection.js");
    window.scrollTo = vi.fn();

    mockReducedMotion(false);
    const lenis = { scrollTo: vi.fn() };
    setSmoothScroll(lenis);
    scrollToTop();
    expect(lenis.scrollTo).toHaveBeenCalledWith(0);

    setSmoothScroll(null);
    scrollToTop();
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "smooth" });

    mockReducedMotion(true);
    scrollToTop();
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "auto" });
  });
});
