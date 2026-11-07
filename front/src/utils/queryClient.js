import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { authLogoutRef } from "../contexts/AuthContext.jsx";

// An expired or revoked admin token surfaces as a 401 from either a query or a mutation.
const logoutOn401 = (err) => {
  if (err?.status === 401) authLogoutRef.current?.();
};

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false } },
    queryCache: new QueryCache({ onError: logoutOn401 }),
    mutationCache: new MutationCache({ onError: logoutOn401 }),
  });
}
