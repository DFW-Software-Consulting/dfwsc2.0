import { useMutation, useQueryClient } from "@tanstack/react-query";
import { convertToClient, createLead, reinstateClient, suspendClient, syncPaymentStatus } from "../api/crm";
import { useAuth } from "../contexts/AuthContext";

export function useSuspendClient(_workspace) {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }) => suspendClient(token, id, reason),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["clients"] }),
  });
}

export function useReinstateClient(_workspace) {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) => reinstateClient(token, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["clients"] }),
  });
}

export function useSyncPaymentStatus(_workspace) {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => syncPaymentStatus(token),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["clients"] }),
  });
}

export function useCreateLead(workspace) {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => createLead(token, workspace, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["clients"] }),
  });
}

export function useConvertToClient(workspace) {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) => convertToClient(token, workspace, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["clients"] }),
  });
}
