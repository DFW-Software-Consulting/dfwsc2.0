import { apiFetch } from "./client";

export const getClient = (token, id, workspace) =>
  apiFetch(`/clients/${id}?workspace=${encodeURIComponent(workspace)}`, { token });

export const getClients = (token, { groupId, workspace } = {}) => {
  const qs = new URLSearchParams();
  if (groupId) qs.set("groupId", groupId);
  if (workspace) qs.set("workspace", workspace);
  const params = qs.toString();
  const suffix = params ? `?${params}` : "";
  return apiFetch(`/clients${suffix}`, { token });
};

export const patchClient = (token, id, body) =>
  apiFetch(`/clients/${id}`, { token, method: "PATCH", body });

export const createClient = (token, body) => apiFetch("/accounts", { token, method: "POST", body });

export const createDfwscClient = (token, body) =>
  apiFetch("/crm/clients", { token, method: "POST", body });
