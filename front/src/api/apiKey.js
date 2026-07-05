import { apiFetch } from "./client";

export const requestApiKeyRegeneration = (email) =>
  apiFetch("/api-key/regenerate-request", { method: "POST", body: { email } });

export const requestApiKeyRegenerationAdmin = (token, clientId) =>
  apiFetch("/api-key/regenerate-request/admin", { token, method: "POST", body: { clientId } });

export const regenerateApiKey = (regenerationToken) =>
  apiFetch(`/api-key/regenerate?token=${encodeURIComponent(regenerationToken)}`);
