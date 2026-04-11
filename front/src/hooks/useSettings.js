import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSettings, updateSetting } from "../api/settings";
import { useAuth } from "../contexts/AuthContext";

export function useSettings() {
  const { token } = useAuth();
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => getSettings(token),
    enabled: !!token,
  });
}

export function useUpdateSetting() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }) => updateSetting(token, key, value),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });
}
