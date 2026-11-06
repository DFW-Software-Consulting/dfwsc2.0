import Stripe from "stripe";

// In-memory Stripe for the connected-account invoicing tests (customers, invoices, invoice items). Every call is
// recorded as { call, params, options } so a guard test can assert that EVERY call carried the
// client's `stripeAccount`. Only the methods the feature may use answer; anything else records
// itself and throws, so an unexpected call can never go unnoticed.
//
// Customers, invoices and invoice items are kept per connected account, like Stripe: an id created
// on one account does not exist on another. An invoice's total is the sum of its items. Idempotency is simulated: the same key with the same parameters replays the
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
  "invoices.create",
  "invoices.retrieve",
  "invoices.list",
  "invoiceItems.create",
  "invoiceItems.list",
  "invoices.finalizeInvoice",
  "invoices.sendInvoice",
  "invoices.voidInvoice",
  "invoices.del",
]);

const LIFECYCLE_CALLS = new Set([
  "invoices.finalizeInvoice",
  "invoices.sendInvoice",
  "invoices.voidInvoice",
  "invoices.del",
]);

/** Calls whose arguments are (params, options); the others take (id, params, options). */
const NO_ID_CALLS = new Set([
  "customers.create",
  "invoices.create",
  "invoices.list",
  "invoiceItems.create",
  "invoiceItems.list",
]);

interface Failure {
  call: string;
  /** 1-based: the Nth call to `call` since the last reset fails. */
  nth: number;
  error: Error;
  /**
   * before: the call never reaches Stripe (nothing is created, no key recorded).
   * stored_error: Stripe executes it, fails, and keeps the error under the idempotency key, so a
   *   replay inside 24 hours returns the same error (a Stripe 5xx pins that key).
   * lost_response: Stripe creates the object and records the key, but the answer never arrives.
   */
  mode: "before" | "stored_error" | "lost_response";
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

// Stripe ids are unique across the whole platform, and connect_invoices keeps a unique index on the
// invoice id, so these never repeat (not even across reset() or between test runs on one database).
const RUN_ID = Math.random().toString(36).slice(2, 8);
let objectSeq = 0;

export class FakeConnectInvoicingStripe {
  calls: ConnectCall[] = [];
  private failures: Failure[] = [];
  private counts = new Map<string, number>();
  /** account -> customer id -> object */
  private customers = new Map<string, Map<string, Record<string, any>>>();
  /** account -> invoice id -> object */
  private invoices = new Map<string, Map<string, Record<string, any>>>();
  /** account -> invoice item id -> object */
  private items = new Map<string, Map<string, Record<string, any>>>();
  private byKey = new Map<
    string,
    { params: string; result?: Record<string, any>; error?: Error }
  >();
  private counter = 0;
  /** Merged over an invoice on `invoices.retrieve`, by invoice id or "*" for all (to make Stripe disagree with our math). */
  retrieveOverrides: Record<string, Record<string, any>> = {};
  /** Blocks `customers.create` until released (to line up a race), when set. */
  createGate: Promise<void> | null = null;
  /** Runs at the start of every call (after it is counted), e.g. to interleave another request. */
  onCall: ((call: string, nth: number) => Promise<void>) | null = null;
  /** Blocks `invoices.create` until released (to line up a race), when set. */
  invoiceCreateGate: Promise<void> | null = null;
  /** Runs after `customers.create` made its customer but before it answers (to inject a race). */
  afterCreate: ((created: Record<string, any>) => Promise<void>) | null = null;

  /** Forces the Nth `invoices.list` call (1-based, since reset) to answer exactly this page. */
  listPageOverrides = new Map<number, { data: Record<string, any>[]; has_more: boolean }>();

  reset() {
    this.listPageOverrides.clear();
    this.calls = [];
    this.failures = [];
    this.counts.clear();
    this.customers.clear();
    this.invoices.clear();
    this.items.clear();
    this.byKey.clear();
    this.retrieveOverrides = {};
    this.counter = 0;
    this.createGate = null;
    this.invoiceCreateGate = null;
    this.onCall = null;
    this.afterCreate = null;
  }

