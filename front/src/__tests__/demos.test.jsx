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
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(demos.length);
    for (const demo of demos) {
      const link = screen.getByRole("link", { name: new RegExp(demo.name) });
      expect(link).toHaveAttribute("href", demo.url);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("makes the whole card one link with an accessible name, and shows the preview image", () => {
    const { container } = renderWithProviders(<Demos />, { initialEntries: ["/demos"] });
    const first = demos[0];
    const link = screen.getByRole("link", {
      name: `View ${first.name} live demo (opens in a new tab)`,
    });
    expect(link).toContainElement(screen.getByRole("heading", { name: first.name }));
    expect(link.querySelectorAll("a, button")).toHaveLength(0);
    const img = link.querySelector("img");
    expect(img).toHaveAttribute("src", first.image);
    expect(img).toHaveAttribute("width");
    expect(img).toHaveAttribute("height");
    expect(img).toHaveAttribute("decoding", "async");
    expect(container.querySelectorAll(".demo-card img").length).toBeGreaterThanOrEqual(
      demos.length
    );
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
