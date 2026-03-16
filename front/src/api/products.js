import { apiFetch } from "./client";

export const getProducts = (token) => apiFetch("/products", { token });

export const createProduct = (token, body) =>
  apiFetch("/products", { token, method: "POST", body });
