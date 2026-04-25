import { apiFetch } from "./client";

export const suspendClient = (token, id, reason) =>
  apiFetch(`/clients/${id}/suspend`, { token, method: "POST", body: reason ? { reason } : {} });

export const reinstateClient = (token, id) =>
  apiFetch(`/clients/${id}/reinstate`, { token, method: "POST" });

export const syncPaymentStatus = (token) =>
  apiFetch("/clients/sync-payment-status", { token, method: "POST" });

export const createLead = (token, body) =>
  apiFetch("/dfwsc/leads", { token, method: "POST", body });

export const convertToClient = (token, id) =>
  apiFetch(`/dfwsc/leads/${id}/convert`, { token, method: "POST" });
