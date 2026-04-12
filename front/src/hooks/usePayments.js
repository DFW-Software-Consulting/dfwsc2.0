import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createCheckoutSession } from "../api/payments";
import { useAuth } from "../contexts/AuthContext";

export function useCreatePayment() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => createCheckoutSession(token, body),
    onSuccess: () => {
      // Invalidate reports if necessary
      queryClient.invalidateQueries({ queryKey: ["paymentReports"] });
    },
  });
}
