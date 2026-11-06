import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import AdminDashboard from "../components/admin/AdminDashboard";
import { renderWithProviders } from "../test/renderWithProviders";

vi.mock("../components/admin/AdminLogin", () => ({ default: () => <div>AdminLogin</div> }));
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

  it("renders AdminLogin when there is no token", () => {
    renderWithProviders(<AdminDashboard />, { token: null });

    expect(screen.getByText("AdminLogin")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accounts" })).not.toBeInTheDocument();
  });
});
