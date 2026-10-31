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
    expect(screen.getByText(/last updated: october 31, 2026/i)).toBeInTheDocument();
    expect(document.title).toBe("Privacy - DFW Software Consulting");
    expect(screen.getAllByRole("link", { name: "mail@dfwsc.com" })[0]).toHaveAttribute(
      "href",
      "mailto:mail@dfwsc.com"
    );
  });
});
