import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TruncationNotice from "../components/admin/shared/TruncationNotice";

vi.mock("../contexts/AuthContext", () => ({
  useAuth: () => ({ token: "token-123" }),
}));

vi.mock("../api/clients", () => ({
  deleteClient: vi.fn(),
  getClient: vi.fn(),
  getClients: vi.fn(),
  initiateClientOnboarding: vi.fn(),
  patchClient: vi.fn(),
}));

vi.mock("../api/groups", () => ({
  createGroup: vi.fn(),
  deleteGroup: vi.fn(),
  getGroups: vi.fn(),
  patchGroup: vi.fn(),
}));

import { getClients } from "../api/clients";
import { getGroups } from "../api/groups";
import { useClients } from "../hooks/useClients";
import { useGroups } from "../hooks/useGroups";

function setup(hook) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(hook, { wrapper });
}

describe("admin list hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("useClients asks for the largest page and exposes the server total", async () => {
    getClients.mockResolvedValue({ data: [{ id: "c1" }], total: 150, limit: 100, offset: 0 });

    const { result } = setup(() => useClients());
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    expect(getClients).toHaveBeenCalledWith(
      "token-123",
      expect.objectContaining({ workspace: "client_portal", limit: 100 })
    );
    expect(result.current.data.pagination.total).toBe(150);
  });

  it("useGroups asks for the largest page and exposes the server total", async () => {
    getGroups.mockResolvedValue({ data: [{ id: "g1" }], total: 120, limit: 100, offset: 0 });

    const { result } = setup(() => useGroups());
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    expect(getGroups).toHaveBeenCalledWith("token-123", "client_portal", 100);
    expect(result.current.data.pagination.total).toBe(120);
  });
});

describe("TruncationNotice", () => {
  it("shows how many rows are hidden when the list is truncated", () => {
    render(<TruncationNotice shown={100} total={130} noun="clients" />);

    expect(screen.getByRole("status")).toHaveTextContent("Showing 100 of 130 clients");
  });

  it("renders nothing when every row is shown", () => {
    render(<TruncationNotice shown={5} total={5} noun="clients" />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders nothing when the total is unknown", () => {
    render(<TruncationNotice shown={5} noun="clients" />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
