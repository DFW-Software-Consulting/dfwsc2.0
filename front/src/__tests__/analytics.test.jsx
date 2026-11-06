import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const loaderSelector = 'script[data-analytics-loader="dfwsc"]';

async function renderAnalytics({ src, domain } = {}) {
  vi.resetModules();
  vi.stubEnv("VITE_ANALYTICS_SRC", src ?? "");
  vi.stubEnv("VITE_ANALYTICS_DOMAIN", domain ?? "");
  const { default: Analytics } = await import("../components/Analytics");
  return render(<Analytics />);
}

afterEach(() => {
  document.querySelectorAll(loaderSelector).forEach((script) => {
    script.remove();
  });
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Analytics", () => {
  it("does not inject a script when analytics is not configured", async () => {
    await renderAnalytics();

    expect(document.querySelector(loaderSelector)).not.toBeInTheDocument();
  });

  it("injects the configured script and removes the script it owns on unmount", async () => {
    const { unmount } = await renderAnalytics({
      src: "https://metrics.example/script.js",
      domain: "dfwsc.com",
    });

    const script = document.querySelector(loaderSelector);
    expect(script).toHaveAttribute("src", "https://metrics.example/script.js");
    expect(script).toHaveAttribute("defer");
    expect(script).toHaveAttribute("data-domain", "dfwsc.com");

    unmount();
    expect(document.querySelector(loaderSelector)).not.toBeInTheDocument();
  });

  it("does not duplicate or remove an existing analytics loader", async () => {
    const existing = document.createElement("script");
    existing.dataset.analyticsLoader = "dfwsc";
    document.head.appendChild(existing);

    const { unmount } = await renderAnalytics({ src: "https://metrics.example/script.js" });

    expect(document.querySelectorAll(loaderSelector)).toHaveLength(1);
    unmount();
    expect(document.querySelector(loaderSelector)).toBe(existing);
  });
});
