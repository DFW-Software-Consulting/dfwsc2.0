import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { getClients, patchClient } from "../api/clients";
import { getGroups, patchGroup } from "../api/groups";
import { useClients, usePatchClientStatus } from "../hooks/useClients";
import { useGroups, usePatchGroup } from "../hooks/useGroups";

const clientsPayload = {
  data: [
    { id: "c1", name: "One", status: "active" },
    { id: "c2", name: "Two", status: "active" },
  ],
  total: 2,
  limit: 100,
  offset: 0,
};

const groupsPayload = {
  data: [
    { id: "g1", name: "Alpha", status: "active" },
    { id: "g2", name: "Beta", status: "active" },
  ],
  total: 2,
  limit: 100,
  offset: 0,
};

function setup(hook) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(hook, { wrapper });
}

const statusOf = (list, id) => list.find((row) => row.id === id).status;

describe("usePatchClientStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the PATCH and optimistically updates the paginated list cache", async () => {
    getClients.mockResolvedValue(clientsPayload);
    let resolvePatch;
    patchClient.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePatch = resolve;
        })
    );

    const { result } = setup(() => ({ list: useClients(), patch: usePatchClientStatus() }));
    await waitFor(() => expect(result.current.list.data).toHaveLength(2));

    act(() => {
      result.current.patch.mutate({ id: "c1", status: "inactive" });
    });

    await waitFor(() =>
      expect(patchClient).toHaveBeenCalledWith("token-123", "c1", { status: "inactive" })
    );
    await waitFor(() => expect(statusOf(result.current.list.data, "c1")).toBe("inactive"));
    expect(statusOf(result.current.list.data, "c2")).toBe("active");

    await act(async () => {
      resolvePatch({});
    });
  });

  it("rolls the cache back when the PATCH fails", async () => {
    getClients.mockResolvedValueOnce(clientsPayload);
    let rejectPatch;
    patchClient.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectPatch = reject;
        })
    );

    const { result } = setup(() => ({ list: useClients(), patch: usePatchClientStatus() }));
    await waitFor(() => expect(result.current.list.data).toHaveLength(2));

    act(() => {
      result.current.patch.mutate({ id: "c1", status: "inactive" });
    });
    await waitFor(() => expect(statusOf(result.current.list.data, "c1")).toBe("inactive"));

    getClients.mockResolvedValue(clientsPayload);
    await act(async () => {
      rejectPatch(new Error("boom"));
    });

    await waitFor(() => expect(result.current.patch.isError).toBe(true));
    await waitFor(() => expect(statusOf(result.current.list.data, "c1")).toBe("active"));
  });
});

describe("usePatchGroup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the status PATCH and optimistically updates the paginated list cache", async () => {
    getGroups.mockResolvedValue(groupsPayload);
    let resolvePatch;
    patchGroup.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePatch = resolve;
        })
    );

    const { result } = setup(() => ({ list: useGroups(), patch: usePatchGroup() }));
    await waitFor(() => expect(result.current.list.data).toHaveLength(2));

    act(() => {
      result.current.patch.mutate({ id: "g1", body: { status: "inactive" } });
    });

    await waitFor(() =>
      expect(patchGroup).toHaveBeenCalledWith("token-123", "g1", { status: "inactive" })
    );
    await waitFor(() => expect(statusOf(result.current.list.data, "g1")).toBe("inactive"));
    expect(statusOf(result.current.list.data, "g2")).toBe("active");

    await act(async () => {
      resolvePatch({});
    });
  });

  it("rolls the cache back when the PATCH fails", async () => {
    getGroups.mockResolvedValueOnce(groupsPayload);
    let rejectPatch;
    patchGroup.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectPatch = reject;
        })
    );

    const { result } = setup(() => ({ list: useGroups(), patch: usePatchGroup() }));
    await waitFor(() => expect(result.current.list.data).toHaveLength(2));

    act(() => {
      result.current.patch.mutate({ id: "g1", body: { status: "inactive" } });
    });
    await waitFor(() => expect(statusOf(result.current.list.data, "g1")).toBe("inactive"));

    getGroups.mockResolvedValue(groupsPayload);
    await act(async () => {
      rejectPatch(new Error("boom"));
    });

    await waitFor(() => expect(result.current.patch.isError).toBe(true));
    await waitFor(() => expect(statusOf(result.current.list.data, "g1")).toBe("active"));
  });
});
