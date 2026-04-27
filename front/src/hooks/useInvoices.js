import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cancelInvoice,
  createInvoice,
  getLedgerInvoices,
  getInvoices,
  markInvoicePaidOutOfBand,
} from "../api/invoices";
import { useAuth } from "../contexts/AuthContext";

export function useInvoices(params = {}) {
  const { token } = useAuth();
  const effectiveParams = { workspace: "client_portal", ...params };
  return useQuery({
    queryKey: ["invoices", effectiveParams],
    queryFn: () => getInvoices(token, effectiveParams),
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

export function useLedgerInvoices(params = {}, enabled = false) {
  const { token } = useAuth();
  return useQuery({
    queryKey: ["ledger-invoices", params],
    queryFn: () => getLedgerInvoices(token, params),
    enabled: !!token && enabled,
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

export function useMarkInvoicePaidOutOfBand() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }) => markInvoicePaidOutOfBand(token, id, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["invoices"] }),
  });
}
