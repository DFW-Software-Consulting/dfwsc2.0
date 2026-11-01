import Stripe from "stripe";

// In-memory Stripe for the connected-account invoicing tests (customers today). Every call is
// recorded as { call, params, options } so a guard test can assert that EVERY call carried the
// client's `stripeAccount`. Only the methods the feature may use answer; anything else records
// itself and throws, so an unexpected call can never go unnoticed.
//
// Customers are kept per connected account, like Stripe: an id created on one account does not
// exist on another. Idempotency is simulated: the same key with the same parameters replays the
// first result, the same key with other parameters is a StripeIdempotencyError.

export interface ConnectCall {
  call: string;
  params: Record<string, any> | undefined;
  options: Record<string, any> | undefined;
}

export const ALLOWED_CONNECT_CALLS = new Set([
  "customers.create",
  "customers.retrieve",
  "customers.update",
  "customers.del",
]);

interface Failure {
  call: string;
  /** 1-based: the Nth call to `call` since the last reset fails. */
  nth: number;
  error: Error;
}

export const stripeApiError = (status: number) =>
  status === 429
    ? new Stripe.errors.StripeRateLimitError({ type: "rate_limit_error", statusCode: 429 } as never)
    : status >= 500
      ? new Stripe.errors.StripeAPIError({ type: "api_error", statusCode: status } as never)
      : new Stripe.errors.StripeInvalidRequestError({
          type: "invalid_request_error",
          statusCode: status,
        } as never);

export class FakeConnectInvoicingStripe {
  calls: ConnectCall[] = [];
  private failures: Failure[] = [];
  private counts = new Map<string, number>();
  /** account -> customer id -> object */
  private customers = new Map<string, Map<string, Record<string, any>>>();
  private byKey = new Map<string, { params: string; result: Record<string, any> }>();
  private counter = 0;
  /** Blocks `customers.create` until released (to line up a race), when set. */
  createGate: Promise<void> | null = null;
  /** Runs after `customers.create` made its customer but before it answers (to inject a race). */
  afterCreate: ((created: Record<string, any>) => Promise<void>) | null = null;

  reset() {
    this.calls = [];
    this.failures = [];
    this.counts.clear();
    this.customers.clear();
    this.byKey.clear();
    this.counter = 0;
    this.createGate = null;
    this.afterCreate = null;
  }

  /** Make the Nth call (1-based, counted since the last reset) to `call` fail with `error`. */
  failNth(call: string, nth: number, error: Error) {
    this.failures.push({ call, nth, error });
  }

  callsTo(call: string) {
    return this.calls.filter((c) => c.call === call);
  }

  /** Customers that exist (not deleted) on an account. */
  liveCustomers(account: string) {
    return [...(this.customers.get(account)?.values() ?? [])].filter((c) => !c.deleted);
  }

  /** Put a customer on an account without a recorded call (test setup). */
  seedCustomer(account: string, customer: Record<string, any>) {
    const bucket = this.customers.get(account) ?? new Map();
    this.customers.set(account, bucket);
    bucket.set(customer.id, { object: "customer", ...customer });
  }

  private missing(id: string) {
    const err = new Stripe.errors.StripeInvalidRequestError({
      type: "invalid_request_error",
      statusCode: 404,
      code: "resource_missing",
      message: `No such customer: '${id}'`,
    } as never);
    return err;
  }

  async invoke(call: string, args: unknown[]): Promise<unknown> {
    const hasId = call !== "customers.create";
    const id = hasId ? (args[0] as string) : undefined;
    const params = (hasId ? args[1] : args[0]) as Record<string, any> | undefined;
    const options = (hasId ? args[2] : args[1]) as Record<string, any> | undefined;
    this.calls.push({ call, params: hasId ? { ...(params ?? {}), id } : params, options });

    if (!ALLOWED_CONNECT_CALLS.has(call)) throw new Error(`unexpected Stripe call: ${call}`);
    const count = (this.counts.get(call) ?? 0) + 1;
    this.counts.set(call, count);
    const failure = this.failures.find((f) => f.call === call && f.nth === count);
    if (failure) throw failure.error;

    const account = options?.stripeAccount as string | undefined;
    if (!account) throw new Error(`Stripe call without stripeAccount: ${call}`);
    const bucket = this.customers.get(account) ?? new Map<string, Record<string, any>>();
    this.customers.set(account, bucket);

    if (call === "customers.create") {
      if (this.createGate) await this.createGate;
      const key = options?.idempotencyKey as string | undefined;
      const sent = JSON.stringify(params);
      const stored = key ? this.byKey.get(`${account}:${key}`) : undefined;
      if (stored) {
        if (stored.params !== sent) {
          throw new Stripe.errors.StripeIdempotencyError({
            type: "idempotency_error",
            statusCode: 400,
            message: "Keys for idempotent requests can only be used with the same parameters",
          } as never);
        }
        return stored.result;
      }
      this.counter += 1;
      const created = { object: "customer", id: `cus_fake${this.counter}`, ...params };
      bucket.set(created.id, created);
      if (key) this.byKey.set(`${account}:${key}`, { params: sent, result: created });
      if (this.afterCreate) await this.afterCreate(created);
      return created;
    }

    const found = bucket.get(id as string);
    if (!found) throw this.missing(id as string);
    if (call === "customers.retrieve") {
      return found.deleted ? { id, object: "customer", deleted: true } : found;
    }
    if (call === "customers.update") {
      if (found.deleted) throw this.missing(id as string);
      Object.assign(found, params);
      return found;
    }
    found.deleted = true; // customers.del
    return { id, object: "customer", deleted: true };
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

export const fakeConnectInvoicing = new FakeConnectInvoicingStripe();
