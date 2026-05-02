import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createSubscription,
  getSubscriptionDetail,
  getSubscriptions,
  linkSubscription,
  patchSubscription,
} from "../api/subscriptions";
import { useAuth } from "../contexts/AuthContext";

export function useSubscriptions(params = {}) {
  const { token } = useAuth();
  const effectiveParams = { workspace: "client_portal", ...params };
  return useQuery({
    queryKey: ["subscriptions", effectiveParams],
    queryFn: () => getSubscriptions(token, effectiveParams),
    enabled: !!token,
  });
}

export function useSubscriptionDetail(id, { enabled = true } = {}) {
  const { token } = useAuth();
  return useQuery({
    queryKey: ["subscriptions", "detail", id],
    queryFn: () => getSubscriptionDetail(token, id),
    enabled: !!token && !!id && enabled,
  });
}

export function useCreateSubscription() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => createSubscription(token, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
}

export function usePatchSubscription() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) => patchSubscription(token, id, body),
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
      queryClient.invalidateQueries({ queryKey: ["subscriptions", "detail", id] });
    },
  });
}

export function useLinkSubscription() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => linkSubscription(token, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
    },
  });
}
