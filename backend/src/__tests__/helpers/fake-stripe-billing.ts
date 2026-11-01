import type {
  BillingInvoiceInput,
  BillingScheduleInput,
  BillingSubscriptionInput,
} from "../../lib/billing-status";

// In-memory Stripe for the billing mirror tests. EVERY method of every resource is a recorded
// spy; only the three list methods and webhooks.constructEvent answer, anything else records
// itself and throws, so a Stripe write (create, update, del, finalizeInvoice, sendInvoice, pay,
// cancel, ...) can never go unnoticed: see assertNoStripeWrites.

export interface CustomerData {
  subscriptions: BillingSubscriptionInput[];
  schedules: BillingScheduleInput[];
  invoices: (BillingInvoiceInput & { created?: number })[];
  paymentIntents: { id: string; status: string }[];
  /** InvoicePayments by invoice id. */
  invoicePayments: Record<string, { id: string; created: number; payment: unknown }[]>;
}

export interface StripeCall {
  call: string;
  params: Record<string, unknown>;
}

const READS = new Set([
  "subscriptions.list",
  "subscriptionSchedules.list",
  "invoices.list",
  "invoicePayments.list",
  "paymentIntents.retrieve",
  "webhooks.constructEvent",
]);

class FakeBillingStripe {
  calls: StripeCall[] = [];
  customers = new Map<string, CustomerData>();
  pageSize = 100;
  /** Runs before each list answers; may throw to simulate a Stripe failure. */
  beforeList: ((customerId: string, call: string) => void | Promise<void>) | null = null;
  /** Errors thrown by `call` (e.g. "invoicePayments.list") or `call:id`, for failure tests. */
  failures = new Map<string, unknown>();
  goodSignature = "sig_good";

  reset() {
    this.calls = [];
    this.customers.clear();
    this.pageSize = 100;
    this.beforeList = null;
    this.failures.clear();
  }

  set(customerId: string, data: Partial<CustomerData>) {
    this.customers.set(customerId, {
      subscriptions: [],
      schedules: [],
      invoices: [],
      paymentIntents: [],
      ...data,
    });
  }

  callsTo(call: string) {
    return this.calls.filter((c) => c.call === call);
  }

  /** Every recorded call that is not one of the read methods. */
  unexpected() {
    return this.calls.filter((c) => !READS.has(c.call));
  }

  private page<T extends { id: string }>(items: T[], params: Record<string, unknown>) {
    const after = params.starting_after as string | undefined;
    const start = after ? items.findIndex((i) => i.id === after) + 1 : 0;
    const size = Math.min(this.pageSize, Number(params.limit ?? 10));
    const data = items.slice(start, start + size);
    return { object: "list", data, has_more: start + size < items.length };
  }

  private async list(call: string, key: keyof CustomerData, params: Record<string, unknown>) {
    const customerId = String(params.customer);
    await this.beforeList?.(customerId, call);
    return this.page((this.customers.get(customerId)?.[key] ?? []) as { id: string }[], params);
  }

  private method =
    (resource: string, name: string) =>
    async (...args: unknown[]) => {
      const call = `${resource}.${name}`;
      const params = (args[0] ?? {}) as Record<string, unknown>;
      this.calls.push({
        call,
        params: call === "paymentIntents.retrieve" ? { id: args[0] } : params,
      });
      const target = call === "paymentIntents.retrieve" ? String(args[0]) : String(params.invoice);
      const failure = this.failures.get(`${call}:${target}`) ?? this.failures.get(call);
      if (failure) throw failure;
      if (call === "invoicePayments.list") {
        const invoiceId = String(params.invoice);
        for (const data of this.customers.values()) {
          if (data.invoicePayments[invoiceId])
            return this.page(data.invoicePayments[invoiceId], params);
        }
        return this.page([], params);
      }
      if (call === "paymentIntents.retrieve") {
        const id = String(args[0]);
        for (const data of this.customers.values()) {
          const found = data.paymentIntents.find((p) => p.id === id);
          if (found) return found;
        }
        throw new Error(`no such PaymentIntent ${id}`);
      }
      if (call === "subscriptions.list") return this.list(call, "subscriptions", params);
      if (call === "subscriptionSchedules.list") return this.list(call, "schedules", params);
      if (call === "invoices.list") return this.list(call, "invoices", params);
      if (call === "paymentIntents.retrieve") return this.list(call, "paymentIntents", params);
      throw new Error(`unexpected Stripe call ${call}`);
    };

  readonly stripe: unknown = new Proxy(
    {},
    {
      get: (_target, resource: string) => {
        if (resource === "webhooks") {
          return {
            constructEvent: (raw: string, signature: string, secret: string) => {
              this.calls.push({ call: "webhooks.constructEvent", params: { secret } });
              if (signature !== this.goodSignature) throw new Error("bad signature");
              return JSON.parse(raw);
            },
          };
        }
        return new Proxy({}, { get: (_t, name: string) => this.method(resource, name) });
      },
    }
  );
}

export const fakeStripe = new FakeBillingStripe();
