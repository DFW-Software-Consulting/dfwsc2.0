export const makeStripeInvoice = (overrides: Record<string, any> = {}) => ({
  id: "in_test_001",
  object: "invoice",
  amount_due: 9900,
  description: "Website hosting",
  due_date: Math.floor(Date.now() / 1000) + 86400 * 30,
  status: "open",
  hosted_invoice_url: "https://invoice.stripe.com/i/test",
  status_transitions: { paid_at: null },
  created: Math.floor(Date.now() / 1000),
  metadata: {},
  ...overrides,
});

export const makeStripeSub = (overrides: Record<string, any> = {}) => ({
  id: "sub_test_001",
  object: "subscription",
  status: "active",
  pause_collection: null,
  items: { data: [{ price: { unit_amount: 4900 } }] },
  metadata: { clientId: "", description: "Monthly hosting", interval: "monthly" },
  current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
  created: Math.floor(Date.now() / 1000),
  latest_invoice: "in_test_001",
  ...overrides,
});
