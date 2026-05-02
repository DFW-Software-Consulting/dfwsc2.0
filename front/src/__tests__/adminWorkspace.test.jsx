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
vi.mock("../components/admin/GroupPanel", () => ({
  default: ({ workspace }) => <div>GroupPanel:{workspace}</div>,
}));
vi.mock("../components/admin/PaymentReports", () => ({
  default: ({ workspace }) => <div>PaymentReports:{workspace}</div>,
}));
vi.mock("../components/admin/ClientList", () => ({
  default: ({ workspace }) => <div>ClientList:{workspace}</div>,
}));
vi.mock("../components/admin/AddClientModal", () => ({ default: () => null }));
vi.mock("../components/admin/SettingsPanel", () => ({ default: () => <div>SettingsPanel</div> }));
vi.mock("../components/admin/Toast", () => ({ default: () => null }));

describe("AdminDashboard", () => {
  it("defaults to Accounts tab showing portal client list", () => {
    renderWithProviders(<AdminDashboard />, { token: "admin-token" });

    expect(screen.getByRole("button", { name: "Accounts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Companies" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reports" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("ClientList:client_portal")).toBeInTheDocument();
  });

  it("switches to Companies tab and shows GroupPanel", async () => {
    renderWithProviders(<AdminDashboard />, { token: "admin-token" });

    await userEvent.click(screen.getByRole("button", { name: "Companies" }));
    expect(screen.getByText("GroupPanel:client_portal")).toBeInTheDocument();
  });

  it("switches to Reports tab", async () => {
    renderWithProviders(<AdminDashboard />, { token: "admin-token" });

    await userEvent.click(screen.getByRole("button", { name: "Reports" }));
    expect(screen.getByText("PaymentReports:client_portal")).toBeInTheDocument();
  });

  it("switches to Settings tab", async () => {
    renderWithProviders(<AdminDashboard />, { token: "admin-token" });

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("SettingsPanel")).toBeInTheDocument();
  });
});
