import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../content/demos.js", () => ({
  demos: [
    {
      name: "Alpha Co",
      industry: "Cafe",
      description: "Coffee.",
      url: "https://example.github.io/alpha/",
      icon: "utensils",
      image: "/alpha.webp",
      scrollImage: "/alpha-tall.webp",
    },
    {
      name: "Beta Co",
      industry: "Shop",
      description: "Goods.",
      url: "https://example.github.io/beta/",
      icon: "leaf",
      image: null,
    },
  ],
}));

import { demos } from "../content/demos.js";
import Demos from "../pages/Demos.jsx";
import { PRIVATE_PATHS, PUBLIC_ROUTES, resolveMeta } from "../seo/meta.js";
import { renderWithProviders } from "../test/renderWithProviders.jsx";

function mockHover(matches) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  mockHover(false);
});

const cardLink = (demo) => screen.getByRole("link", { name: new RegExp(demo.name) });

describe("Demos", () => {
  it("renders a heading and one external link per demo", () => {
    renderWithProviders(<Demos />, { initialEntries: ["/demos"] });
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(demos.length);
    for (const demo of demos) {
      const link = cardLink(demo);
      expect(link).toHaveAttribute("href", demo.url);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("names the link from its visible text (label in name) and flags the new tab", () => {
    renderWithProviders(<Demos />, { initialEntries: ["/demos"] });
    const link = cardLink(demos[0]);
    expect(link).not.toHaveAttribute("aria-label");
    expect(link).toHaveAccessibleName(/View live demo/);
    expect(link).toHaveAccessibleName(/\(opens in a new tab\)/);
    expect(link.querySelectorAll("a, button")).toHaveLength(0);
    expect(within(link).getByRole("heading", { name: "Alpha Co" })).toBeInTheDocument();
  });

  it("shows one decorative, eager, sized preview image in a hidden frame", () => {
    renderWithProviders(<Demos />, { initialEntries: ["/demos"] });
    const link = cardLink(demos[0]);
    const imgs = link.querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toHaveAttribute("src", "/alpha.webp");
    expect(imgs[0]).toHaveAttribute("alt", "");
    expect(imgs[0]).toHaveAttribute("width", "1200");
    expect(imgs[0]).toHaveAttribute("height", "750");
    expect(imgs[0]).toHaveAttribute("loading", "eager");
    expect(imgs[0]).toHaveAttribute("decoding", "async");
    expect(link.querySelector(".demo-card-frame")).toHaveAttribute("aria-hidden", "true");
    expect(link.querySelector(".demo-card-address")).toHaveTextContent("example.github.io/alpha");
  });

  it("falls back to the icon when a demo has no image", () => {
    renderWithProviders(<Demos />, { initialEntries: ["/demos"] });
    const link = cardLink(demos[1]);
    expect(link.querySelectorAll("img")).toHaveLength(0);
    expect(link.querySelector(".demo-card-media svg")).toBeInTheDocument();
  });

  it("does not render the tall image until hover or focus, and only when hover previews are on", () => {
    renderWithProviders(<Demos />, { initialEntries: ["/demos"] });
    const link = cardLink(demos[0]);
    expect(link.querySelector(".demo-card-scroll")).toBeNull();
    fireEvent.pointerEnter(link);
    expect(link.querySelector(".demo-card-scroll")).toBeNull();
  });

  it("mounts the tall image on pointer-enter when hover previews are on", () => {
    mockHover(true);
    renderWithProviders(<Demos />, { initialEntries: ["/demos"] });
    const link = cardLink(demos[0]);
    fireEvent.pointerEnter(link);
    const tall = link.querySelector(".demo-card-scroll");
    expect(tall).toHaveAttribute("src", "/alpha-tall.webp");
    expect(tall).toHaveAttribute("alt", "");
    expect(tall).toHaveAttribute("width", "900");
    expect(tall).toHaveAttribute("height", "2250");
    expect(link.querySelectorAll("img")).toHaveLength(2);
    expect(cardLink(demos[1]).querySelector(".demo-card-scroll")).toBeNull();
  });

  it("mounts the tall image on keyboard focus too", () => {
    mockHover(true);
    renderWithProviders(<Demos />, { initialEntries: ["/demos"] });
    const link = cardLink(demos[0]);
    fireEvent.focus(link);
    expect(link.querySelector(".demo-card-scroll")).toBeInTheDocument();
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
