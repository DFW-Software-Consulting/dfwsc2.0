import { apiFetch } from "./client";

export const getClient = (token, id, workspace) =>
  apiFetch(`/clients/${id}?workspace=${encodeURIComponent(workspace)}`, { token });

export const getClients = (token, { groupId, workspace, limit, offset } = {}) => {
  const qs = new URLSearchParams();
  if (groupId) qs.set("groupId", groupId);
  if (workspace) qs.set("workspace", workspace);
  if (limit != null) qs.set("limit", String(limit));
  if (offset != null) qs.set("offset", String(offset));
  const params = qs.toString();
  const suffix = params ? `?${params}` : "";
  return apiFetch(`/clients${suffix}`, { token });
};

export const patchClient = (token, id, body) =>
  apiFetch(`/clients/${id}`, { token, method: "PATCH", body });

export const deleteClient = (token, id) => apiFetch(`/clients/${id}`, { token, method: "DELETE" });

export const initiateClientOnboarding = (token, body) =>
  apiFetch("/onboard-client/initiate", { token, method: "POST", body });
