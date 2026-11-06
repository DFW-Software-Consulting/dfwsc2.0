import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Footer from "../components/Footer.jsx";
import Navbar from "../components/Navbar.jsx";
import { ThemeProvider } from "../contexts/ThemeContext.jsx";
import { renderWithProviders } from "../test/renderWithProviders.jsx";

function renderShell(ui) {
  return renderWithProviders(<ThemeProvider>{ui}</ThemeProvider>);
}

beforeEach(() => {
  localStorage.setItem("theme", "light");
  document.documentElement.className = "";
  window.matchMedia = vi.fn(() => ({ matches: false }));
});

describe("Navbar mobile menu", () => {
  it("opens the menu it controls and closes it on Escape", async () => {
    const user = userEvent.setup();
    renderShell(<Navbar />);

    const toggle = screen.getByRole("button", { name: "Menu" });
    expect(toggle).toHaveAttribute("aria-controls", "mobile-menu");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("mobile-menu")).not.toBeInTheDocument();

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const menu = document.getElementById("mobile-menu");
    expect(menu).toHaveAccessibleName("Main");
    expect(within(menu).getByRole("link", { name: "Pricing" })).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("mobile-menu")).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });
});

describe("Navbar theme toggle", () => {
  it("names the theme it switches to and applies it", async () => {
    const user = userEvent.setup();
    renderShell(<Navbar />);

    // Desktop (aria-label) and mobile (visible text) toggles share the same name.
    const toggles = screen.getAllByRole("button", { name: "Switch to dark theme" });
    expect(toggles).toHaveLength(2);
    expect(document.documentElement).toHaveClass("light");

    await user.click(toggles[0]);

    expect(document.documentElement).toHaveClass("dark");
    expect(screen.getAllByRole("button", { name: "Switch to light theme" })).toHaveLength(2);
  });
});

describe("Footer", () => {
  it("labels its navigation and uses the navbar's section names", () => {
    renderShell(<Footer />);

    const nav = screen.getByRole("navigation", { name: "Footer" });
    expect(within(nav).getByRole("link", { name: "Solutions" })).toBeInTheDocument();
  });
});
