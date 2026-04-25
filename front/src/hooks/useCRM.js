import { useMutation, useQueryClient } from "@tanstack/react-query";
import { convertToClient, createLead, reinstateClient, suspendClient, syncPaymentStatus } from "../api/crm";
import { useAuth } from "../contexts/AuthContext";

export function useSuspendClient() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }) => suspendClient(token, id, reason),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["clients"] }),
  });
}

export function useReinstateClient() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) => reinstateClient(token, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["clients"] }),
  });
}

export function useSyncPaymentStatus() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => syncPaymentStatus(token),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["clients"] }),
  });
}

export function useCreateLead() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => createLead(token, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["clients"] }),
  });
}

export function useConvertToClient() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) => convertToClient(token, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["clients"] }),
  });
}
