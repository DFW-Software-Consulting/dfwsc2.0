// Stripe saves the connected account id when the client submits the onboarding
// token, before the hosted form is finished, so the id alone does not mean the
// client can take payments. Mirrors the backend, which treats a client as
// onboarded only when it has an account and chargesEnabled.
export function getOnboardingState(client) {
  if (client.stripeAccountId && client.chargesEnabled) return "ready";
  if (client.stripeAccountId) return "in_progress";
  return "not_started";
}
