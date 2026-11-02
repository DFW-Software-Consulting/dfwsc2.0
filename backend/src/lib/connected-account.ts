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

// Sent by every route that charges a connected account while its card_payments capability is
// not active (Checkout and invoicing share the body so integrators handle it once).
export const CARD_PAYMENTS_NOT_ACTIVE_ERROR = {
  error:
    "Card payments are not active on this connected account yet. Contact your DFWSC administrator.",
  code: "CARD_PAYMENTS_NOT_ACTIVE",
};
