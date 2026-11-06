import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import OnboardingSuccess from "../pages/OnboardingSuccess";

const renderAt = (url) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <OnboardingSuccess />
    </MemoryRouter>
  );

describe("OnboardingSuccess", () => {
  it("renders the success message by default", () => {
    renderAt("/onboarding-success");

    expect(screen.getByRole("heading", { name: /onboarding complete/i })).toBeInTheDocument();
    expect(screen.queryByText(/setup session timed out/i)).not.toBeInTheDocument();
  });

  it("renders the success message for status=completed", () => {
    renderAt("/onboarding-success?status=completed");

    expect(screen.getByRole("heading", { name: /onboarding complete/i })).toBeInTheDocument();
  });

  it("renders a neutral timeout message for status=expired", () => {
    renderAt("/onboarding-success?status=expired");

    expect(
      screen.getByRole("heading", { name: /your setup session timed out/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/your details were saved/i)).toBeInTheDocument();
    expect(screen.getByText(/we'll send you a new one/i)).toBeInTheDocument();
    expect(screen.queryByText(/reopen the onboarding link/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /onboarding complete/i })).not.toBeInTheDocument();
  });

  it("renders a neutral in-progress message for status=pending", () => {
    renderAt("/onboarding-success?status=pending");

    expect(
      screen.getByRole("heading", { name: "Your Stripe setup isn't finished yet" })
    ).toBeInTheDocument();
    expect(screen.getByText(/stripe is still verifying your details/i)).toBeInTheDocument();
    expect(screen.getByText(/reopen the onboarding link from your email/i)).toBeInTheDocument();
    expect(
      screen.getByText(/reply to the onboarding email or contact our team/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /onboarding complete/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/setup session timed out/i)).not.toBeInTheDocument();
    expect(document.title).toBe("Stripe Setup Not Finished - DFW Software Consulting");
  });

  it("renders a could-not-confirm message for status=error", () => {
    renderAt("/onboarding-success?status=error");

    expect(
      screen.getByRole("heading", { name: "We couldn't confirm your setup just now" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/we had trouble checking your account with stripe/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/your details are saved/i)).toBeInTheDocument();
    expect(
      screen.getByText(/if you don't hear from us, reply to the onboarding email/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/reply to the onboarding email or contact our team/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /onboarding complete/i })).not.toBeInTheDocument();
    expect(document.title).toBe("Setup Not Confirmed - DFW Software Consulting");
  });

  it("still renders the success message for an unknown status", () => {
    renderAt("/onboarding-success?status=whatever");

    expect(screen.getByRole("heading", { name: /onboarding complete/i })).toBeInTheDocument();
    expect(screen.queryByText(/isn't finished yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn't confirm your setup/i)).not.toBeInTheDocument();
    expect(document.title).toBe("Onboarding Complete - DFW Software Consulting");
  });

  it("does not treat Object.prototype keys as a state", () => {
    renderAt("/onboarding-success?status=constructor");

    expect(screen.getByRole("heading", { name: /onboarding complete/i })).toBeInTheDocument();
  });
});
