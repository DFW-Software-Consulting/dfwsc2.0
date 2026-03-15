import { apiFetch } from "./client";

export const getClients = (token, { groupId } = {}) => {
  const params = groupId ? `?groupId=${groupId}` : "";
  return apiFetch(`/clients${params}`, { token });
};

export const patchClient = (token, id, body) =>
  apiFetch(`/clients/${id}`, { token, method: "PATCH", body });

export const createClient = (token, body) => apiFetch("/accounts", { token, method: "POST", body });
