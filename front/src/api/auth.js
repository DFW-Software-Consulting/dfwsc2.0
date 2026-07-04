import { apiFetch } from "./client";

export const getSetupStatus = () => apiFetch("/auth/setup/status");

export const login = (body) => apiFetch("/auth/login", { method: "POST", body });

export const confirmBootstrap = (body, token) =>
  apiFetch("/auth/confirm-bootstrap", { token, method: "POST", body });
