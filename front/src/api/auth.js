import { apiFetch } from "./client";

export const getSetupStatus = () => apiFetch("/auth/setup/status");

export const login = (body) => apiFetch("/auth/login", { method: "POST", body });

export const setup = (body, setupToken) =>
  apiFetch("/auth/setup", {
    method: "POST",
    body,
    headers: setupToken ? { "X-Setup-Token": setupToken } : {},
  });
