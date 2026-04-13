import { useQuery } from "@tanstack/react-query";
import { getTaxRates } from "../api/taxRates";
import { useAuth } from "../contexts/AuthContext";

export function useTaxRates() {
  const { token } = useAuth();
  return useQuery({
    queryKey: ["tax-rates"],
    queryFn: () => getTaxRates(token),
    enabled: !!token,
  });
}
