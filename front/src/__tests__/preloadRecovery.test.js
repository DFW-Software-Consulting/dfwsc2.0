import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractAssetUrl,
  handlePreloadError,
  isChunkLoadError,
  startRecovery,
} from "../utils/preloadRecovery";

const chunkError = (url = "https://dfwsc.com/assets/Demos-abc123.js") =>
  new TypeError(`Failed to fetch dynamically imported module: ${url}`);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("isChunkLoadError", () => {
  it.each([
    "Failed to fetch dynamically imported module: https://x/assets/a.js",
    "Importing a module script failed.",
    "error loading dynamically imported module",
    "Unable to preload CSS for /assets/a.css",
  ])("matches %s", (message) => {
    expect(isChunkLoadError(new Error(message))).toBe(true);
  });

  it("ignores other errors", () => {
    expect(isChunkLoadError(new Error("boom"))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe("extractAssetUrl", () => {
  it("reads an absolute URL", () => {
    expect(extractAssetUrl(chunkError())).toBe("https://dfwsc.com/assets/Demos-abc123.js");
  });

  it("reads a root-relative asset path", () => {
    expect(extractAssetUrl(new Error("Unable to preload CSS for /assets/x-1.css"))).toBe(
      "/assets/x-1.css"
    );
  });

  it("returns null when there is no URL", () => {
    expect(extractAssetUrl(new Error("Importing a module script failed."))).toBeNull();
    expect(extractAssetUrl(undefined)).toBeNull();
  });
});

describe("recovery", () => {
  const reload = vi.fn();
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    sessionStorage.clear();
    reload.mockClear();
    fetchMock.mockReset().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", { ...window.location, reload });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("refetches the failed asset bypassing the cache, then reloads once", async () => {
    const event = new Event("vite:preloadError", { cancelable: true });
    event.payload = chunkError();
    handlePreloadError(event);
    expect(event.defaultPrevented).toBe(true);
    await flush();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://dfwsc.com/assets/Demos-abc123.js",
      expect.objectContaining({ cache: "reload" })
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("still reloads when the refetch fails", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect(startRecovery(chunkError())).toBe(true);
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("skips the refetch when no URL can be extracted", async () => {
    startRecovery(new Error("Importing a module script failed."));
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("lets the real error propagate on a repeat failure inside the window", async () => {
    startRecovery(chunkError());
    await flush();
    reload.mockClear();
    fetchMock.mockClear();

    const event = new Event("vite:preloadError", { cancelable: true });
    event.payload = chunkError();
    handlePreloadError(event);
    await flush();
    expect(event.defaultPrevented).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("recovers again after the 30s window", async () => {
    startRecovery(chunkError());
    await flush();
    reload.mockClear();
    vi.advanceTimersByTime(29_000);
    expect(startRecovery(chunkError())).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(startRecovery(chunkError())).toBe(true);
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
