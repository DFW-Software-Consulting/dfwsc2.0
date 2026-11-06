import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import PricingHeroArt from "../components/PricingHeroArt.jsx";
import { ThemeProvider, useTheme } from "../contexts/ThemeContext.jsx";
import { runViewTransition } from "../utils/viewTransition.js";

function Toggle() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button type="button" onClick={toggleTheme}>
      {theme}
    </button>
  );
}

function mockReducedMotion(reduced) {
  window.matchMedia = vi.fn((query) => ({
    matches: reduced && query.includes("reduced-motion"),
    addEventListener() {},
    removeEventListener() {},
  }));
}

function renderToggle() {
  document.documentElement.className = "light";
  render(
    <ThemeProvider>
      <Toggle />
    </ThemeProvider>
  );
}

afterEach(() => {
  delete document.startViewTransition;
  delete document.documentElement.animate;
  document.documentElement.className = "";
  localStorage.clear();
});

describe("theme toggle with view transitions", () => {
  it("swaps instantly when startViewTransition is unsupported", async () => {
    mockReducedMotion(false);
    renderToggle();
    await userEvent.click(screen.getByRole("button"));
    expect(document.documentElement).toHaveClass("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
  });

  it("swaps instantly, without a transition, under reduced motion", async () => {
    mockReducedMotion(true);
    document.startViewTransition = vi.fn();
    renderToggle();
    await userEvent.click(screen.getByRole("button"));
    expect(document.startViewTransition).not.toHaveBeenCalled();
    expect(document.documentElement).toHaveClass("dark");
  });

  it("runs the change inside a view transition, reveals as a circle, and clears its class", async () => {
    mockReducedMotion(false);
    let finish;
    const finished = new Promise((resolve) => {
      finish = resolve;
    });
    document.startViewTransition = vi.fn((update) => {
      update();
      return { ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), finished };
    });
    document.documentElement.animate = vi.fn();
    renderToggle();
    await userEvent.click(screen.getByRole("button"));
    expect(document.startViewTransition).toHaveBeenCalledOnce();
    expect(document.documentElement).toHaveClass("dark", "theme-vt");
    await waitFor(() => expect(document.documentElement.animate).toHaveBeenCalled());
    expect(document.documentElement.animate.mock.calls[0][1].pseudoElement).toBe(
      "::view-transition-new(root)"
    );
    await act(async () => finish());
    expect(document.documentElement).not.toHaveClass("theme-vt");
  });
});

describe("runViewTransition", () => {
  it("runs update once when unsupported", () => {
    const update = vi.fn();
    runViewTransition(update, { className: "x" });
    expect(update).toHaveBeenCalledOnce();
  });

  it("keeps the class until the newest overlapping transition finishes", async () => {
    mockReducedMotion(false);
    const finishers = [];
    document.startViewTransition = vi.fn((update) => {
      update();
      return {
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        finished: new Promise((resolve, reject) => finishers.push({ resolve, reject })),
      };
    });
    runViewTransition(() => {}, { className: "route-vt" });
    runViewTransition(() => {}, { className: "route-vt" });
    // The first is skipped by the second and settles (here: rejects) while the second runs.
    await act(async () => finishers[0].reject(new Error("skipped")));
    expect(document.documentElement).toHaveClass("route-vt");
    await act(async () => finishers[1].resolve());
    expect(document.documentElement).not.toHaveClass("route-vt");
  });
});

describe("runViewTransition with a skipped transition", () => {
  const unhandled = vi.fn();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const skipped = () => new DOMException("Transition was skipped", "AbortError");

  afterEach(() => process.off("unhandledRejection", unhandled));

  function run(error, options) {
    unhandled.mockClear();
    process.on("unhandledRejection", unhandled);
    mockReducedMotion(false);
    document.startViewTransition = vi.fn(() => ({
      ready: Promise.reject(error),
      updateCallbackDone: Promise.reject(error),
      finished: Promise.reject(error),
    }));
    runViewTransition(() => {}, options);
  }

  it("swallows the AbortError on ready and updateCallbackDone and still cleans up", async () => {
    run(skipped(), { className: "route-vt", origin: document.body });
    expect(document.documentElement).toHaveClass("route-vt");
    await act(settle);
    expect(unhandled).not.toHaveBeenCalled();
    expect(document.documentElement).not.toHaveClass("route-vt");
  });

  it("still surfaces a real error thrown by the update callback", async () => {
    const boom = new Error("update failed");
    run(boom, { className: "theme-vt" });
    await act(settle);
    expect(unhandled).toHaveBeenCalledTimes(1);
    expect(unhandled.mock.calls[0][0]).toBe(boom);
    expect(document.documentElement).not.toHaveClass("theme-vt");
  });
});

describe("PricingHeroArt", () => {
  it("is hidden from assistive tech and has no focusable content", () => {
    const { container } = render(<PricingHeroArt />);
    const art = container.firstChild;
    expect(art).toHaveAttribute("aria-hidden", "true");
    expect(art.querySelector("a, button, [tabindex], text")).toBeNull();
  });
});
