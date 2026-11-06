import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ClientList from "../components/admin/ClientList";
import { getOnboardingState } from "../components/admin/shared/onboardingState";
import { renderWithProviders } from "../test/renderWithProviders";

const clientRows = [
  { id: "c-new", name: "Not Started Co", email: "new@example.com", status: "active" },
  {
    id: "c-mid",
    name: "In Progress Co",
    email: "mid@example.com",
    status: "active",
    stripeAccountId: "acct_mid",
    chargesEnabled: false,
    detailsSubmitted: false,
  },
  {
    id: "c-done",
    name: "Ready Co",
    email: "done@example.com",
    status: "active",
    stripeAccountId: "acct_done",
    chargesEnabled: true,
    detailsSubmitted: true,
  },
];

const idleMutation = { mutate: vi.fn(), isPending: false, variables: undefined };
const resendMutate = vi.fn();
const resendMutation = { mutate: resendMutate, isPending: false, variables: undefined };

vi.mock("../hooks/useClients", () => ({
  useClients: () => ({ data: clientRows, isLoading: false, isError: false }),
  useDeleteClient: () => idleMutation,
  usePatchClientStatus: () => idleMutation,
  useResendOnboarding: () => resendMutation,
}));

vi.mock("../hooks/useGroups", () => ({
  useGroups: () => ({ data: [], isLoading: false, isError: false }),
}));

vi.mock("../hooks/useApiKey", () => ({
  useRequestApiKeyRegenerationAdmin: () => idleMutation,
}));

describe("getOnboardingState", () => {
  it("separates not started, in progress and ready to charge", () => {
    expect(getOnboardingState({})).toBe("not_started");
    expect(getOnboardingState({ stripeAccountId: "acct_1", chargesEnabled: false })).toBe(
      "in_progress"
    );
    expect(getOnboardingState({ stripeAccountId: "acct_1", chargesEnabled: true })).toBe("ready");
  });
});

describe("ClientList onboarding column", () => {
  function rowFor(name) {
    return screen.getByText(name).closest("tr");
  }

  it("shows three onboarding states instead of treating any Stripe account as complete", () => {
    renderWithProviders(<ClientList showToast={vi.fn()} />);

    expect(within(rowFor("Not Started Co")).getByText("Not started")).toBeInTheDocument();
    expect(within(rowFor("In Progress Co")).getByText("In progress")).toBeInTheDocument();
    expect(within(rowFor("Ready Co")).getByText("Ready to charge")).toBeInTheDocument();
  });

  it("enables Resend Link until charges are enabled", () => {
    renderWithProviders(<ClientList showToast={vi.fn()} />);

    const resend = (name) => within(rowFor(name)).getByRole("button", { name: /resend link/i });
    expect(resend("Not Started Co")).toBeEnabled();
    expect(resend("In Progress Co")).toBeEnabled();
    expect(resend("Ready Co")).toBeDisabled();
  });

  it("reports a client that finished onboarding instead of claiming a link was sent", () => {
    const showToast = vi.fn();
    resendMutate.mockImplementation((_vars, options) =>
      options.onSuccess({ alreadyOnboarded: true })
    );
    renderWithProviders(<ClientList showToast={showToast} />);

    fireEvent.click(within(rowFor("In Progress Co")).getByRole("button", { name: /resend link/i }));

    expect(showToast).toHaveBeenCalledWith(
      "Onboarding is already complete for this client.",
      "success"
    );
    expect(showToast).not.toHaveBeenCalledWith("New onboarding link sent successfully!", "success");
  });

  it("confirms the link was sent when the server issued a new one", () => {
    const showToast = vi.fn();
    resendMutate.mockImplementation((_vars, options) =>
      options.onSuccess({ message: "Onboarding link sent" })
    );
    renderWithProviders(<ClientList showToast={showToast} />);

    fireEvent.click(within(rowFor("Not Started Co")).getByRole("button", { name: /resend link/i }));

    expect(showToast).toHaveBeenCalledWith("New onboarding link sent successfully!", "success");
  });
});
