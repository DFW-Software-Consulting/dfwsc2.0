import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lenisInstances = vi.hoisted(() => []);
vi.mock("lenis", () => ({
  default: class {
    constructor(options) {
      this.options = options;
      this.destroy = vi.fn();
      lenisInstances.push(this);
    }
  },
}));
vi.mock("lenis/dist/lenis.css", () => ({}));

let SmoothScroll;
let getSmoothScroll;
let listeners;

function mockReducedMotion(reduced) {
  const state = { reduced };
  listeners = new Set();
  window.matchMedia = vi.fn(() => ({
    get matches() {
      return state.reduced;
    },
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
  }));
  return {
    set(value) {
      state.reduced = value;
      for (const fn of listeners) fn();
    },
  };
}

describe("SmoothScroll", () => {
  beforeEach(async () => {
    lenisInstances.length = 0;
    SmoothScroll = (await import("../components/motion/SmoothScroll.jsx")).default;
    getSmoothScroll = (await import("../utils/smoothScroll.js")).getSmoothScroll;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("starts Lenis, registers it, and destroys it on unmount", () => {
    mockReducedMotion(false);
    const { unmount } = render(<SmoothScroll />);

    expect(lenisInstances).toHaveLength(1);
    expect(lenisInstances[0].options.autoRaf).toBe(true);
    expect(lenisInstances[0].options.syncTouch).toBeUndefined(); // touch stays native
    expect(getSmoothScroll()).toBe(lenisInstances[0]);

    unmount();
    expect(lenisInstances[0].destroy).toHaveBeenCalledTimes(1);
    expect(getSmoothScroll()).toBeNull();
    expect(listeners.size).toBe(0);
  });

  it("does not initialize under reduced motion", () => {
    mockReducedMotion(true);
    const { unmount } = render(<SmoothScroll />);

    expect(lenisInstances).toHaveLength(0);
    expect(getSmoothScroll()).toBeNull();
    unmount();
  });

  it("follows the reduced-motion setting while mounted", () => {
    const media = mockReducedMotion(false);
    render(<SmoothScroll />);
    expect(lenisInstances).toHaveLength(1);

    media.set(true);
    expect(lenisInstances[0].destroy).toHaveBeenCalledTimes(1);
    expect(getSmoothScroll()).toBeNull();

    media.set(false);
    expect(lenisInstances).toHaveLength(2);
    expect(getSmoothScroll()).toBe(lenisInstances[1]);
  });
});
