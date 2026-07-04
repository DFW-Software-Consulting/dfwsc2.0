import { apiFetch } from "./client";

export const getSetupStatus = () => apiFetch("/auth/setup/status");

export const login = (body) => apiFetch("/auth/login", { method: "POST", body });

export const setup = (body, setupToken) =>
  apiFetch("/auth/setup", {
    method: "POST",
    body,
    headers: setupToken ? { "X-Setup-Token": setupToken } : {},
  });

export const confirmBootstrap = (body, token) =>
  apiFetch("/auth/confirm-bootstrap", { token, method: "POST", body });

// Alias for setup to maintain semantic clarity in AdminSetup component
export const createAdmin = setup;
