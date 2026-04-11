import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createClient,
  getClients,
  getStripeCustomers,
  importStripeCustomer,
  patchClient,
} from "../api/clients";
import { resendOnboardingLink } from "../api/onboarding";
import { useAuth } from "../contexts/AuthContext";

export function useClients() {
  const { token } = useAuth();
  return useQuery({
    queryKey: ["clients"],
    queryFn: () => getClients(token),
    enabled: !!token,
  });
}

export function useStripeCustomers(starting_after) {
  const { token } = useAuth();
  return useQuery({
    queryKey: ["stripe-customers", starting_after],
    queryFn: () => getStripeCustomers(token, { starting_after }),
    enabled: !!token,
  });
}

export function useCreateClient() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => createClient(token, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["clients"] }),
  });
}

export function useImportStripeCustomer() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ stripeCustomerId, groupId }) =>
      importStripeCustomer(token, stripeCustomerId, groupId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["clients"] }),
  });
}

export function usePatchClient() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) => patchClient(token, id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      queryClient.invalidateQueries({ queryKey: ["groups"] });
    },
  });
}

export function usePatchClientStatus() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }) => patchClient(token, id, { status }),
    onMutate: async ({ id, status }) => {
      await queryClient.cancelQueries({ queryKey: ["clients"] });
      const prev = queryClient.getQueryData(["clients"]);
      queryClient.setQueryData(["clients"], (old) =>
        old?.map((c) => (c.id === id ? { ...c, status } : c))
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => queryClient.setQueryData(["clients"], ctx.prev),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["clients"] }),
  });
}

export function useResendOnboarding() {
  const { token } = useAuth();
  return useMutation({
    mutationFn: (body) => resendOnboardingLink(token, body),
  });
}
