import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Home from "../pages/Home.jsx";
import Pricing from "../pages/Pricing.jsx";
import Team from "../pages/Team.jsx";
import { renderWithProviders } from "../test/renderWithProviders.jsx";

beforeEach(() => {
  window.scrollTo = vi.fn();
});

describe("Home", () => {
  it("renders the hero and the main sections", () => {
    renderWithProviders(<Home />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("One dev team.");
    for (const id of ["top", "services", "values", "mission", "contact"]) {
      expect(document.getElementById(id)).toBeInTheDocument();
    }
  });

  it("switches the workflow preview when a tab is pressed", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Home />);

    const tabs = within(screen.getByRole("group", { name: "Workflow examples" }));
    const requests = tabs.getByRole("button", { name: "Client requests" });
    const invoices = tabs.getByRole("button", { name: "Invoices" });

    expect(requests).toHaveAttribute("aria-pressed", "true");
    expect(invoices).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("01 / 03")).toBeInTheDocument();

    await user.click(invoices);

    expect(invoices).toHaveAttribute("aria-pressed", "true");
    expect(requests).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("heading", { name: "Less chasing. More clarity." })
    ).toBeInTheDocument();
    expect(screen.getByText("Payment received")).toBeInTheDocument();
    expect(screen.getByText("02 / 03")).toBeInTheDocument();
  });

  it("counts the workflows from the tabs it renders", () => {
    renderWithProviders(<Home />);

    const tabs = within(screen.getByRole("group", { name: "Workflow examples" }));
    const total = String(tabs.getAllByRole("button").length).padStart(2, "0");
    expect(screen.getByText(`01 / ${total}`)).toBeInTheDocument();
  });

  it("announces only the workflow title when it changes", () => {
    renderWithProviders(<Home />);

    const live = document.querySelectorAll("[aria-live]");
    expect(live).toHaveLength(1);
    expect(live[0]).toHaveTextContent("A clearer path from request to done.");
  });
});

describe("Pricing", () => {
  it("lists each hosting plan with its monthly price", () => {
    renderWithProviders(<Pricing />, { initialEntries: ["/pricing"] });

    const expected = [
      ["Basic Hosting", "$40"],
      ["Pro Hosting", "$100"],
      ["Business Hosting", "$200"],
    ];
    for (const [name, price] of expected) {
      const card = screen.getByRole("heading", { name }).closest("article");
      expect(card.querySelector(".studio-plan-price")).toHaveTextContent(`${price} / month`);
    }
  });

  it("presents the dev retainer as the ongoing partnership option", () => {
    renderWithProviders(<Pricing />, { initialEntries: ["/pricing"] });

    const retainer = screen.getByText(/Dev Retainer · AN ONGOING PARTNERSHIP/).closest("article");
    expect(retainer.querySelector(".studio-engagement-price")).toHaveTextContent(
      "Custom based on your needs"
    );
  });
});

describe("Team", () => {
  it("keeps each member's role, intro and focus together", () => {
    renderWithProviders(<Team />, { initialEntries: ["/team"] });

    const members = [
      ["Jeremy Ashley", "Founder & CTO", "Discovery · Technical direction"],
      ["Diego Espino", "Full Stack & DevOps Engineer", "Deployment · Performance"],
      ["Hector Oropesa", "DevOps & Network Engineer", "Cloud systems · Networking"],
    ];
    for (const [name, role, focus] of members) {
      const article = screen.getByRole("heading", { name }).closest("article");
      const card = within(article);
      expect(card.getByRole("img", { name })).toBeInTheDocument();
      expect(card.getByText(role, { exact: false })).toBeInTheDocument();
      expect(card.getByText(focus, { exact: false })).toBeInTheDocument();
    }
  });
});
