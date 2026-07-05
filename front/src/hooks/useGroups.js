import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createGroup, deleteGroup, getGroups, patchGroup } from "../api/groups";
import { useAuth } from "../contexts/AuthContext";

export function useGroups(workspace = "client_portal") {
  const { token } = useAuth();
  return useQuery({
    queryKey: ["groups", workspace],
    queryFn: () => getGroups(token, workspace),
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

export function useCreateGroup() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => createGroup(token, body),
    onSuccess: () => {
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === "groups",
      });
    },
  });
}

export function usePatchGroup() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) => patchGroup(token, id, body),
    onMutate: async ({ id, body }) => {
      if (body.status === undefined) return;
      const isGroupsQuery = (query) => query.queryKey[0] === "groups";
      await queryClient.cancelQueries({ predicate: isGroupsQuery });
      const prev = queryClient.getQueriesData({ predicate: isGroupsQuery });
      queryClient.setQueriesData({ predicate: isGroupsQuery }, (old) =>
        old?.map((g) => (g.id === id ? { ...g, ...body } : g))
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      ctx?.prev?.forEach(([queryKey, data]) => {
        queryClient.setQueryData(queryKey, data);
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["groups"] }),
  });
}

export function useDeleteGroup() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id) => deleteGroup(token, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "groups" });
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "clients" });
    },
  });
}
