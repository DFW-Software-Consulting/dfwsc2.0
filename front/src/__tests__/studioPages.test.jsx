import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Home from "../pages/Home.jsx";
import Pricing from "../pages/Pricing.jsx";
import Team, { MemberPhoto } from "../pages/Team.jsx";
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
    expect(screen.getByText("01 / 04")).toBeInTheDocument();

    await user.click(invoices);

    expect(invoices).toHaveAttribute("aria-pressed", "true");
    expect(requests).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("heading", { name: "Less chasing. More clarity." })
    ).toBeInTheDocument();
    expect(screen.getByText("Payment received")).toBeInTheDocument();
    expect(screen.getByText("02 / 04")).toBeInTheDocument();
  });

  it("shows the AI workflows tab as the fourth workflow", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Home />);

    const tabs = within(screen.getByRole("group", { name: "Workflow examples" }));
    const aiTab = tabs.getByRole("button", { name: "AI workflows" });
    expect(aiTab).toHaveAttribute("aria-pressed", "false");

    await user.click(aiTab);

    expect(aiTab).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("heading", { name: "Let AI handle the busywork." })
    ).toBeInTheDocument();
    expect(screen.getByText("Ready for review")).toBeInTheDocument();
    expect(screen.getByText("04 / 04")).toBeInTheDocument();
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
      expect(
        card.getByRole("link", { name: `${name} on LinkedIn (opens in a new tab)` })
      ).toBeInTheDocument();
      expect(card.getByText(role, { exact: false })).toBeInTheDocument();
      expect(card.getByText(focus, { exact: false })).toBeInTheDocument();
    }
  });

  it("names each photo after its member and drops the numbered badge", () => {
    renderWithProviders(<Team />, { initialEntries: ["/team"] });

    const photos = {
      "Jeremy Ashley": "jeremy-ashley",
      "Diego Espino": "diego-espino",
      "Hector Oropesa": "hector-oropesa",
    };
    for (const [name, file] of Object.entries(photos)) {
      const article = screen.getByRole("heading", { name }).closest("article");
      expect(article.querySelector(".studio-member-badge")).toHaveTextContent(name);
      const link = screen.getByRole("link", { name: `${name} on LinkedIn (opens in a new tab)` });
      expect(link.querySelector("img")).toHaveAttribute("src", expect.stringContaining(file));
    }
    expect(screen.queryByText(/\d{2} \/ DFWSC/)).not.toBeInTheDocument();
  });

  it("links each member's photo to their LinkedIn profile in a new tab", () => {
    renderWithProviders(<Team />, { initialEntries: ["/team"] });

    const profiles = {
      "Jeremy Ashley": "https://www.linkedin.com/in/dev-jc/",
      "Diego Espino": "https://www.linkedin.com/in/developerdiego/",
      "Hector Oropesa": "https://www.linkedin.com/in/hectororopesa/",
    };
    for (const [name, href] of Object.entries(profiles)) {
      const link = screen.getByRole("link", {
        name: `${name} on LinkedIn (opens in a new tab)`,
      });
      expect(link).toHaveAttribute("href", href);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(link.querySelector(".studio-member-badge svg")).toBeInTheDocument();
    }
    expect(document.querySelectorAll("#people a.studio-member-photo")).toHaveLength(3);
  });

  it("renders an unlinked photo with an icon-free badge when no LinkedIn profile is on file", () => {
    const { container } = renderWithProviders(
      <MemberPhoto name="No Profile" image="/member.jpg" linkedin={null} />
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector(".studio-member-photo")).toBeInTheDocument();
    expect(container.querySelector(".studio-member-badge")).toHaveTextContent("No Profile");
    expect(container.querySelector(".studio-member-badge svg")).toBeNull();
  });

  it("wraps a member's photo and badge in one LinkedIn link that opens a new tab", () => {
    const href = "https://www.linkedin.com/in/test-member";
    const { container } = renderWithProviders(
      <MemberPhoto name="Test Member" image="/member.jpg" linkedin={href} />
    );

    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    const link = screen.getByRole("link", {
      name: "Test Member on LinkedIn (opens in a new tab)",
    });
    expect(link).toHaveAttribute("href", href);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link.querySelector(".studio-member-badge")).toHaveTextContent("Test Member");
    expect(link.querySelector(".studio-member-badge svg")).toBeInTheDocument();
    expect(link.querySelector("img")).toHaveAttribute("src", "/member.jpg");
  });
});
