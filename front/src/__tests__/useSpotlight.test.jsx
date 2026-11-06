import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSpotlight, useTilt } from "../components/motion/useTilt.js";

let reduced = false;
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal()),
  useReducedMotion: () => reduced,
}));

const stubPointer = (fine) =>
  vi.stubGlobal("matchMedia", (query) => ({
    matches: fine && query.includes("pointer: fine"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));

const target = () => {
  const el = document.createElement("div");
  el.getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, width: 200, height: 100 }));
  return el;
};
const move = (el, clientX, clientY, pointerType = "mouse") => ({
  pointerType,
  clientX,
  clientY,
  currentTarget: el,
});

beforeEach(() => {
  reduced = false;
});
afterEach(() => vi.unstubAllGlobals());

describe("useSpotlight", () => {
  it("writes the cursor position as --mx/--my for a mouse on a fine pointer", () => {
    stubPointer(true);
    const { result } = renderHook(() => useSpotlight());
    const el = target();
    result.current.onPointerMove(move(el, 50, 50));
    expect(el.style.getPropertyValue("--mx")).toBe("25%");
    expect(el.style.getPropertyValue("--my")).toBe("50%");
    result.current.onPointerMove(move(el, 150, 10, "touch"));
    expect(el.style.getPropertyValue("--mx")).toBe("25%");
  });

  it("returns no handlers without a fine pointer", () => {
    stubPointer(false);
    const { result } = renderHook(() => useSpotlight());
    expect(result.current).toEqual({});
  });

  it("returns no handlers when motion is not allowed", () => {
    stubPointer(true);
    reduced = true;
    const { result } = renderHook(() => useSpotlight());
    expect(result.current).toEqual({});
  });
});

describe("useTilt", () => {
  it("tilts toward the cursor, shares one bounding-box read with the spotlight, and resets", () => {
    stubPointer(true);
    const { result } = renderHook(() => useTilt(4));
    const el = target();
    result.current.onPointerMove(move(el, 200, 0));
    expect(el.getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(el.style.getPropertyValue("--mx")).toBe("100%");
    expect(el.style.getPropertyValue("--my")).toBe("0%");
    result.current.onPointerLeave();
    expect(result.current.style.transformPerspective).toBe(1200);
  });

  it("ignores non-mouse pointers", () => {
    stubPointer(true);
    const { result } = renderHook(() => useTilt());
    const el = target();
    result.current.onPointerMove(move(el, 10, 10, "touch"));
    expect(el.getBoundingClientRect).not.toHaveBeenCalled();
  });

  it("returns no props when motion is not allowed", () => {
    stubPointer(true);
    reduced = true;
    const { result } = renderHook(() => useTilt());
    expect(result.current).toEqual({});
  });
});
