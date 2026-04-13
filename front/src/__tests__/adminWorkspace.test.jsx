import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import AdminDashboard from "../components/admin/AdminDashboard";
import { renderWithProviders } from "../test/renderWithProviders";

vi.mock("../hooks/useSetupStatus", () => ({
  useSetupStatus: () => ({
    bootstrapPending: false,
    adminConfigured: true,
    requiresSetup: false,
    isLoading: false,
    error: null,
  }),
}));

vi.mock("../components/admin/AdminLogin", () => ({ default: () => <div>AdminLogin</div> }));
vi.mock("../components/admin/AdminSetup", () => ({ default: () => <div>AdminSetup</div> }));
vi.mock("../components/admin/BillingPanel", () => ({
  default: ({ workspace }) => <div>BillingPanel:{workspace}</div>,
}));
vi.mock("../components/admin/ClientList", () => ({
  default: ({ workspace }) => <div>ClientList:{workspace}</div>,
}));
vi.mock("../components/admin/CreateClientForm", () => ({
  default: ({ workspace }) => <div>CreateClientForm:{workspace}</div>,
}));
vi.mock("../components/admin/GroupPanel", () => ({
  default: ({ workspace }) => <div>GroupPanel:{workspace}</div>,
}));
vi.mock("../components/admin/ImportStripeCustomer", () => ({
  default: ({ workspace }) => <div>ImportStripeCustomer:{workspace}</div>,
}));
vi.mock("../components/admin/PaymentReports", () => ({
  default: ({ workspace }) => <div>PaymentReports:{workspace}</div>,
}));
vi.mock("../components/admin/SettingsPanel", () => ({ default: () => <div>SettingsPanel</div> }));
vi.mock("../components/admin/Toast", () => ({ default: () => null }));

describe("AdminDashboard workspace behavior", () => {
  it("hides Companies in DFWSC and shows it in Client Portal", async () => {
    renderWithProviders(<AdminDashboard />, { token: "admin-token" });

    expect(screen.queryByRole("button", { name: "Companies" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accounts" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reports" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Billing" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Client Portal" }));
    expect(screen.getByRole("button", { name: "Companies" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reports" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Companies" }));
    expect(screen.getByText("GroupPanel:client_portal")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "DFWSC Services" }));
    expect(screen.queryByRole("button", { name: "Companies" })).not.toBeInTheDocument();
    expect(screen.queryByText("GroupPanel:client_portal")).not.toBeInTheDocument();
    expect(screen.getByText("CreateClientForm:dfwsc_services")).toBeInTheDocument();
  });
});
