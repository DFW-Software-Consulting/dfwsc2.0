import { apiFetch } from "./client";

export const getGroups = (token, workspace, limit) => {
  const qs = new URLSearchParams({ workspace });
  if (limit != null) qs.set("limit", String(limit));
  return apiFetch(`/groups?${qs.toString()}`, { token });
};

export const createGroup = (token, body) => apiFetch("/groups", { token, method: "POST", body });

export const patchGroup = (token, id, body) =>
  apiFetch(`/groups/${id}`, { token, method: "PATCH", body });

export const deleteGroup = (token, id) => apiFetch(`/groups/${id}`, { token, method: "DELETE" });
