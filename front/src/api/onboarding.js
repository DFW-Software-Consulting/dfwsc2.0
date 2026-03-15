import { apiFetch } from "./client";

export const initiateOnboarding = (onboardToken) =>
  apiFetch(`/onboard-client?token=${encodeURIComponent(onboardToken)}`, {
    headers: {
      Accept: "application/json",
      "ngrok-skip-browser-warning": "true",
    },
  });

export const resendOnboardingLink = (token, body) =>
  apiFetch("/onboard-client/resend", { token, method: "POST", body });
