import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/apiKey", () => ({
  regenerateApiKey: vi.fn(),
  requestApiKeyRegeneration: vi.fn(),
  requestApiKeyRegenerationAdmin: vi.fn(),
}));

import { regenerateApiKey, requestApiKeyRegeneration } from "../api/apiKey";
import { useRegenerateApiKey, useRequestApiKeyRegeneration } from "../hooks/useApiKey";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return function Wrapper({ children }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useRegenerateApiKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("transitions from idle to pending to success and returns the API key data", async () => {
    let resolveMutation;
    regenerateApiKey.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMutation = resolve;
        })
    );

    const { result } = renderHook(() => useRegenerateApiKey(), { wrapper: createWrapper() });

    expect(result.current.isIdle).toBe(true);

    act(() => {
      result.current.mutate("token-123");
    });

    await waitFor(() => expect(result.current.isPending).toBe(true));

    act(() => {
      resolveMutation({ apiKey: "sk_new_key" });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ apiKey: "sk_new_key" });
    expect(regenerateApiKey).toHaveBeenCalledWith("token-123");
  });

  it("transitions from idle to pending to error and returns the error", async () => {
    let rejectMutation;
    regenerateApiKey.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectMutation = reject;
        })
    );

    const { result } = renderHook(() => useRegenerateApiKey(), { wrapper: createWrapper() });

    act(() => {
      result.current.mutate("bad-token");
    });

    await waitFor(() => expect(result.current.isPending).toBe(true));

    act(() => {
      rejectMutation(new Error("This regeneration link has expired."));
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error.message).toBe("This regeneration link has expired.");
  });
});

describe("useRequestApiKeyRegeneration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("transitions from idle to pending to success", async () => {
    let resolveMutation;
    requestApiKeyRegeneration.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMutation = resolve;
        })
    );

    const { result } = renderHook(() => useRequestApiKeyRegeneration(), {
      wrapper: createWrapper(),
    });

    expect(result.current.isIdle).toBe(true);

    act(() => {
      result.current.mutate("user@example.com");
    });

    await waitFor(() => expect(result.current.isPending).toBe(true));

    act(() => {
      resolveMutation({ message: "ok" });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestApiKeyRegeneration).toHaveBeenCalledWith("user@example.com");
  });

  it("transitions from idle to pending to error", async () => {
    let rejectMutation;
    requestApiKeyRegeneration.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectMutation = reject;
        })
    );

    const { result } = renderHook(() => useRequestApiKeyRegeneration(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.mutate("user@example.com");
    });

    await waitFor(() => expect(result.current.isPending).toBe(true));

    act(() => {
      rejectMutation(new Error("Network error"));
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error.message).toBe("Network error");
  });
});
