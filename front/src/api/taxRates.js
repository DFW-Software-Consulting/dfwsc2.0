import { apiFetch } from "./client";

export const getTaxRates = (token) => apiFetch("/tax-rates", { token });
