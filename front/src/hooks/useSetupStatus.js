import { useQuery } from "@tanstack/react-query";
import { getSetupStatus } from "../api/auth";
import { useAuth } from "../contexts/AuthContext";

export function useSetupStatus() {
  const { isLoggedIn } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["setup-status"],
    queryFn: getSetupStatus,
    staleTime: Infinity,
    enabled: !isLoggedIn,
  });
  return { setupAllowed: data?.setupAllowed ?? false, isLoading };
}
