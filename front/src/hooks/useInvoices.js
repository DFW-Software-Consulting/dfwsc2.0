import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cancelInvoice, createInvoice, getInvoices } from "../api/invoices";
import { useAuth } from "../contexts/AuthContext";

export function useInvoices(params = {}) {
  const { token } = useAuth();
  return useQuery({
    queryKey: ["invoices", params],
    queryFn: () => getInvoices(token, params),
    enabled: !!token,
  });
}

export function useCreateInvoice() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => createInvoice(token, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["invoices"] }),
  });
}

export function useCancelInvoice() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id) => cancelInvoice(token, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["invoices"] }),
  });
}
