import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteClient,
  getClient,
  getClients,
  initiateClientOnboarding,
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
    select: (response) => {
      const data = Array.isArray(response) ? response : response.data;
      return Object.assign(data ?? [], {
        pagination: Array.isArray(response)
          ? { total: response.length, limit: response.length, offset: 0 }
          : { total: response.total, limit: response.limit, offset: response.offset },
      });
    },
  });
}

export function useInitiateClientOnboarding() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => initiateClientOnboarding(token, body),
    onSuccess: () => {
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === "clients",
      });
    },
  });
}

export function usePatchClient() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) => patchClient(token, id, body),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === "clients",
      });
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
      const isClientsQuery = (query) => query.queryKey[0] === "clients";
      await queryClient.cancelQueries({ predicate: isClientsQuery });
      const prev = queryClient.getQueriesData({ predicate: isClientsQuery });
      queryClient.setQueriesData({ predicate: isClientsQuery }, (old) =>
        old?.map((c) => (c.id === id ? { ...c, status } : c))
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      ctx?.prev?.forEach(([queryKey, data]) => {
        queryClient.setQueryData(queryKey, data);
      });
    },
    onSettled: () =>
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "clients" }),
  });
}

export function useDeleteClient() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id) => deleteClient(token, id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "clients" });
      queryClient.invalidateQueries({ queryKey: ["client", id] });
      queryClient.invalidateQueries({ queryKey: ["groups"] });
    },
  });
}

export function useResendOnboarding() {
  const { token } = useAuth();
  return useMutation({
    mutationFn: (body) => resendOnboardingLink(token, body),
  });
}
