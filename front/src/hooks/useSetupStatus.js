import { useQuery } from "@tanstack/react-query";
import { getSetupStatus } from "../api/auth";
import { useAuth } from "../contexts/AuthContext";

export function useSetupStatus() {
  const { isLoggedIn } = useAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: ["setup-status"],
    queryFn: getSetupStatus,
    staleTime: Infinity,
    enabled: !isLoggedIn,
  });

  // Return the full status object from the backend
  return {
    ...(data ?? {}),
    isLoading,
    error,
  };
}
