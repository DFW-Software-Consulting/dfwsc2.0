import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminDashboard from "../components/admin/AdminDashboard";
import { renderWithProviders } from "../test/renderWithProviders";

const mockUseSetupStatus = vi.fn(() => ({
  adminConfigured: true,
  requiresSetup: false,
  isLoading: false,
  error: null,
}));

vi.mock("../hooks/useSetupStatus", () => ({
  useSetupStatus: () => mockUseSetupStatus(),
}));

vi.mock("../components/admin/AdminLogin", () => ({ default: () => <div>AdminLogin</div> }));
vi.mock("../components/admin/AdminSetup", () => ({
  default: ({ isBootstrapPending, token }) => (
    <div>
      AdminSetup:{isBootstrapPending ? "confirm" : "create"}:{String(token)}
    </div>
  ),
}));
vi.mock("../components/admin/GroupPanel", () => ({
  default: ({ workspace }) => <div>GroupPanel:{workspace}</div>,
}));
vi.mock("../components/admin/PaymentReports", () => ({
  default: ({ workspace }) => <div>PaymentReports:{workspace}</div>,
}));
vi.mock("../components/admin/ClientList", () => ({
  default: ({ workspace }) => <div>ClientList:{workspace}</div>,
}));
vi.mock("../components/admin/SettingsPanel", () => ({ default: () => <div>SettingsPanel</div> }));
vi.mock("../components/admin/Toast", () => ({ default: () => null }));

describe("AdminDashboard", () => {
  afterEach(() => {
    sessionStorage.clear();
    mockUseSetupStatus.mockReturnValue({
      adminConfigured: true,
      requiresSetup: false,
      isLoading: false,
      error: null,
    });
  });

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

  it("renders AdminSetup in create mode when unauthenticated and setup is required", () => {
    mockUseSetupStatus.mockReturnValue({
      adminConfigured: false,
      requiresSetup: true,
      isLoading: false,
      error: null,
    });

    renderWithProviders(<AdminDashboard />, { token: null });

    expect(screen.getByText("AdminSetup:create:undefined")).toBeInTheDocument();
    expect(screen.queryByText("AdminLogin")).not.toBeInTheDocument();
  });

  it("renders AdminLogin (not a dead-end) when unauthenticated and admin is not yet configured", () => {
    mockUseSetupStatus.mockReturnValue({
      adminConfigured: false,
      requiresSetup: false,
      isLoading: false,
      error: null,
    });

    renderWithProviders(<AdminDashboard />, { token: null });

    expect(screen.getByText("AdminLogin")).toBeInTheDocument();
    expect(screen.queryByText(/Unable to load admin state/)).not.toBeInTheDocument();
  });

  it("renders AdminSetup in confirm mode with token when logged in and bootstrap is pending", () => {
    sessionStorage.setItem("adminBootstrapPending", "1");

    renderWithProviders(<AdminDashboard />, { token: "admin-token" });

    expect(screen.getByText("AdminSetup:confirm:admin-token")).toBeInTheDocument();
  });
});
