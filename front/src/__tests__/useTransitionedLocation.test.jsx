import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const preloadRoute = vi.hoisted(() => vi.fn());
vi.mock("../routes.js", () => ({ preloadRoute }));

import { useTransitionedLocation } from "../utils/useTransitionedLocation.js";

const loc = (pathname) => ({ pathname, key: pathname });

function mockMotion({ api = true, reduced = false } = {}) {
  window.matchMedia = vi.fn((query) => ({
    matches: reduced && query.includes("reduced-motion"),
    addEventListener() {},
    removeEventListener() {},
  }));
  if (api) {
    document.startViewTransition = vi.fn((update) => {
      update();
      return {
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        finished: Promise.resolve(),
      };
    });
  }
}

const flush = () => act(async () => {});

beforeEach(() => {
  vi.useFakeTimers();
  preloadRoute.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  delete document.startViewTransition;
  document.documentElement.className = "";
});

describe("useTransitionedLocation", () => {
  it("keeps the old location until the next chunk has loaded, then swaps in a transition", async () => {
    mockMotion();
    let resolve;
    preloadRoute.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result, rerender } = renderHook(({ l }) => useTransitionedLocation(l), {
      initialProps: { l: loc("/") },
    });
    rerender({ l: loc("/pricing") });
    await flush();
    expect(result.current.pathname).toBe("/");
    expect(document.startViewTransition).not.toHaveBeenCalled();

    resolve();
    await flush();
    expect(result.current.pathname).toBe("/pricing");
    expect(document.startViewTransition).toHaveBeenCalledOnce();
  });

  it("swaps after the 1.5s cap when the chunk never resolves", async () => {
    mockMotion();
    preloadRoute.mockReturnValue(new Promise(() => {}));
    const { result, rerender } = renderHook(({ l }) => useTransitionedLocation(l), {
      initialProps: { l: loc("/") },
    });
    rerender({ l: loc("/team") });
    await act(async () => vi.advanceTimersByTime(1400));
    expect(result.current.pathname).toBe("/");
    await act(async () => vi.advanceTimersByTime(200));
    expect(result.current.pathname).toBe("/team");
  });

  it("swaps without a transition when unsupported or under reduced motion", async () => {
    for (const opts of [{ api: false }, { reduced: true }]) {
      mockMotion(opts);
      preloadRoute.mockResolvedValue();
      const { result, rerender, unmount } = renderHook(({ l }) => useTransitionedLocation(l), {
        initialProps: { l: loc("/") },
      });
      rerender({ l: loc("/pricing") });
      await flush();
      expect(result.current.pathname).toBe("/pricing");
      if (document.startViewTransition) {
        expect(document.startViewTransition).not.toHaveBeenCalled();
      }
      unmount();
      delete document.startViewTransition;
    }
  });

  it("follows non-marketing routes immediately without preloading", () => {
    mockMotion();
    const { result, rerender } = renderHook(({ l }) => useTransitionedLocation(l), {
      initialProps: { l: loc("/") },
    });
    rerender({ l: loc("/admin") });
    expect(result.current.pathname).toBe("/admin");
    expect(preloadRoute).not.toHaveBeenCalled();
    expect(document.startViewTransition).not.toHaveBeenCalled();
  });

  it("ends on the last location after rapid navigations", async () => {
    mockMotion();
    preloadRoute.mockResolvedValue();
    const { result, rerender } = renderHook(({ l }) => useTransitionedLocation(l), {
      initialProps: { l: loc("/") },
    });
    rerender({ l: loc("/pricing") });
    rerender({ l: loc("/team") });
    rerender({ l: loc("/privacy") });
    await flush();
    expect(result.current.pathname).toBe("/privacy");
  });

  it("still navigates when the preload rejects, without a stuck cap timer", async () => {
    mockMotion();
    preloadRoute.mockRejectedValue(new TypeError("Failed to fetch dynamically imported module"));
    const { result, rerender } = renderHook(({ l }) => useTransitionedLocation(l), {
      initialProps: { l: loc("/") },
    });
    rerender({ l: loc("/pricing") });
    await flush();
    expect(result.current.pathname).toBe("/pricing");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not transition for a hash or same-path navigation", async () => {
    mockMotion();
    const { result, rerender } = renderHook(({ l }) => useTransitionedLocation(l), {
      initialProps: { l: loc("/pricing") },
    });
    const next = { pathname: "/pricing", hash: "#hosting", key: "k2" };
    rerender({ l: next });
    expect(result.current).toBe(next);
    expect(preloadRoute).not.toHaveBeenCalled();
    expect(document.startViewTransition).not.toHaveBeenCalled();
  });

  it("runs one transition per settled navigation, not one per click", async () => {
    mockMotion();
    preloadRoute.mockResolvedValue();
    const { rerender } = renderHook(({ l }) => useTransitionedLocation(l), {
      initialProps: { l: loc("/") },
    });
    rerender({ l: loc("/pricing") });
    rerender({ l: loc("/team") });
    await flush();
    expect(document.startViewTransition).toHaveBeenCalledOnce();
  });
});
