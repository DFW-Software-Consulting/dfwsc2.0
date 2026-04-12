import { apiFetch } from "./client";

export const getPaymentReport = (token, params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return apiFetch(`/reports/payments${qs ? `?${qs}` : ""}`, { token });
};

export const createCheckoutSession = (token, body) =>
  apiFetch("/payments/create", { token, method: "POST", body });
