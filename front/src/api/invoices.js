import { apiFetch } from "./client";

export const getInvoices = (token, params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return apiFetch(`/invoices${qs ? `?${qs}` : ""}`, { token });
};

export const createInvoice = (token, body) =>
  apiFetch("/invoices", { token, method: "POST", body });

export const cancelInvoice = (token, id) => apiFetch(`/invoices/${id}`, { token, method: "PATCH" });
