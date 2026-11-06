import { render, screen, waitFor } from "@testing-library/react";
import { lazy, Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ErrorBoundary from "../components/ErrorBoundary";
import {
  handlePreloadError,
  isRecovering,
  resetRecovering,
  startRecovery,
} from "../utils/preloadRecovery";

function Bomb() {
  throw new Error("boom");
}

describe("ErrorBoundary", () => {
  it("renders fallback UI when a child throws", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();

    consoleSpy.mockRestore();
  });

  it("renders children when there is no error", () => {
    render(
      <ErrorBoundary>
        <div>All good</div>
      </ErrorBoundary>
    );

    expect(screen.getByText("All good")).toBeInTheDocument();
  });

  describe("chunk-load errors", () => {
    const reload = vi.fn();
    const fetchMock = vi.fn();
    const chunkErr = () =>
      new TypeError("Failed to fetch dynamically imported module: /assets/D.js");
    const ChunkBomb = () => {
      throw new TypeError(
        "Failed to fetch dynamically imported module: https://dfwsc.com/assets/Demos-abc.js"
      );
    };

    beforeEach(() => {
      sessionStorage.clear();
      resetRecovering();
      reload.mockClear();
      fetchMock.mockReset().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal("location", { ...window.location, reload });
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it("refetches the asset and reloads once instead of showing the error UI", async () => {
      render(
        <ErrorBoundary>
          <ChunkBomb />
        </ErrorBoundary>
      );
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenCalledWith(
        "https://dfwsc.com/assets/Demos-abc.js",
        expect.objectContaining({ cache: "reload" })
      );
      expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
    });

    it("falls through to the normal UI when recovery already ran", async () => {
      sessionStorage.setItem("preload-reloaded-at", String(Date.now()));
      render(
        <ErrorBoundary>
          <ChunkBomb />
        </ErrorBoundary>
      );
      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
      expect(reload).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("stays blank for the TypeError React.lazy throws after a prevented preload error", async () => {
      const Lazy = lazy(() => Promise.resolve(undefined));
      // A prevented vite:preloadError starts recovery, then the import resolves to undefined.
      const event = new Event("vite:preloadError", { cancelable: true });
      event.payload = new Error("Unable to preload CSS for /assets/a.css");
      handlePreloadError(event);
      expect(isRecovering()).toBe(true);
      const { container } = render(
        <ErrorBoundary>
          <Suspense fallback={null}>
            <Lazy />
          </Suspense>
        </ErrorBoundary>
      );
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
    });

    it("stays blank when a second chunk error hits the guard mid-recovery (CSS plus JS)", async () => {
      const first = new Event("vite:preloadError", { cancelable: true });
      first.payload = new Error("Unable to preload CSS for /assets/a.css");
      handlePreloadError(first);
      // The JS chunk then fails too; the 30s guard blocks a second recovery.
      expect(startRecovery(chunkErr())).toBe(false);
      const { container } = render(
        <ErrorBoundary>
          <ChunkBomb />
        </ErrorBoundary>
      );
      expect(container).toBeEmptyDOMElement();
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    });

    it("stays blank when theme-init.js already started the recovery", () => {
      // theme-init sees the modulepreload link error first, so the app's own guard blocks.
      window.__dfwscRecovering = true;
      sessionStorage.setItem("preload-reloaded-at", String(Date.now()));
      const { container } = render(
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>
      );
      expect(container).toBeEmptyDOMElement();
    });

    it("does not recover from non-chunk errors", () => {
      render(
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>
      );
      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
      expect(reload).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
