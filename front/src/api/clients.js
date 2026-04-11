import { apiFetch } from "./client";

export const getClients = (token, { groupId } = {}) => {
  const params = groupId ? `?groupId=${groupId}` : "";
  return apiFetch(`/clients${params}`, { token });
};

export const patchClient = (token, id, body) =>
  apiFetch(`/clients/${id}`, { token, method: "PATCH", body });

export const createClient = (token, body) => apiFetch("/accounts", { token, method: "POST", body });

export const getStripeCustomers = (token, { starting_after } = {}) => {
  const params = starting_after ? `?starting_after=${starting_after}` : "";
  return apiFetch(`/stripe/customers${params}`, { token });
};

export const importStripeCustomer = (token, stripeCustomerId) =>
  apiFetch("/stripe/import-customer", {
    token,
    method: "POST",
    body: { stripeCustomerId },
  });
