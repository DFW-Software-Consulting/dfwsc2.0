// A client can take charges on its connected account only when it has a Stripe
// account id and Stripe has enabled charges on it. Callers keep their own error
// response (payments: 409 ACCOUNT_NOT_CONNECTED, products: 400) and only share
// this check.
export function getChargeableAccountId(client: {
  stripeAccountId: string | null;
  chargesEnabled: boolean | null;
}): string | null {
  if (!client.stripeAccountId || !client.chargesEnabled) return null;
  return client.stripeAccountId;
}
