import { apiFetch } from "./client";

export const getSubscriptions = (token, params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return apiFetch(`/subscriptions${qs ? `?${qs}` : ""}`, { token });
};

export const createSubscription = (token, body) =>
  apiFetch("/subscriptions", { token, method: "POST", body });

export const patchSubscription = (token, id, body) =>
  apiFetch(`/subscriptions/${id}`, { token, method: "PATCH", body });

export const getSubscriptionDetail = (token, id) => apiFetch(`/subscriptions/${id}`, { token });
