import { apiFetch } from "./client";

export const getSubscriptions = (token, params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return apiFetch(`/subscriptions${qs ? `?${qs}` : ""}`, { token });
};

export const createSubscription = (token, body) =>
  apiFetch("/subscriptions", { token, method: "POST", body });

export const linkSubscription = (token, body) =>
  apiFetch("/subscriptions/link", { token, method: "POST", body });

export const patchSubscription = (token, id, body) =>
  apiFetch(
    `/subscriptions/${id}${
      body?.workspace
        ? `?${new URLSearchParams({ workspace: String(body.workspace) }).toString()}`
        : ""
    }`,
    { token, method: "PATCH", body }
  );

export const getSubscriptionDetail = (token, id) => apiFetch(`/subscriptions/${id}`, { token });
