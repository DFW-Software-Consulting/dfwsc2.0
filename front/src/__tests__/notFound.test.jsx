import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import NotFound from "../pages/NotFound";

describe("NotFound", () => {
  it("renders the 404 message and a link home", () => {
    render(<NotFound />, { wrapper: MemoryRouter });

    expect(screen.getByRole("heading", { name: /page not found/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to home/i })).toHaveAttribute("href", "/");
  });

  it("renders when a route is unmatched via the wildcard route", () => {
    render(
      <MemoryRouter initialEntries={["/this-route-does-not-exist"]}>
        <Routes>
          <Route path="/" element={<div>Home</div>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByRole("heading", { name: /page not found/i })).toBeInTheDocument();
  });
});

describe("NotFound layout", () => {
  it("offers real calls to action and a decorative route drawing", () => {
    const { container } = render(<NotFound />, { wrapper: MemoryRouter });
    expect(screen.getByRole("link", { name: /contact us/i })).toBeInTheDocument();
    expect(container.querySelector(".studio-notfound")).toBeInTheDocument();
    expect(container.querySelector("svg.studio-lost-route")).toHaveAttribute("aria-hidden", "true");
  });
});
