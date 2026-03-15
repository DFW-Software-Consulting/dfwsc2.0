import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createSubscription,
  getSubscriptionDetail,
  getSubscriptions,
  patchSubscription,
} from "../api/subscriptions";
import { useAuth } from "../contexts/AuthContext";

export function useSubscriptions(params = {}) {
  const { token } = useAuth();
  return useQuery({
    queryKey: ["subscriptions", params],
    queryFn: () => getSubscriptions(token, params),
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
