import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createClient,
  createDfwscClient,
  getClient,
  getClients,
  patchClient,
} from "../api/clients";
import { resendOnboardingLink } from "../api/onboarding";
import { useAuth } from "../contexts/AuthContext";

export function useClient(id, workspace) {
  const { token } = useAuth();
  return useQuery({
    queryKey: ["client", id, workspace],
    queryFn: () => getClient(token, id, workspace),
    enabled: !!token && !!id,
    select: (data) => data.client,
  });
}

export function useClients(params = {}) {
  const { token } = useAuth();
  const effectiveParams = { workspace: "client_portal", ...params };
  return useQuery({
    queryKey: ["clients", effectiveParams],
    queryFn: () => getClients(token, effectiveParams),
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

export function usePatchClient() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) => patchClient(token, id, body),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      queryClient.invalidateQueries({ queryKey: ["groups"] });
      queryClient.invalidateQueries({ queryKey: ["client", variables.id] });
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
