import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AdminDashboard from "../components/admin/AdminDashboard";
import GroupPanel from "../components/admin/GroupPanel";
import SettingsPanel from "../components/admin/SettingsPanel";
import { renderWithProviders } from "../test/renderWithProviders";

// jsdom has no layout, so these pin the classes that keep the admin chrome from
// widening the page at 375px (checked visually in a real browser).

vi.mock("../components/admin/ClientList", () => ({ default: () => null }));
vi.mock("../components/admin/Toast", () => ({ default: () => null }));
vi.mock("../hooks/useGroups", () => {
  const mutation = { mutate: vi.fn(), isPending: false };
  return {
    useGroups: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
    useCreateGroup: () => mutation,
    usePatchGroup: () => mutation,
    useDeleteGroup: () => mutation,
  };
});
vi.mock("../hooks/useClients", () => ({ useClients: () => ({ data: [] }) }));
vi.mock("../hooks/useSettings", () => ({
  useSettings: () => ({
    data: {
      defaultFeeCents: 250,
      defaultFeePercent: 2.9,
      companyName: "DFW",
      contactEmail: "help@example.com",
      smtpFrom: "no-reply@example.com",
    },
    isLoading: false,
    isError: false,
  }),
  useUpdateSetting: () => ({ mutateAsync: vi.fn() }),
}));

describe("admin mobile layout", () => {
  it("contains the tab bar in its own horizontal scroller", () => {
    renderWithProviders(<AdminDashboard />, { token: "admin-token" });
    const scroller = screen.getByTestId("admin-tabs");
    expect(scroller).toBe(screen.getByRole("navigation", { name: "Admin sections" }));
    expect(scroller.className).toContain("overflow-x-auto");
    expect(scroller.className).toContain("scroll-shade-x");
    const row = scroller.firstElementChild;
    expect(row.className).toContain("w-max");
    expect(row.className).toContain("min-w-full");
    for (const name of ["Accounts", "Companies", "Reports", "Settings"]) {
      const tab = screen.getByRole("button", { name });
      expect(row.contains(tab)).toBe(true);
      expect(tab.className).toContain("whitespace-nowrap");
      expect(tab.className).toContain("shrink-0");
    }
  });

  it("lets settings input rows wrap so the Save button drops below on narrow screens", () => {
    renderWithProviders(<SettingsPanel />);
    for (const label of [
      "Global Default Fee (Fixed Cents)",
      "Global Default Fee (%) (Optional)",
      "Platform Company Name",
      "Platform Contact Email",
    ]) {
      const input = screen.getByLabelText(label);
      expect(input.className).toContain("min-w-0");
      const row = input.parentElement;
      expect(row.className).toContain("flex-wrap");
      expect(within(row).getByRole("button", { name: "Save" }).className).toContain("shrink-0");
    }
    expect(screen.getByText("no-reply@example.com").className).toContain("break-all");
  });

  it("lets the create-company form and list header wrap instead of overflowing", () => {
    renderWithProviders(<GroupPanel />);
    const input = screen.getByRole("textbox", { name: "Company name" });
    expect(input.className).toContain("min-w-0");
    expect(input.closest("form").className).toContain("flex-wrap");
    const header = screen.getByText("Client Companies").parentElement;
    expect(header.className).toContain("flex-wrap");
    expect(header).toContainElement(screen.getByRole("button", { name: "Refresh" }));
  });
});
