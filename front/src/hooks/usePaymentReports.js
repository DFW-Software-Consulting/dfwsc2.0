import { useQuery } from "@tanstack/react-query";
import { getPaymentReport } from "../api/payments";
import { useAuth } from "../contexts/AuthContext";

export function usePaymentReport(params = {}, { enabled = false } = {}) {
  const { token } = useAuth();
  return useQuery({
    queryKey: ["reports", "payments", params],
    queryFn: () => getPaymentReport(token, params),
    enabled: !!token && enabled,
  });
}
