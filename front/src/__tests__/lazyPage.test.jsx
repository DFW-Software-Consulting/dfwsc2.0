import { render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";
import ErrorBoundary from "../components/ErrorBoundary.jsx";
import { lazyPage } from "../utils/lazyPage.js";

function renderPage(load) {
  const Page = lazyPage(load);
  return render(
    <ErrorBoundary>
      <Suspense fallback={<div>loading</div>}>
        <Page />
      </Suspense>
    </ErrorBoundary>
  );
}

describe("lazyPage", () => {
  it("renders the page when the module loads", async () => {
    renderPage(() => Promise.resolve({ default: () => <div>page body</div> }));
    expect(await screen.findByText("page body")).toBeInTheDocument();
  });

  it("stays suspended when a suppressed preload error resolves the import with undefined", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderPage(() => Promise.resolve(undefined));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByText("loading")).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it("still lets a rejected import reach the error boundary", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderPage(() => Promise.reject(new Error("chunk failed")));
    expect(await screen.findByText("Something went wrong")).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
