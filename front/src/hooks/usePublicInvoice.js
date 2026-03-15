import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getPublicInvoice, payInvoice } from "../api/invoices";

export function usePublicInvoice(paymentToken) {
  return useQuery({
    queryKey: ["public-invoice", paymentToken],
    queryFn: () => getPublicInvoice(paymentToken),
    enabled: !!paymentToken,
  });
}

export function usePayInvoice(paymentToken) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => payInvoice(paymentToken),
    onSuccess: (data) => {
      if (data?.invoice) {
        queryClient.setQueryData(["public-invoice", paymentToken], data.invoice);
      }
    },
  });
}
