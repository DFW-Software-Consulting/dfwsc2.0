import { apiFetch } from "./client";

export const login = (body) => apiFetch("/auth/login", { method: "POST", body });
