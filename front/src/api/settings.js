import { apiFetch } from "./client";

export const getSettings = (token) => apiFetch("/settings", { token });

export const updateSetting = (token, key, value) =>
  apiFetch(`/settings/${key}`, {
    token,
    method: "PATCH",
    body: { value },
  });
