import type {
  BillingInvoiceInput,
  BillingScheduleInput,
  BillingSubscriptionInput,
} from "../../lib/billing-status";

// Stripe-shaped fixtures for the billing status rules. Times are unix seconds.
export const NOW = new Date("2026-10-31T12:00:00Z");
export const nowSec = Math.floor(NOW.getTime() / 1000);
export const DAY = 24 * 60 * 60;
export const days = (n: number) => nowSec + n * DAY;

export function sub(
  overrides: Partial<BillingSubscriptionInput> & { id: string },
  price: { amount: number; interval?: string; count?: number; quantity?: number } = {
    amount: 150000,
  }
): BillingSubscriptionInput {
  return {
    status: "active",
    start_date: days(-60),
    cancel_at: null,
    cancel_at_period_end: false,
    schedule: null,
    items: {
      data: [
        {
          quantity: price.quantity ?? 1,
          current_period_end: days(3),
          price: {
            unit_amount: price.amount,
            currency: "usd",
            recurring: { interval: price.interval ?? "week", interval_count: price.count ?? 1 },
          },
        },
      ],
    },
    ...overrides,
  };
}

export function invoice(
  overrides: Partial<BillingInvoiceInput> & { id: string }
): BillingInvoiceInput {
  return {
    status: "paid",
    currency: "usd",
    amount_paid: 0,
    amount_remaining: 0,
    due_date: null,
    collection_method: "send_invoice",
    attempt_count: 0,
    next_payment_attempt: null,
    status_transitions: { paid_at: null },
    parent: null,
    ...overrides,
  };
}

export const paidInvoice = (
  id: string,
  subscription: string,
  amount: number,
  paidDaysAgo: number
) =>
  invoice({
    id,
    status: "paid",
    amount_paid: amount,
    status_transitions: { paid_at: days(-paidDaysAgo) },
    parent: { subscription_details: { subscription } },
  });

export const schedule = (
  status: string,
  phases: BillingScheduleInput["phases"] = []
): BillingScheduleInput => ({ status, phases });
