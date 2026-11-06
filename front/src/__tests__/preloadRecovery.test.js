import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handlePreloadError } from "../utils/preloadRecovery";

describe("handlePreloadError", () => {
  const reload = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    sessionStorage.clear();
    reload.mockClear();
    vi.stubGlobal("location", { ...window.location, reload });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("suppresses the error and reloads on the first failure", () => {
    const event = new Event("vite:preloadError", { cancelable: true });
    handlePreloadError(event);
    expect(event.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("lets the real error propagate on a repeat failure right after a reload", () => {
    handlePreloadError(new Event("vite:preloadError", { cancelable: true }));
    reload.mockClear();

    const event = new Event("vite:preloadError", { cancelable: true });
    handlePreloadError(event);
    expect(event.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads again once enough time has passed", () => {
    handlePreloadError(new Event("vite:preloadError", { cancelable: true }));
    reload.mockClear();
    vi.advanceTimersByTime(11_000);

    const event = new Event("vite:preloadError", { cancelable: true });
    handlePreloadError(event);
    expect(event.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
