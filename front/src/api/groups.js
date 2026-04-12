import { apiFetch } from "./client";

export const getGroups = (token, workspace) =>
  apiFetch(`/groups?workspace=${encodeURIComponent(workspace)}`, { token });

export const createGroup = (token, body) => apiFetch("/groups", { token, method: "POST", body });

export const patchGroup = (token, id, body) =>
  apiFetch(`/groups/${id}`, { token, method: "PATCH", body });
