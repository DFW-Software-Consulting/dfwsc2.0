import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createGroup, getGroups, patchGroup } from "../api/groups";
import { useAuth } from "../contexts/AuthContext";

export function useGroups() {
  const { token } = useAuth();
  return useQuery({
    queryKey: ["groups"],
    queryFn: () => getGroups(token),
    enabled: !!token,
  });
}

export function useCreateGroup() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => createGroup(token, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["groups"] }),
  });
}

export function usePatchGroup() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) => patchGroup(token, id, body),
    onMutate: async ({ id, body }) => {
      if (body.status === undefined) return;
      await queryClient.cancelQueries({ queryKey: ["groups"] });
      const prev = queryClient.getQueryData(["groups"]);
      queryClient.setQueryData(["groups"], (old) =>
        old?.map((g) => (g.id === id ? { ...g, ...body } : g))
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["groups"], ctx.prev);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["groups"] }),
  });
}
