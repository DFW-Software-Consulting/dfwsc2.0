import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Privacy from "../pages/Privacy.jsx";
import { renderWithProviders } from "../test/renderWithProviders.jsx";

beforeEach(() => {
  window.scrollTo = vi.fn();
});

describe("Privacy", () => {
  it("renders the page, sets the title and links the contact address", () => {
    renderWithProviders(<Privacy />, { initialEntries: ["/privacy"] });
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/last updated: november 5, 2026/i)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "mail@dfwsc.com" })[0]).toHaveAttribute(
      "href",
      "mailto:mail@dfwsc.com"
    );
  });

  it("discloses the theme preference and the session-storage reload flag", () => {
    renderWithProviders(<Privacy />, { initialEntries: ["/privacy"] });
    expect(screen.getByText(/light or dark theme preference/)).toBeInTheDocument();
    expect(screen.getByText(/session storage/)).toBeInTheDocument();
    expect(screen.getByText(/clears it\s+when you close the tab/)).toBeInTheDocument();
  });

  it("states that no analytics or tracking is used", () => {
    renderWithProviders(<Privacy />, { initialEntries: ["/privacy"] });
    expect(
      screen.getByText(/We don't use analytics, tracking scripts, or tracking cookies\./)
    ).toBeInTheDocument();
    expect(screen.getByText(/kept\s+only in memory in your browser/)).toBeInTheDocument();
    expect(screen.queryByText(/plausible/i)).not.toBeInTheDocument();
  });
});
