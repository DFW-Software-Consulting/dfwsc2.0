import { apiFetch } from "./client";

export const submitContact = (body) => apiFetch("/contact", { method: "POST", body });
