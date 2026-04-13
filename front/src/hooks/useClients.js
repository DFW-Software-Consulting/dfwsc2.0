import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createClient,
  createDfwscClient,
  getClients,
  getStripeCustomers,
  importStripeCustomer,
  patchClient,
  syncStripeCustomer,
} from "../api/clients";
import { resendOnboardingLink } from "../api/onboarding";
import { useAuth } from "../contexts/AuthContext";

export function useClients(params = {}) {
  const { token } = useAuth();
  const effectiveParams = { workspace: "client_portal", ...params };
  return useQuery({
    queryKey: ["clients", effectiveParams],
    queryFn: () => getClients(token, effectiveParams),
    enabled: !!token,
  });
}

export function useStripeCustomers(starting_after, workspace) {
  const { token } = useAuth();
  const effectiveWorkspace = workspace ?? "client_portal";
  return useQuery({
    queryKey: ["stripe-customers", starting_after, effectiveWorkspace],
    queryFn: () => getStripeCustomers(token, { starting_after, workspace: effectiveWorkspace }),
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
    mutationFn: ({ stripeCustomerId, groupId, workspace }) =>
      importStripeCustomer(token, stripeCustomerId, groupId, workspace),
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

export function useDfwscClient() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => createDfwscClient(token, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["clients"] }),
  });
}

export function useSyncStripeCustomer() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => syncStripeCustomer(token, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["stripe-customers"] }),
  });
}
