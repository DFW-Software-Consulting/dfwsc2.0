import { useQuery } from "@tanstack/react-query";
import { getPaymentReport } from "../api/payments";
import { useAuth } from "../contexts/AuthContext";

export function usePaymentReport(params = {}, { enabled = false } = {}) {
  const { token } = useAuth();
  const effectiveParams = { workspace: "client_portal", ...params };
  return useQuery({
    queryKey: ["reports", "payments", effectiveParams],
    queryFn: () => getPaymentReport(token, effectiveParams),
    enabled: !!token && enabled,
  });
}
