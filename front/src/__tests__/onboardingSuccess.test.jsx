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
    expect(screen.getByText(/reopen the onboarding link from your email/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /onboarding complete/i })).not.toBeInTheDocument();
  });
});
