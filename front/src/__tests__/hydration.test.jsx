import { act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import Footer from "../components/Footer.jsx";
import { Reveal } from "../components/motion/Reveal.jsx";
import { ThemeProvider, useTheme } from "../contexts/ThemeContext.jsx";

function Probe() {
  const { theme } = useTheme();
  return (
    <div>
      <p data-testid="theme">{theme}</p>
      <Reveal as="p">Revealed copy</Reveal>
      <MemoryRouter>
        <Footer />
      </MemoryRouter>
    </div>
  );
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  vi.restoreAllMocks();
});

describe("hydration of browser-dependent UI", () => {
  it("hydrates a prerendered page without mismatches, then applies the stored theme", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    // What the prerender produces: no storage, no clock, light theme.
    const serverHtml = renderToString(
      <ThemeProvider hydrating>
        <Probe />
      </ThemeProvider>
    );
    expect(serverHtml).toContain("Revealed copy");
    expect(serverHtml).not.toContain("opacity:0");

    localStorage.setItem("theme", "dark");
    document.documentElement.classList.add("dark"); // what theme-init.js does
    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.appendChild(container);

    await act(async () => {
      hydrateRoot(
        container,
        <ThemeProvider hydrating>
          <Probe />
        </ThemeProvider>
      );
    });

    // renderToString under jsdom always warns about layout effects (react-router); anything
    // else, such as a hydration mismatch, is a failure.
    expect(
      errors.mock.calls.filter(([message]) => !String(message).includes("useLayoutEffect"))
    ).toEqual([]);
    expect(container.querySelector('[data-testid="theme"]').textContent).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(container.textContent).toContain("Dallas, TX ·");
    // theme-init.js sets the class before hydration; the placeholder "light" must not undo it.
    expect(document.documentElement.classList.contains("light")).toBe(false);
    container.remove();
  });

  it("only persists the theme after the visitor chooses one", async () => {
    const { render, screen } = await import("@testing-library/react");
    function Toggle() {
      const { theme, toggleTheme } = useTheme();
      return (
        <button type="button" onClick={toggleTheme}>
          {theme}
        </button>
      );
    }
    render(
      <ThemeProvider>
        <Toggle />
      </ThemeProvider>
    );
    expect(localStorage.getItem("theme")).toBeNull();
    await act(async () => screen.getByRole("button").click());
    expect(localStorage.getItem("theme")).toBe(screen.getByRole("button").textContent);
  });
});
