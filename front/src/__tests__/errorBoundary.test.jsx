import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ErrorBoundary from "../components/ErrorBoundary";

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
    const ChunkBomb = () => {
      throw new TypeError(
        "Failed to fetch dynamically imported module: https://dfwsc.com/assets/Demos-abc.js"
      );
    };

    beforeEach(() => {
      sessionStorage.clear();
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
