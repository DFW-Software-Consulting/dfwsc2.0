import { apiFetch } from "./client";

export const getClients = (token, { groupId, workspace } = {}) => {
  const qs = new URLSearchParams();
  if (groupId) qs.set("groupId", groupId);
  if (workspace) qs.set("workspace", workspace);
  const params = qs.toString();
  const suffix = params ? `?${params}` : "";
  return apiFetch(`/clients${suffix}`, { token });
};

export const patchClient = (token, id, body) =>
  apiFetch(`/clients/${id}`, { token, method: "PATCH", body });

export const createClient = (token, body) => apiFetch("/accounts", { token, method: "POST", body });

export const createDfwscClient = (token, body) =>
  apiFetch("/dfwsc/clients", { token, method: "POST", body });

export const getStripeCustomers = (token, { starting_after, workspace } = {}) => {
  const qs = new URLSearchParams();
  if (starting_after) qs.set("starting_after", starting_after);
  if (workspace) qs.set("workspace", workspace);
  const params = qs.toString();
  return apiFetch(`/stripe/customers${params ? `?${params}` : ""}`, { token });
};

export const importStripeCustomer = (token, stripeCustomerId, groupId, workspace) =>
  apiFetch("/stripe/import-customer", {
    token,
    method: "POST",
    body: { stripeCustomerId, groupId, workspace },
  });
