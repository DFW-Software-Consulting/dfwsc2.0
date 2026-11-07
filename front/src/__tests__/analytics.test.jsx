import { act, render } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loaderSelector = 'script[data-analytics-loader="dfwsc"]';

async function renderAnalytics({ src, domain, path = "/" } = {}) {
  vi.resetModules();
  vi.stubEnv("VITE_ANALYTICS_SRC", src ?? "");
  vi.stubEnv("VITE_ANALYTICS_DOMAIN", domain ?? "");
  const { default: Analytics } = await import("../components/Analytics");
  let navigate;
  function Nav() {
    navigate = useNavigate();
    return null;
  }
  const result = render(
    <MemoryRouter initialEntries={[path]}>
      <Analytics />
      <Nav />
    </MemoryRouter>
  );
  return { ...result, navigate: (to) => act(() => navigate(to)) };
}

const reload = vi.fn();
const realLocation = window.location;

beforeEach(() => {
  reload.mockClear();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...realLocation, reload },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
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

  it.each(["/admin", "/admin/", "/admin/clients"])("does not load on %s", async (path) => {
    await renderAnalytics({ src: "https://metrics.example/script.js", path });

    expect(document.querySelector(loaderSelector)).not.toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it("still loads on a lookalike path such as /administrator", async () => {
    await renderAnalytics({ src: "https://metrics.example/script.js", path: "/administrator" });

    expect(document.querySelector(loaderSelector)).toBeInTheDocument();
  });

  it("reloads when navigating client-side from a tracked page into /admin", async () => {
    const { navigate } = await renderAnalytics({ src: "https://metrics.example/script.js" });
    expect(document.querySelector(loaderSelector)).toBeInTheDocument();

    navigate("/admin");

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not load on marketing pages after visiting /admin", async () => {
    const { navigate } = await renderAnalytics({
      src: "https://metrics.example/script.js",
      path: "/admin",
    });

    navigate("/pricing");

    expect(document.querySelector(loaderSelector)).not.toBeInTheDocument();
  });

  it("loads again on a marketing route in a fresh document", async () => {
    await renderAnalytics({ src: "https://metrics.example/script.js", path: "/pricing" });

    expect(document.querySelector(loaderSelector)).toBeInTheDocument();
  });
});
