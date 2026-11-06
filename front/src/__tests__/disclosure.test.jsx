import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import Disclosure from "../components/Disclosure.jsx";
import { faqItems, hostingPlans } from "../content/pricing.js";
import { teamMembers } from "../content/team.js";
import Pricing from "../pages/Pricing.jsx";
import Privacy from "../pages/Privacy.jsx";
import Team from "../pages/Team.jsx";
import { renderWithProviders } from "../test/renderWithProviders.jsx";

describe("Disclosure", () => {
  it("is a native details/summary with its content in the DOM while closed", () => {
    const { container } = render(
      <Disclosure summary="More">
        <p>Hidden words</p>
      </Disclosure>
    );
    const details = container.querySelector("details");
    expect(details).not.toHaveAttribute("open");
    expect(details.firstElementChild.tagName).toBe("SUMMARY");
    expect(screen.getByText("Hidden words")).toBeInTheDocument();
  });

  it("opens from its summary and can start open", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        <Disclosure summary="One">a</Disclosure>
        <Disclosure summary="Two" open>
          b
        </Disclosure>
      </>
    );
    const [one, two] = container.querySelectorAll("details");
    expect(two).toHaveAttribute("open");
    await user.click(screen.getByText("One"));
    expect(one).toHaveAttribute("open");
  });
});

describe("Disclosure open animation", () => {
  it("is not tagged on first render, even when open by default, only after a click", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        <Disclosure summary="Closed">a</Disclosure>
        <Disclosure summary="Starts open" open>
          b
        </Disclosure>
      </>
    );
    const [closed, open] = container.querySelectorAll("details");
    expect(closed).not.toHaveAttribute("data-animate");
    expect(open).not.toHaveAttribute("data-animate");
    await user.click(screen.getByText("Starts open"));
    expect(open).toHaveAttribute("data-animate");
    expect(closed).not.toHaveAttribute("data-animate");
  });
});

describe("pages keep collapsed copy in the document", () => {
  it("Pricing: allowances, includes and every FAQ answer", () => {
    renderWithProviders(<Pricing />, { initialEntries: ["/pricing"] });
    expect(screen.getByText("Compare allowances").closest("details")).not.toHaveAttribute("open");
    for (const plan of hostingPlans) expect(screen.getByText(plan.includes)).toBeInTheDocument();
    for (const { answer } of faqItems) expect(screen.getByText(answer)).toBeInTheDocument();
    expect(screen.queryByText(/proposed allowances for review/i)).not.toBeInTheDocument();
  });

  it("Team: bios sit behind Read more, with a member-specific name", () => {
    renderWithProviders(<Team />, { initialEntries: ["/team"] });
    for (const { name, bio } of teamMembers) {
      expect(screen.getByText(bio).closest("details")).not.toHaveAttribute("open");
      expect(screen.getByText(`about ${name}`, { exact: false })).toBeInTheDocument();
    }
  });

  it("Privacy: the cookies section is open", () => {
    renderWithProviders(<Privacy />, { initialEntries: ["/privacy"] });
    const cookies = screen.getByRole("heading", { name: "Analytics and cookies" });
    expect(cookies.closest("details")).toHaveAttribute("open");
  });
});
