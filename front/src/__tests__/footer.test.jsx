import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Footer from "../components/Footer.jsx";

vi.mock("../utils/scrollToSection.js", () => ({ scrollToTop: vi.fn() }));

import { scrollToTop } from "../utils/scrollToSection.js";

function renderFooter() {
  return render(
    <MemoryRouter>
      <Footer />
    </MemoryRouter>
  );
}

describe("Footer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 18:45 UTC on 2026-03-01 is 12:45 PM in Dallas (CST).
    vi.setSystemTime(new Date("2026-03-01T18:45:30Z"));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("lists each link once inside the Footer nav and never links admin", () => {
    renderFooter();
    const nav = screen.getByRole("navigation", { name: "Footer" });
    const hrefs = Array.from(nav.querySelectorAll("a")).map((a) => a.getAttribute("href"));

    expect(hrefs).toEqual([
      "/",
      "/",
      "/pricing",
      "/team",
      "tel:+12143260128",
      "mailto:mail@dfwsc.com",
      "https://github.com/DFW-Software-Consulting",
    ]);
    expect(hrefs.some((h) => h.includes("admin"))).toBe(false);
    expect(screen.getAllByText("mail@dfwsc.com")).toHaveLength(1);
    expect(screen.getAllByText("Solutions")).toHaveLength(1);
    expect(screen.getAllByText("GitHub")).toHaveLength(1);
  });

  it("omits LinkedIn and the hidden developer docs link", () => {
    const { container } = renderFooter();
    expect(screen.queryByRole("link", { name: /linkedin/i })).toBeNull();
    expect(container.querySelector('a[href*="linkedin.com"]')).toBeNull();
    expect(screen.queryByText("Developer docs")).toBeNull();
    expect(container.querySelector('a[href="/docs"]')).toBeNull();
  });

  it("shows Dallas local time and advances on the minute", () => {
    renderFooter();
    expect(screen.getByText(/Dallas, TX · 12:45\sPM/)).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(30000);
    });
    expect(screen.getByText(/Dallas, TX · 12:46\sPM/)).toBeTruthy();
  });

  it("stops the clock on unmount", () => {
    const { unmount } = renderFooter();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("scrolls to the top from the back-to-top button", () => {
    renderFooter();
    fireEvent.click(screen.getByRole("button", { name: /back to top/i }));
    expect(scrollToTop).toHaveBeenCalledTimes(1);
  });
});
