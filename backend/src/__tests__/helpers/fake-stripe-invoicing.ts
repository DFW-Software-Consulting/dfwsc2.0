import Stripe from "stripe";

// In-memory Stripe for the "New invoice" tests. Every method of every resource is a recorded call
// (`resource.method`); the ones the feature may use answer, anything else records itself and throws,
// so an unexpected call (an update, a cancel, a void...) can never go unnoticed.
//
// Idempotency is simulated like Stripe's: the same key with the same parameters returns the first
// result without creating anything; the same key with other parameters is a StripeIdempotencyError.

export interface FakeCall {
  call: string;
  params: Record<string, any> | undefined;
  options: Record<string, any> | undefined;
  /** The key had been used before: the stored result was replayed. */
  replayed: boolean;
  /** The call was refused (an injected failure) and created nothing. */
  failed: boolean;
}

/** Every method the feature is allowed to call. */
export const ALLOWED_CALLS = new Set([
  "invoices.create",
  "invoices.finalizeInvoice",
  "invoices.sendInvoice",
  "invoices.retrieve",
  "invoices.search",
  "invoiceItems.create",
  "invoiceItems.list",
  "products.create",
  "products.search",
  "subscriptionSchedules.create",
  "subscriptionSchedules.list",
]);

interface Failure {
  call: string;
  error: Error;
  times: number;
  /** The request takes effect first and the answer is lost. */
  afterApply: boolean;
}

export const apiError = (status: number, type = "api_error") =>
  status === 429
    ? new Stripe.errors.StripeRateLimitError({ type: "rate_limit_error", statusCode: 429 } as never)
    : status >= 500
      ? new Stripe.errors.StripeAPIError({ type, statusCode: status } as never)
      : status === 401
        ? new Stripe.errors.StripeAuthenticationError({
            type: "authentication_error",
            statusCode: 401,
          } as never)
        : new Stripe.errors.StripeInvalidRequestError({
            type: "invalid_request_error",
            statusCode: status,
          } as never);

export const connectionError = () =>
  new Stripe.errors.StripeConnectionError({ message: "down" } as never);

export class FakeInvoicingStripe {
  calls: FakeCall[] = [];
  /** Existing objects returned by search and list (set by a test). */
  searchResults: Record<string, any[]> = {};
  invoiceStatus = new Map<string, string>();
  private failures: Failure[] = [];
  private byKey = new Map<string, { params: string; result: unknown }>();
  private counter = 0;

  reset() {
    this.calls = [];
    this.searchResults = {};
    this.invoiceStatus.clear();
    this.failures = [];
    this.byKey.clear();
    this.counter = 0;
  }

  fail(call: string, error: Error, times = 1, afterApply = false) {
    this.failures.push({ call, error, times, afterApply });
  }

  callsTo(call: string) {
    return this.calls.filter((c) => c.call === call);
  }

  /** Calls that really created something (not replays, not refused). */
  created(call: string) {
    return this.callsTo(call).filter((c) => !c.replayed && !c.failed);
  }

  private nextId(prefix: string) {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  private answer(call: string, params: Record<string, any> | undefined): unknown {
    switch (call) {
      case "invoices.create": {
        const id = this.nextId("in");
        this.invoiceStatus.set(id, "draft");
        return { id, status: "draft", metadata: params?.metadata };
      }
      case "invoiceItems.create":
        return { id: this.nextId("ii"), metadata: params?.metadata };
      case "invoices.finalizeInvoice":
      case "invoices.sendInvoice":
        return { id: params?.__id, status: "open" };
      case "products.create":
        return { id: this.nextId("prod"), metadata: params?.metadata };
      case "subscriptionSchedules.create":
        return { id: this.nextId("sub_sched"), metadata: params?.metadata };
      default:
        return { data: [] };
    }
  }

  invoke(call: string, args: unknown[]): Promise<unknown> {
    const hasId = [
      "invoices.finalizeInvoice",
      "invoices.sendInvoice",
      "invoices.retrieve",
    ].includes(call);
    const id = hasId ? (args[0] as string) : undefined;
    const params = (hasId ? args[1] : args[0]) as Record<string, any> | undefined;
    const options = (hasId ? args[2] : args[1]) as Record<string, any> | undefined;
    const key = options?.idempotencyKey as string | undefined;
    const sentParams = hasId ? { ...(params ?? {}), id } : params;
    const record: FakeCall = { call, params: sentParams, options, replayed: false, failed: false };
    this.calls.push(record);

    if (!ALLOWED_CALLS.has(call)) {
      return Promise.reject(new Error(`unexpected Stripe call: ${call}`));
    }
    const stored = key ? this.byKey.get(key) : undefined;
    if (stored) {
      if (stored.params !== JSON.stringify(sentParams)) {
        return Promise.reject(
          new Stripe.errors.StripeIdempotencyError({
            type: "idempotency_error",
            statusCode: 400,
            message: "Keys for idempotent requests can only be used with the same parameters",
          } as never)
        );
      }
      record.replayed = true;
      return Promise.resolve(stored.result);
    }
    const failure = this.failures.find((f) => f.call === call && f.times > 0);
    if (failure && !failure.afterApply) {
      failure.times -= 1;
      record.failed = true;
      return Promise.reject(failure.error);
    }

    let result: any;
    if (call === "invoices.retrieve") {
      result = { id, status: this.invoiceStatus.get(id as string) ?? "draft" };
    } else if (call === "invoices.search" || call === "products.search") {
      result = { data: this.searchResults[call] ?? [] };
    } else if (call === "invoiceItems.list") {
      result = { data: this.searchResults[call] ?? [] };
    } else if (call === "subscriptionSchedules.list") {
      result = { data: this.searchResults[call] ?? [] };
    } else {
      result = this.answer(call, hasId ? { ...(params ?? {}), __id: id } : params);
      if (call === "invoices.finalizeInvoice") this.invoiceStatus.set(id as string, "open");
      result = { ...result };
      delete result.__id;
    }
    if (key) this.byKey.set(key, { params: JSON.stringify(sentParams), result });
    if (failure?.afterApply) {
      failure.times -= 1;
      return Promise.reject(failure.error);
    }
    return Promise.resolve(result);
  }

  /** Stands in for lib/stripe's `stripe`: any resource, any method. */
  stripe = new Proxy({} as Record<string, any>, {
    get: (_target, resource) => {
      if (typeof resource !== "string" || resource === "then") return undefined;
      return new Proxy(
        {},
        {
          get: (_inner, method) => {
            if (typeof method !== "string" || method === "then") return undefined;
            return (...args: unknown[]) => this.invoke(`${resource}.${method}`, args);
          },
        }
      );
    },
  });
}

export const fakeInvoicing = new FakeInvoicingStripe();
