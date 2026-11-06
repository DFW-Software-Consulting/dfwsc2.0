import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSpotlight } from "../components/motion/useTilt.js";

afterEach(() => vi.unstubAllGlobals());

describe("useSpotlight", () => {
  it("writes the cursor position as --mx/--my for a mouse on a fine pointer", () => {
    vi.stubGlobal("matchMedia", (query) => ({
      matches: query.includes("pointer: fine"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    const { result } = renderHook(() => useSpotlight());
    const el = document.createElement("div");
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100 });
    result.current.onPointerMove({
      pointerType: "mouse",
      clientX: 50,
      clientY: 50,
      currentTarget: el,
    });
    expect(el.style.getPropertyValue("--mx")).toBe("25%");
    expect(el.style.getPropertyValue("--my")).toBe("50%");
    result.current.onPointerMove({
      pointerType: "touch",
      clientX: 150,
      clientY: 10,
      currentTarget: el,
    });
    expect(el.style.getPropertyValue("--mx")).toBe("25%");
  });

  it("returns no handlers without a fine pointer", () => {
    vi.stubGlobal("matchMedia", (query) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    const { result } = renderHook(() => useSpotlight());
    expect(result.current).toEqual({});
  });
});
