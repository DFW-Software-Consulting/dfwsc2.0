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

vi.mock("../hooks/useClients", () => ({
  useClients: () => ({
    data: [
      {
        id: "cus_1",
        name: "Acme",
        email: "billing@acme.com",
        status: "active",
      },
    ],
    isLoading: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("../components/admin/AdminLogin", () => ({ default: () => <div>AdminLogin</div> }));
vi.mock("../components/admin/AdminSetup", () => ({ default: () => <div>AdminSetup</div> }));
vi.mock("../components/admin/BillingPanel", () => ({
  default: ({ workspace }) => <div>BillingPanel:{workspace}</div>,
}));
vi.mock("../components/admin/InvoicesDuePanel", () => ({
  default: () => <div>InvoicesDuePanel</div>,
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
vi.mock("../components/admin/ClientList", () => ({
  default: ({ workspace }) => <div>ClientList:{workspace}</div>,
}));
vi.mock("../components/admin/ClientProfile", () => ({
  default: ({ clientId }) => <div>ClientProfile:{clientId}</div>,
}));
vi.mock("../components/admin/AddClientModal", () => ({ default: () => null }));
vi.mock("../components/admin/SettingsPanel", () => ({ default: () => <div>SettingsPanel</div> }));
vi.mock("../components/admin/Toast", () => ({ default: () => null }));

describe("AdminDashboard workspace behavior", () => {
  it("defaults to Due in DFWSC and switches to portal tabs", async () => {
    renderWithProviders(<AdminDashboard />, { token: "admin-token" });

    expect(screen.getByRole("button", { name: "Due" })).toBeInTheDocument();
    expect(screen.getByText("InvoicesDuePanel")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Companies" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Client Portal" }));
    expect(screen.getByRole("button", { name: "Companies" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reports" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accounts" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Companies" }));
    expect(screen.getByText("GroupPanel:client_portal")).toBeInTheDocument();
  });
});