  /** Make the Nth call (1-based, counted since the last reset) to `call` fail with `error`. */
  failNth(call: string, nth: number, error: Error) {
    this.failures.push({ call, nth, error, mode: "before" });
  }

  /** Like failNth, but Stripe records the error under the call's idempotency key (replayed 24h). */
  failNthStored(call: string, nth: number, error: Error) {
    this.failures.push({ call, nth, error, mode: "stored_error" });
  }

  /** The Nth call to `call` is executed (object created, key recorded) but the response is lost. */
  loseResponseNth(call: string, nth: number) {
    this.failures.push({
      call,
      nth,
      error: new Stripe.errors.StripeConnectionError({
        type: "api_error",
        message: "An error occurred with our connection to Stripe.",
      } as never),
      mode: "lost_response",
    });
  }

  /** Put an invoice on an account without a recorded call (test setup). */
  seedInvoice(account: string, invoice: Record<string, any>) {
    this.bucketOf(this.invoices, account).set(invoice.id, {
      object: "invoice",
      status: "draft",
      created: Math.floor(Date.now() / 1000),
      metadata: {},
      ...invoice,
    });
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

  /** Invoices on an account, oldest first. */
  invoicesOn(account: string) {
    return [...(this.invoices.get(account)?.values() ?? [])];
  }

  /** Invoice items on an account, oldest first. */
  itemsOn(account: string) {
    return [...(this.items.get(account)?.values() ?? [])];
  }

  /** Forget every idempotency key (Stripe keeps them 24 hours). */
  expireIdempotencyKeys() {
    this.byKey.clear();
  }

  private missing(id: string, what = "customer") {
    const err = new Stripe.errors.StripeInvalidRequestError({
      type: "invalid_request_error",
      statusCode: 404,
      code: "resource_missing",
      message: `No such ${what}: '${id}'`,
    } as never);
    return err;
  }

  private invalidRequest(message: string) {
    return new Stripe.errors.StripeInvalidRequestError({
      type: "invalid_request_error",
      statusCode: 400,
      message,
    } as never);
  }

  private bucketOf<T>(store: Map<string, Map<string, T>>, account: string) {
    const bucket = store.get(account) ?? new Map<string, T>();
    store.set(account, bucket);
    return bucket;
  }

  private recompute(account: string, invoice: Record<string, any>) {
    const total = [...this.bucketOf(this.items, account).values()]
      .filter((it) => it.invoice === invoice.id)
      .reduce((sum, it) => sum + it.amount, 0);
    invoice.total = total;
    invoice.subtotal = total;
    invoice.amount_due = total;
    invoice.amount_remaining = total - invoice.amount_paid;
  }

  async invoke(call: string, args: unknown[]): Promise<unknown> {
    const hasId = !NO_ID_CALLS.has(call);
    const id = hasId ? (args[0] as string) : undefined;
    const params = (hasId ? args[1] : args[0]) as Record<string, any> | undefined;
    const options = (hasId ? args[2] : args[1]) as Record<string, any> | undefined;
    this.calls.push({ call, params: hasId ? { ...(params ?? {}), id } : params, options });

    if (!ALLOWED_CONNECT_CALLS.has(call)) throw new Error(`unexpected Stripe call: ${call}`);
    const count = (this.counts.get(call) ?? 0) + 1;
    this.counts.set(call, count);
    if (this.onCall) await this.onCall(call, count);
    const failure = this.failures.find((f) => f.call === call && f.nth === count);
    if (failure?.mode === "before") throw failure.error;

    const account = options?.stripeAccount as string | undefined;
    if (!account) throw new Error(`Stripe call without stripeAccount: ${call}`);
    const bucket = this.bucketOf(this.customers, account);

    if (call.startsWith("invoice"))
      return this.invoiceCall(call, account, id, params, options, bucket, failure);

    if (call === "customers.create") {
      if (this.createGate) await this.createGate;
      const key = options?.idempotencyKey as string | undefined;
      const sent = JSON.stringify(params);
      const stored = key ? this.byKey.get(`${account}:${call}:${key}`) : undefined;
      if (stored) {
        this.assertSameParams(stored.params, sent);
        if (stored.error) throw stored.error;
        return stored.result;
      }
      if (failure) throw failure.error;
      this.counter += 1;
      const created = { object: "customer", id: `cus_fake${this.counter}`, ...params };
      bucket.set(created.id, created);
      if (key) this.byKey.set(`${account}:${call}:${key}`, { params: sent, result: created });
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

  private assertSameParams(stored: string, sent: string) {
    if (stored !== sent) {
      throw new Stripe.errors.StripeIdempotencyError({
        type: "idempotency_error",
        statusCode: 400,
        message: "Keys for idempotent requests can only be used with the same parameters",
      } as never);
    }
  }

  private async invoiceCall(
    call: string,
    account: string,
    id: string | undefined,
    params: Record<string, any> | undefined,
    options: Record<string, any> | undefined,
    customers: Map<string, Record<string, any>>,
    failure: Failure | undefined
  ): Promise<unknown> {
    const invoices = this.bucketOf(this.invoices, account);
    const items = this.bucketOf(this.items, account);
    const key = options?.idempotencyKey as string | undefined;
    const sent = JSON.stringify(params);

    if (failure && (call.endsWith(".retrieve") || call.endsWith(".list"))) throw failure.error;

    if (call === "invoices.retrieve") {
      const found = invoices.get(id as string);
      if (!found) throw this.missing(id as string, "invoice");
      return {
        ...found,
        ...(this.retrieveOverrides["*"] ?? {}),
        ...(this.retrieveOverrides[found.id] ?? {}),
      };
    }

    if (call === "invoices.list" || call === "invoiceItems.list") {
      const forced =
        call === "invoices.list"
          ? this.listPageOverrides.get(this.calls.filter((c) => c.call === call).length)
          : undefined;
      if (forced) return { object: "list", ...forced };
      const store = call === "invoices.list" ? invoices : items;
      let data = [...store.values()].reverse(); // newest first
      if (params?.customer) data = data.filter((o) => o.customer === params.customer);
      if (params?.invoice) data = data.filter((o) => o.invoice === params.invoice);
      const gte = params?.created?.gte as number | undefined;
      if (gte !== undefined) data = data.filter((o) => (o.created ?? Infinity) >= gte);
      if (params?.starting_after) {
        const at = data.findIndex((o) => o.id === params.starting_after);
        data = at === -1 ? [] : data.slice(at + 1);
      }
      const limit = (params?.limit as number | undefined) ?? 10;
      return { object: "list", data: data.slice(0, limit), has_more: data.length > limit };
    }

    if (LIFECYCLE_CALLS.has(call)) {
      return this.lifecycleCall(call, account, id as string, params, options, failure);
    }

    // creates
    if (call === "invoices.create" && this.invoiceCreateGate) await this.invoiceCreateGate;
    const stored = key ? this.byKey.get(`${account}:${call}:${key}`) : undefined;
    if (stored) {
      this.assertSameParams(stored.params, sent);
      if (stored.error) throw stored.error;
      return stored.result;
    }
    if (failure?.mode === "stored_error") {
      if (key) this.byKey.set(`${account}:${call}:${key}`, { params: sent, error: failure.error });
      throw failure.error;
    }
    this.counter += 1;
    let created: Record<string, any>;
    if (call === "invoices.create") {
      const customer = customers.get(params?.customer);
      if (!customer || customer.deleted) throw this.missing(params?.customer, "customer");
      created = {
        object: "invoice",
        id: `in_fake${RUN_ID}${++objectSeq}`,
        customer: params?.customer,
        status: "draft",
        currency: params?.currency ?? "usd",
        collection_method: params?.collection_method,
        days_until_due: params?.days_until_due,
        auto_advance: params?.auto_advance,
        application_fee_amount: params?.application_fee_amount ?? null,
        description: params?.description ?? null,
        footer: params?.footer ?? null,
        metadata: params?.metadata ?? {},
        created: Math.floor(Date.now() / 1000),
        number: null,
        due_date: null,
        hosted_invoice_url: null,
        invoice_pdf: null,
        amount_paid: 0,
        status_transitions: {
          finalized_at: null,
          paid_at: null,
          voided_at: null,
          marked_uncollectible_at: null,
        },
      };
      this.recompute(account, created);
      invoices.set(created.id, created);
    } else {
      const invoice = invoices.get(params?.invoice);
      if (!invoice) throw this.missing(params?.invoice, "invoice");
      if (invoice.status !== "draft") throw this.invalidRequest("invoice is not a draft");
      const quantity = params?.quantity ?? 1;
      const amount =
        params?.amount ?? Math.round(Number(params?.unit_amount_decimal ?? 0) * quantity);
      created = {
        object: "invoiceitem",
        id: `ii_fake${RUN_ID}${++objectSeq}`,
        customer: params?.customer,
        invoice: params?.invoice,
        currency: params?.currency ?? "usd",
        description: params?.description,
        quantity,
        unit_amount_decimal: params?.unit_amount_decimal ?? null,
        amount,
        metadata: params?.metadata ?? {},
        created: Math.floor(Date.now() / 1000),
      };
      items.set(created.id, created);
      this.recompute(account, invoice);
    }
    if (key) this.byKey.set(`${account}:${call}:${key}`, { params: sent, result: created });
    if (failure?.mode === "lost_response") throw failure.error;
    return created;
  }

  /** finalizeInvoice, sendInvoice, voidInvoice and del, with Stripe's state rules. */
  private lifecycleCall(
    call: string,
    account: string,
    id: string,
    params: Record<string, any> | undefined,
    options: Record<string, any> | undefined,
    failure: Failure | undefined
  ): unknown {
    const invoices = this.bucketOf(this.invoices, account);
    const key = options?.idempotencyKey as string | undefined;
    const sent = JSON.stringify(params);
    const stored = key ? this.byKey.get(`${account}:${call}:${key}`) : undefined;
    if (stored) {
      this.assertSameParams(stored.params, sent);
      if (stored.error) throw stored.error;
      return stored.result;
    }
    const invoice = invoices.get(id);
    if (!invoice) throw this.missing(id, "invoice");
    if (failure?.mode === "stored_error") {
      if (key) this.byKey.set(`${account}:${call}:${key}`, { params: sent, error: failure.error });
      throw failure.error;
    }
    const now = Math.floor(Date.now() / 1000);
    let result: Record<string, any>;
    if (call === "invoices.finalizeInvoice") {
      if (invoice.status !== "draft") throw this.invalidRequest("invoice is not a draft");
      this.recompute(account, invoice);
      this.counter += 1;
      Object.assign(invoice, {
        status: "open",
        number: `FAKE-${String(this.counter).padStart(4, "0")}`,
        due_date: now + (invoice.days_until_due ?? 30) * 86400,
        hosted_invoice_url: `https://invoice.example/${invoice.id}`,
        invoice_pdf: `https://invoice.example/${invoice.id}/pdf`,
      });
      invoice.status_transitions = { ...invoice.status_transitions, finalized_at: now };
      result = { ...invoice };
    } else if (call === "invoices.sendInvoice") {
      if (invoice.status !== "open") throw this.invalidRequest("invoice is not open");
      invoice.emailsSent = (invoice.emailsSent ?? 0) + 1;
      result = { ...invoice };
    } else if (call === "invoices.voidInvoice") {
      if (invoice.status !== "open" && invoice.status !== "uncollectible") {
        throw this.invalidRequest("invoice cannot be voided");
      }
      invoice.status = "void";
      invoice.amount_remaining = 0;
      invoice.status_transitions = { ...invoice.status_transitions, voided_at: now };
      result = { ...invoice };
    } else {
      if (invoice.status !== "draft") throw this.invalidRequest("only drafts can be deleted");
      invoices.delete(id);
      for (const [itemId, item] of this.bucketOf(this.items, account)) {
        if (item.invoice === id) this.bucketOf(this.items, account).delete(itemId);
      }
      result = { id, object: "invoice", deleted: true };
    }
    if (key) this.byKey.set(`${account}:${call}:${key}`, { params: sent, result });
    if (failure?.mode === "lost_response") throw failure.error;
    return result;
  }

  /** How many emails Stripe would have sent for an invoice. */
  emailsSent(account: string, invoiceId: string): number {
    return this.invoices.get(account)?.get(invoiceId)?.emailsSent ?? 0;
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
