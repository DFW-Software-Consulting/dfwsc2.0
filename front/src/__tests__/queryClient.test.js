import { afterEach, describe, expect, it, vi } from "vitest";
import { authLogoutRef } from "../contexts/AuthContext.jsx";
import { createQueryClient } from "../utils/queryClient.js";

const apiError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

afterEach(() => {
  authLogoutRef.current = null;
});

describe("createQueryClient", () => {
  it("logs out when a query fails with 401", async () => {
    const logout = vi.fn();
    authLogoutRef.current = logout;
    await createQueryClient()
      .fetchQuery({ queryKey: ["q"], queryFn: () => Promise.reject(apiError(401)), retry: false })
      .catch(() => {});
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("logs out when a mutation fails with 401", async () => {
    const logout = vi.fn();
    authLogoutRef.current = logout;
    const client = createQueryClient();
    await client
      .getMutationCache()
      .build(client, { mutationFn: () => Promise.reject(apiError(401)) })
      .execute()
      .catch(() => {});
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("does not log out on other mutation errors", async () => {
    const logout = vi.fn();
    authLogoutRef.current = logout;
    const client = createQueryClient();
    await client
      .getMutationCache()
      .build(client, { mutationFn: () => Promise.reject(apiError(500)) })
      .execute()
      .catch(() => {});
    expect(logout).not.toHaveBeenCalled();
  });
});
