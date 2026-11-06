import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demos } from "../content/demos.js";
import Demos from "../pages/Demos.jsx";
import { PRIVATE_PATHS, PUBLIC_ROUTES, resolveMeta } from "../seo/meta.js";
import { renderWithProviders } from "../test/renderWithProviders.jsx";

beforeEach(() => {
  window.scrollTo = vi.fn();
});

describe("Demos", () => {
  it("renders a heading and one external link per demo", () => {
    renderWithProviders(<Demos />, { initialEntries: ["/demos"] });
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(demos.length + 1);
    for (const demo of demos) {
      const link = screen.getByRole("link", { name: new RegExp(demo.name) });
      expect(link).toHaveAttribute("href", demo.url);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("links back to the contact form", () => {
    renderWithProviders(<Demos />, { initialEntries: ["/demos"] });
    expect(screen.getByRole("link", { name: /start a project/i })).toHaveAttribute("href", "/");
  });

  it("is unlisted: noindex, and not in the sitemap routes", () => {
    expect(PRIVATE_PATHS).toContain("/demos");
    expect(PUBLIC_ROUTES["/demos"]).toBeUndefined();
    expect(resolveMeta("/demos").indexable).toBe(false);
  });
});
