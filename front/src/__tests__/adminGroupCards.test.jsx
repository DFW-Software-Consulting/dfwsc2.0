import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import GroupPanel from "../components/admin/GroupPanel";
import { renderWithProviders } from "../test/renderWithProviders";

const groups = [{ id: "g1", name: "Maple Court", status: "active", processingFeePercent: 2.5 }];
const clients = [
  {
    id: "c1",
    groupId: "g1",
    name: "Unit 4B",
    email: "unit.4b.tenant@example.com",
    status: "active",
  },
];

vi.mock("../hooks/useGroups", () => {
  const mutation = { mutate: vi.fn(), isPending: false };
  return {
    useGroups: () => ({ data: groups, isLoading: false, isError: false, refetch: vi.fn() }),
    useCreateGroup: () => mutation,
    usePatchGroup: () => mutation,
    useDeleteGroup: () => mutation,
  };
});
vi.mock("../hooks/useClients", () => ({ useClients: () => ({ data: clients }) }));

afterEach(() => {
  delete window.matchMedia;
});

function mockViewport(isDesktop) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: isDesktop,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe("GroupPanel on phones", () => {
  it("renders companies as cards and expands the member list inside the card", async () => {
    mockViewport(false);
    const user = userEvent.setup();
    renderWithProviders(<GroupPanel />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const card = within(screen.getByTestId("admin-cards")).getAllByRole("listitem")[0];
    expect(within(card).getByRole("heading", { name: "Maple Court" })).toBeInTheDocument();
    expect(within(card).getByText("2.5%")).toBeInTheDocument();
    expect(within(card).getByText("1 client")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /More actions/ })).toBeInTheDocument();

    const toggle = within(card).getByRole("button", { name: "Expand Maple Court" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(within(card).getByText("unit.4b.tenant@example.com").className).toContain(
      "[overflow-wrap:anywhere]"
    );
    expect(within(card).getByRole("button", { name: "Collapse Maple Court" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  it("keeps the table on desktop", () => {
    mockViewport(true);
    renderWithProviders(<GroupPanel />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-cards")).not.toBeInTheDocument();
  });
});
