import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../contexts/AuthContext";
import { apiFetch } from "../api/client";

export function useCrmClients() {
  const { token } = useAuth();
  return useQuery({
    queryKey: ["crm-clients"],
    queryFn: () => apiFetch("/crm/clients", { token }),
    enabled: !!token,
  });
}

export function useCreateCrmClient() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      apiFetch("/crm/clients", {
        token,
        method: "POST",
        body,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["crm-clients"] }),
  });
}