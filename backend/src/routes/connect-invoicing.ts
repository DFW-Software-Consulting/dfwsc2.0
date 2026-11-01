import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, gte, isNull, lt, min, ne, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Stripe from "stripe";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { db } from "../db/client";
import { clientGroups, type clients, connectCustomers, connectInvoices } from "../db/schema";
import { requireApiKey } from "../lib/auth";
import {
  getCircuitBreakerStates,
  isCircuitOpenError,
  isStripeBusyError,
  withStripeCircuit,
} from "../lib/circuit-breakers";
import {
  assertTotalWithinCap,
  computeBaseCents,
  createInvoiceBodySchema,
  decodeCursor,
  encodeCursor,
  hashInvoiceRequest,
  type InvoiceRequest,
  type InvoiceRow,
  listQuerySchema,
  PROCESSING_FEE_DESCRIPTION,
  serializeInvoice,
  TERMINAL_INVOICE_STATUSES,
} from "../lib/connect-invoice";
import { getChargeableAccountId } from "../lib/connected-account";
import {
  INVOICE_CLAIM_LEASE_MS,
  INVOICE_DAILY_CREATE_LIMIT,
  INVOICE_READ_RATE_LIMIT_MAX,
  INVOICE_RECONCILE_MIN_AGE_MS,
  INVOICE_STRIPE_KEY_WINDOW_MS,
  INVOICE_WRITE_BUCKET_CAPACITY,
  INVOICE_WRITE_REFILL_PER_MINUTE,
  RATE_LIMIT_WINDOW_MS,
} from "../lib/constants";
import { errors, isUniqueViolation } from "../lib/errors";
import { rateLimit, tokenBucketRateLimit } from "../lib/rate-limit";
import { stripe } from "../lib/stripe";
import { resolveClientFee } from "../lib/stripe-billing";
import { mapStripeError } from "../lib/stripe-errors";
import { validateStripeMetadata } from "../lib/stripe-input";
import { DEFAULT_DAYS_UNTIL_DUE, parseBody } from "../lib/validation";

// Connected-account invoicing: customers, and draft invoices with their reads. Every Stripe call
// is a DIRECT call on the client's own Express account: `stripeAccount` is passed on every call,
// and the platform's billing_customers are never involved. Postgres keeps ids and an opaque
// externalRef only; email, name and phone live on Stripe and are never logged.

type ClientRow = typeof clients.$inferSelect;
type RequestWithClient = FastifyRequest & { client: ClientRow };
type CustomerRow = typeof connectCustomers.$inferSelect;

const STRIPE_CIRCUIT_OPEN_ERROR = {
  error: "Invoicing service is temporarily unavailable.",
  code: "STRIPE_CIRCUIT_OPEN",
};
const STRIPE_RATE_LIMITED_ERROR = {
  error: "Invoicing service is busy. Please retry.",
  code: "RATE_LIMITED",
};
const USER_METADATA_RESERVED_PREFIX = "dfwsc_";

const emailSchema = z
  .string({ error: "email is required." })
  .trim()
  .min(1, "email is required.")
  .max(320, "email must not exceed 320 characters.")
  .email("email must be a valid email address.");
const nameSchema = z.string().trim().max(256, "name must not exceed 256 characters.");
const phoneSchema = z.string().trim().max(20, "phone must not exceed 20 characters.");

const createBodySchema = z.object({
  email: emailSchema,
  name: nameSchema.optional(),
  phone: phoneSchema.optional(),
  // Opaque integrator reference. Must NOT contain personal data: it is stored in Postgres.
  externalRef: z
    .string()
    .trim()
    .min(1, "externalRef must not be empty.")
    .max(100, "externalRef must not exceed 100 characters.")
    .optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

const updateBodySchema = z
  .object({
    email: emailSchema.optional(),
    name: nameSchema.optional(),
    phone: phoneSchema.optional(),
  })
  .refine((b) => b.email !== undefined || b.name !== undefined || b.phone !== undefined, {
    message: "At least one of email, name or phone is required.",
  });

const idParamsSchema = z.object({ id: z.string().min(1).max(255) });
const lookupQuerySchema = z.object({
  externalRef: z
    .string({ error: "externalRef query parameter is required." })
    .trim()
    .min(1, "externalRef query parameter is required.")
    .max(100, "externalRef must not exceed 100 characters."),
});

function extractIdempotencyKey(request: FastifyRequest): string | undefined {
  const key = request.headers["idempotency-key"];
  return Array.isArray(key) ? key[0] : key;
}

/** The whitelisted view of a Customer. Never return the raw Stripe object. */
function sanitizeCustomer(row: CustomerRow, customer: Stripe.Customer) {
  return {
    id: row.stripeCustomerId,
    email: customer.email ?? null,
    name: customer.name ?? null,
    phone: customer.phone ?? null,
    externalRef: row.externalRef ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function isDeletedCustomer(
  c: Stripe.Customer | Stripe.DeletedCustomer
): c is Stripe.DeletedCustomer {
  return (c as Stripe.DeletedCustomer).deleted === true;
}

function isResourceMissing(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "resource_missing";
}

/**
 * Guard for every invoicing route: a valid API key, then the per-client opt-in. Writes also need a
 * connected account that can take charges; reads only need an account id (so a client whose
 * charges were switched off can still read what it created).
 */
function requireInvoicingClient(mode: "read" | "write") {
  return async function requireInvoicingClientGuard(request: FastifyRequest, reply: FastifyReply) {
    const authFailure = await requireApiKey(request, reply);
    if (reply.sent || authFailure) return;
    const client = (request as RequestWithClient).client;
    if (!client.invoicingEnabled) {
      return reply.code(403).send({
        error: "Invoicing is not enabled for this client.",
        code: "INVOICING_NOT_ENABLED",
      });
    }
    const usable = mode === "write" ? getChargeableAccountId(client) : client.stripeAccountId;
    if (!usable) {
      return reply.code(409).send({
        error: "Client Stripe account is not connected or cannot accept charges.",
        code: "ACCOUNT_NOT_CONNECTED",
      });
    }
  };
}

const accountOf = (request: FastifyRequest): string =>
  (request as RequestWithClient).client.stripeAccountId as string;

interface ReplayRequest {
  email: string;
  name?: string;
  phone?: string;
  externalRef?: string;
  userMetadata: Record<string, string>;
}

const norm = (v: string | null | undefined) => (v ?? "").trim();

/**
 * Does a replayed create carry the same request as the stored customer? Email, name, phone and
 * user metadata come from the Stripe customer (Postgres holds no PII), externalRef from the row.
 * Absent, null and empty compare equal; email is compared case-insensitively.
 */
function replayMatches(row: CustomerRow, customer: Stripe.Customer, req: ReplayRequest): boolean {
  if (norm(req.externalRef) !== norm(row.externalRef)) return false;
  if (norm(req.email).toLowerCase() !== norm(customer.email).toLowerCase()) return false;
  if (norm(req.name) !== norm(customer.name)) return false;
  if (norm(req.phone) !== norm(customer.phone)) return false;
  const stored = Object.entries(customer.metadata ?? {})
    .filter(([k]) => !k.startsWith(USER_METADATA_RESERVED_PREFIX))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const sent = Object.entries(req.userMetadata).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(stored) === JSON.stringify(sent);
}

export default async function connectInvoicingRoutes(fastify: FastifyInstance) {
  // A create that gives its claim back must do so BEFORE the response leaves, or a caller that
  // retries the moment it sees the error would find the row still claimed (IN_USE). Errors are
  // sent from inside the handler, so the release is also run from onSend.
  const pendingRelease = new WeakMap<FastifyRequest, () => Promise<void>>();
  fastify.addHook("onSend", async (request) => {
    const release = pendingRelease.get(request);
    if (release) {
      pendingRelease.delete(request);
      await release();
    }
  });

  const writeBucket = tokenBucketRateLimit({
    capacity: INVOICE_WRITE_BUCKET_CAPACITY,
    refillPerMinute: INVOICE_WRITE_REFILL_PER_MINUTE,
    keyGenerator: (request) => `stripe:${accountOf(request)}`,
  });
  const readLimit = rateLimit({
    max: INVOICE_READ_RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
    name: "connect-invoicing-read",
    keyGenerator: (request) => `client:${(request as RequestWithClient).client.id}`,
  });

  // The write token is taken inside each handler, after header and body validation, so a request
  // that fails with a 400 never spends one.
  const writeGuards = [requireInvoicingClient("write")];
  async function takeWriteToken(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    await writeBucket(request, reply);
    return !reply.sent;
  }
  const readGuards = [requireInvoicingClient("read"), readLimit];

  /**
   * Runs a Stripe call on the client's account through the circuit breaker. On failure it sends
   * the mapped error reply and returns undefined. `refundOnRefusal` gives the write token back
   * when the call was refused before reaching Stripe (busy, or circuit already open).
   */
  async function stripeCall<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    action: string,
    call: () => Promise<T>,
    opts: { write?: boolean; notFound?: string } = {}
  ): Promise<T | undefined> {
    let called = false;
    try {
      return await withStripeCircuit(() => {
        called = true;
        return call();
      });
    } catch (err) {
      if (opts.write && (isStripeBusyError(err) || (isCircuitOpenError(err) && !called))) {
        await writeBucket.refund(request);
      }
      // Ids and codes only: a Stripe error message may quote an email.
      request.log.error(
        {
          clientId: (request as RequestWithClient).client.id,
          action,
          stripeCode: (err as { code?: unknown } | null)?.code,
          stripeType: (err as { type?: unknown } | null)?.type,
        },
        "Connected-account invoicing Stripe call failed"
      );
      if (isResourceMissing(err)) {
        reply.code(404).send({ error: opts.notFound ?? "Customer not found.", code: "NOT_FOUND" });
        return undefined;
      }
      if (
        mapStripeError(err, reply, {
          circuitOpen: STRIPE_CIRCUIT_OPEN_ERROR,
          rateLimited: STRIPE_RATE_LIMITED_ERROR,
          permanentErrors: true,
        })
      )
        return undefined;
      throw errors.stripeFailed("Invoicing request failed. Please try again.");
    }
  }

  async function findOwned(clientId: string, stripeCustomerId: string) {
    const [row] = await db
      .select()
      .from(connectCustomers)
      .where(
        and(
          eq(connectCustomers.clientId, clientId),
          eq(connectCustomers.stripeCustomerId, stripeCustomerId)
        )
      )
      .limit(1);
    return row;
  }

  /** Retrieve the Customer from the client's account and reply with the sanitized view. */
  async function replyWithCustomer(
    request: FastifyRequest,
    reply: FastifyReply,
    row: CustomerRow,
    status = 200,
    replayOf?: ReplayRequest
  ) {
    const customer = await stripeCall(
      request,
      reply,
      "customers.retrieve",
      () =>
        stripe.customers.retrieve(row.stripeCustomerId, undefined, {
          stripeAccount: accountOf(request),
        }),
      { write: Boolean(replayOf) }
    );
    if (customer === undefined) return reply;
    if (isDeletedCustomer(customer)) {
      return reply.code(404).send({ error: "Customer not found.", code: "NOT_FOUND" });
    }
    if (replayOf && !replayMatches(row, customer, replayOf)) {
      return reply.code(409).send({
        error:
          "This Idempotency-Key was already used for a different customer. Use a new unique key for each new customer.",
        code: "IDEMPOTENCY_KEY_REUSED",
      });
    }
    return reply.code(status).send(sanitizeCustomer(row, customer));
  }

  // ── POST /customers ────────────────────────────────────────────────────────
  fastify.post("/customers", { preHandler: writeGuards }, async (request, reply) => {
    const client = (request as RequestWithClient).client;
    const clientId = client.id;
    const stripeAccount = accountOf(request);

    const keyHeader = extractIdempotencyKey(request);
    if (!keyHeader || keyHeader.trim().length === 0) {
      throw errors.badRequest("Idempotency-Key header is required.");
    }
    const rawKey = keyHeader.trim();
    if (rawKey.length > 255) {
      throw errors.badRequest("Idempotency-Key must not exceed 255 characters.");
    }
    // Only a hash of the caller's key is stored and sent to Stripe: the key is free text and could
    // otherwise carry personal data into Postgres.
    const idempotencyKey = createHash("sha256").update(rawKey).digest("hex");
    const stripeIdempotencyKey = `${clientId}:cust:${idempotencyKey}`;

    const body = parseBody(createBodySchema, request.body, reply);
    if (!body) return;

    const userMetadata = validateStripeMetadata(body.metadata);
    if (Object.keys(userMetadata).some((k) => k.startsWith(USER_METADATA_RESERVED_PREFIX))) {
      throw errors.badRequest(
        `metadata keys starting with '${USER_METADATA_RESERVED_PREFIX}' are reserved.`
      );
    }
    const metadata = validateStripeMetadata({
      ...userMetadata,
      dfwsc_client_id: clientId,
      ...(body.externalRef ? { dfwsc_external_ref: body.externalRef } : {}),
    });

    if (!(await takeWriteToken(request, reply))) return;

    // Same (client, Idempotency-Key) again: answer with the stored customer, no new Stripe create.
    // Checked before externalRef so a retry of a request that already succeeded is a replay, not a
    // CUSTOMER_EXISTS conflict with itself.
    const [replay] = await db
      .select()
      .from(connectCustomers)
      .where(
        and(
          eq(connectCustomers.clientId, clientId),
          eq(connectCustomers.idempotencyKey, idempotencyKey)
        )
      )
      .limit(1);
    if (replay) {
      return replyWithCustomer(request, reply, replay, 200, {
        email: body.email,
        name: body.name,
        phone: body.phone,
        externalRef: body.externalRef,
        userMetadata,
      });
    }

    // Existing externalRef: conflict, decided locally before any Stripe call.
    if (body.externalRef) {
      const [existing] = await db
        .select()
        .from(connectCustomers)
        .where(
          and(
            eq(connectCustomers.clientId, clientId),
            eq(connectCustomers.externalRef, body.externalRef)
          )
        )
        .limit(1);
      if (existing) return customerExists(reply, existing.stripeCustomerId);
    }

    const params: Stripe.CustomerCreateParams = {
      email: body.email,
      metadata,
      ...(body.name ? { name: body.name } : {}),
      ...(body.phone ? { phone: body.phone } : {}),
    };
    const created = await stripeCall(
      request,
      reply,
      "customers.create",
      () =>
        stripe.customers.create(params, { stripeAccount, idempotencyKey: stripeIdempotencyKey }),
      { write: true }
    );
    if (!created) return reply;

    const row: CustomerRow = {
      id: uuidv4(),
      clientId,
      connectedAccountId: stripeAccount,
      stripeCustomerId: created.id,
      externalRef: body.externalRef ?? null,
      idempotencyKey,
      createdAt: new Date(),
    };
    try {
      await db.insert(connectCustomers).values(row);
    } catch (err) {
      if (!isUniqueViolation(err)) {
        request.log.error(
          { clientId, stripeCustomerId: created.id },
          "Customer created on Stripe but not recorded; returning 503"
        );
        return reply.code(503).send({
          error:
            "Customer created but confirmation failed. Please retry with the same Idempotency-Key.",
          code: "CUSTOMER_PERSISTENCE_FAILED",
        });
      }
      return handleInsertRace(request, reply, row);
    }

    return reply.code(201).send(sanitizeCustomer(row, created));
  });

  function customerExists(reply: FastifyReply, id: string) {
    return reply.code(409).send({
      error: "A customer with this externalRef already exists.",
      code: "CUSTOMER_EXISTS",
      id,
    });
  }

  /**
   * A unique violation after the Stripe create. Three cases:
   * - the same Idempotency-Key raced itself and both got the same Stripe customer: answer with the
   *   stored one, delete nothing;
   * - the externalRef was taken in between: this request's Stripe customer is an orphan, so it is
   *   deleted on a best effort (only if no stored row references it) and the caller gets 409
   *   CUSTOMER_EXISTS. A failed delete only leaves an unreferenced customer on the client's own
   *   account (its id is logged);
   * - anything else: nothing is deleted and the caller gets 503 CUSTOMER_PERSISTENCE_FAILED, to
   *   retry with the same key (Stripe hands back the same customer inside its 24 hour window).
   */
  async function handleInsertRace(
    request: FastifyRequest,
    reply: FastifyReply,
    row: CustomerRow
  ): Promise<FastifyReply> {
    const [sameKey] = await db
      .select()
      .from(connectCustomers)
      .where(
        and(
          eq(connectCustomers.clientId, row.clientId),
          eq(connectCustomers.idempotencyKey, row.idempotencyKey)
        )
      )
      .limit(1);
    if (sameKey && sameKey.stripeCustomerId === row.stripeCustomerId) {
      return replyWithCustomer(request, reply, sameKey, 200);
    }

    const [existing] = row.externalRef
      ? await db
          .select()
          .from(connectCustomers)
          .where(
            and(
              eq(connectCustomers.clientId, row.clientId),
              eq(connectCustomers.externalRef, row.externalRef)
            )
          )
          .limit(1)
      : [];
    if (!existing) {
      request.log.error(
        { clientId: row.clientId, stripeCustomerId: row.stripeCustomerId },
        "Customer insert hit an unexpected unique violation; returning 503"
      );
      return reply.code(503).send({
        error:
          "Customer created but confirmation failed. Please retry with the same Idempotency-Key.",
        code: "CUSTOMER_PERSISTENCE_FAILED",
      });
    }

    const [referenced] = await db
      .select({ id: connectCustomers.id })
      .from(connectCustomers)
      .where(
        and(
          eq(connectCustomers.connectedAccountId, row.connectedAccountId),
          eq(connectCustomers.stripeCustomerId, row.stripeCustomerId)
        )
      )
      .limit(1);
    if (!referenced) {
      try {
        await withStripeCircuit(() =>
          stripe.customers.del(row.stripeCustomerId, undefined, {
            stripeAccount: row.connectedAccountId,
          })
        );
      } catch {
        request.log.warn(
          { clientId: row.clientId, stripeCustomerId: row.stripeCustomerId },
          "Could not delete orphan Stripe customer after insert race"
        );
      }
    }
    return customerExists(reply, existing.stripeCustomerId);
  }

  // ── GET /customers?externalRef= ────────────────────────────────────────────
  fastify.get("/customers", { preHandler: readGuards }, async (request, reply) => {
    const query = parseBody(lookupQuerySchema, request.query, reply);
    if (!query) return;
    const [row] = await db
      .select()
      .from(connectCustomers)
      .where(
        and(
          eq(connectCustomers.clientId, (request as RequestWithClient).client.id),
          eq(connectCustomers.externalRef, query.externalRef)
        )
      )
      .limit(1);
    if (!row) return reply.code(404).send({ error: "Customer not found.", code: "NOT_FOUND" });
    return replyWithCustomer(request, reply, row);
  });

  // ── GET /customers/:id ─────────────────────────────────────────────────────
  fastify.get("/customers/:id", { preHandler: readGuards }, async (request, reply) => {
    const params = parseBody(idParamsSchema, request.params, reply);
    if (!params) return;
    const row = await findOwned((request as RequestWithClient).client.id, params.id);
    if (!row) return reply.code(404).send({ error: "Customer not found.", code: "NOT_FOUND" });
    return replyWithCustomer(request, reply, row);
  });

  // ── PATCH /customers/:id ───────────────────────────────────────────────────
  fastify.patch("/customers/:id", { preHandler: writeGuards }, async (request, reply) => {
    const params = parseBody(idParamsSchema, request.params, reply);
    if (!params) return;
    const body = parseBody(updateBodySchema, request.body, reply);
    if (!body) return;
    if (!(await takeWriteToken(request, reply))) return;
    const row = await findOwned((request as RequestWithClient).client.id, params.id);
    if (!row) return reply.code(404).send({ error: "Customer not found.", code: "NOT_FOUND" });

    const update: Stripe.CustomerUpdateParams = {
      ...(body.email !== undefined ? { email: body.email } : {}),
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
    };
    const updated = await stripeCall(
      request,
      reply,
      "customers.update",
      () =>
        stripe.customers.update(row.stripeCustomerId, update, {
          stripeAccount: accountOf(request),
        }),
      { write: true }
    );
    if (!updated) return reply;
    return reply.code(200).send(sanitizeCustomer(row, updated));
  });

  // ══ Invoices ═══════════════════════════════════════════════════════════════
  // Draft invoices on the client's connected account, plus reads. The row in connect_invoices is
  // stored BEFORE any Stripe call and doubles as the idempotency record and the resume point.

  const INVOICE_NOT_FOUND = { error: "Invoice not found.", code: "NOT_FOUND" };

  /** The create lost its claim to another request (the lease ran out): the other one owns it now. */
  class ClaimLostError extends Error {}
  /** Postgres failed after Stripe had already done something: the caller retries with the same key. */
  class PersistenceError extends Error {}

  const invoiceKeyInUse = (reply: FastifyReply) =>
    reply.code(409).send({
      error: "A request with this Idempotency-Key is already being processed. Retry shortly.",
      code: "IDEMPOTENCY_KEY_IN_USE",
    });

  const findInvoiceByKey = async (clientId: string, keyHash: string) =>
    (
      await db
        .select()
        .from(connectInvoices)
        .where(
          and(eq(connectInvoices.clientId, clientId), eq(connectInvoices.idempotencyKey, keyHash))
        )
        .limit(1)
    )[0];

  /**
   * Writes progress on a row this request holds the claim on. A row that is no longer claimed by
   * this request (the lease expired and another request took over) means stop: ClaimLostError.
   * Any Postgres failure becomes a PersistenceError (503, retry with the same key).
   */
  async function saveProgress(
    row: InvoiceRow,
    claimAt: Date,
    patch: Partial<typeof connectInvoices.$inferInsert>
  ): Promise<InvoiceRow> {
    let updated: InvoiceRow | undefined;
    try {
      [updated] = await db
        .update(connectInvoices)
        .set(patch)
        .where(and(eq(connectInvoices.id, row.id), eq(connectInvoices.claimedAt, claimAt)))
        .returning();
    } catch (err) {
      throw new PersistenceError("invoice progress not saved", { cause: err });
    }
    if (!updated) throw new ClaimLostError();
    return updated;
  }

  // Look-ups used only when a resumed create is older than Stripe's idempotency window, where the
  // per-step keys no longer protect against a duplicate. The objects carry our metadata.
  async function findAdoptableInvoice(
    step: Step,
    stripeAccount: string,
    row: InvoiceRow,
    keyHash: string
  ): Promise<Stripe.Invoice | null | undefined> {
    const since = Math.floor(row.createdAt.getTime() / 1000) - 300;
    let startingAfter: string | undefined;
    for (let page = 0; page < 10; page++) {
      const list = await step("invoices.list", () =>
        stripe.invoices.list(
          {
            customer: row.stripeCustomerId,
            created: { gte: since },
            limit: 100,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          },
          { stripeAccount }
        )
      );
      if (!list) return undefined;
      const hit = list.data.find(
        (i) =>
          i.metadata?.dfwsc_idem_key === keyHash && i.metadata?.dfwsc_client_id === row.clientId
      );
      if (hit) return hit;
      const last = list.data[list.data.length - 1];
      if (!list.has_more || !last) return null;
      startingAfter = last.id;
    }
    return null;
  }

  type Step = <T>(action: string, call: () => Promise<T>) => Promise<T | undefined>;

  /**
   * Runs the create steps from wherever the row left off. Returns the completed row, or undefined
   * after sending an error reply. Throws ClaimLostError / PersistenceError (handled by the caller).
   *
   * Steps, each with its own Stripe idempotency key and its Stripe id saved before the next one:
   *   invoice ('invoice_created') -> one item per line, then the fee item ('lines_added') ->
   *   retrieve, verify, complete.
   */
  async function driveCreate(
    request: FastifyRequest,
    reply: FastifyReply,
    initial: InvoiceRow,
    claimAt: Date,
    req: InvoiceRequest,
    keyHash: string,
    resumed: boolean
  ): Promise<InvoiceRow | undefined> {
    const client = (request as RequestWithClient).client;
    const stripeAccount = accountOf(request);
    const idemBase = `${client.id}:inv:${keyHash}`;

    // Only a request that has not yet reached Stripe gives its write token back when refused.
    let succeeded = 0;
    const step: Step = async (action, call) => {
      const out = await stripeCall(request, reply, action, call, {
        write: succeeded === 0,
        notFound: "Customer or invoice not found on the connected account.",
      });
      if (out !== undefined) succeeded += 1;
      return out;
    };

    let cur = initial;
    const beyondKeyWindow =
      resumed && Date.now() - cur.createdAt.getTime() >= INVOICE_STRIPE_KEY_WINDOW_MS;
    const baseMetadata = { dfwsc_client_id: client.id, dfwsc_idem_key: keyHash };

    // 1. The invoice.
    if (!cur.stripeInvoiceId) {
      let invoice: Stripe.Invoice | null | undefined = null;
      if (beyondKeyWindow) {
        invoice = await findAdoptableInvoice(step, stripeAccount, cur, keyHash);
        if (invoice === undefined) return undefined;
      }
      if (!invoice) {
        const metadata = validateStripeMetadata({ ...req.userMetadata, ...baseMetadata });
        const params: Stripe.InvoiceCreateParams = {
          customer: cur.stripeCustomerId,
          collection_method: "send_invoice",
          days_until_due: req.daysUntilDue,
          auto_advance: false,
          pending_invoice_items_behavior: "exclude",
          currency: "usd",
          // The fee is the stored one: a retry after a fee-setting change must send what the
          // first attempt did (Stripe refuses an idempotent call with other parameters).
          ...(cur.feeAmountCents > 0 ? { application_fee_amount: cur.feeAmountCents } : {}),
          ...(req.description ? { description: req.description } : {}),
          ...(req.footer ? { footer: req.footer } : {}),
          metadata,
        };
        invoice = await step("invoices.create", () =>
          stripe.invoices.create(params, {
            stripeAccount,
            idempotencyKey: `${idemBase}:invoice`,
          })
        );
        if (!invoice) return undefined;
      }
      cur = await saveProgress(cur, claimAt, {
        stripeInvoiceId: invoice.id,
        creationState: "invoice_created",
      });
    }
    const invoiceId = cur.stripeInvoiceId as string;

    // 2. One invoice item per line, then the fee item.
    if (cur.creationState === "invoice_created") {
      const ids: string[] = Array.isArray(cur.lineItemIds) ? (cur.lineItemIds as string[]) : [];
      const wantFee = cur.feeAmountCents > 0;
      const incomplete = ids.length < req.lines.length || (wantFee && !cur.stripeFeeItemId);
      let known = new Map<string, string>();
      if (beyondKeyWindow && incomplete) {
        const list = await step("invoiceItems.list", () =>
          stripe.invoiceItems.list({ invoice: invoiceId, limit: 100 }, { stripeAccount })
        );
        if (!list) return undefined;
        known = new Map(
          list.data.flatMap((it) =>
            it.metadata?.dfwsc_idem_key === keyHash && typeof it.metadata.dfwsc_line === "string"
              ? [[it.metadata.dfwsc_line, it.id] as [string, string]]
              : []
          )
        );
      }

      const createItem = async (
        tag: string,
        item: { description: string; quantity: number; unitAmountCents: number }
      ): Promise<string | undefined> => {
        const adopted = known.get(tag);
        if (adopted) return adopted;
        // A line keeps its quantity and unit amount on the invoice: quantity plus
        // unit_amount_decimal (price_data would need a Product).
        const created = await step(`invoiceItems.create:${tag}`, () =>
          stripe.invoiceItems.create(
            {
              customer: cur.stripeCustomerId,
              invoice: invoiceId,
              currency: "usd",
              description: item.description,
              quantity: item.quantity,
              unit_amount_decimal: String(item.unitAmountCents),
              metadata: { ...baseMetadata, dfwsc_line: tag },
            },
            {
              stripeAccount,
              idempotencyKey: `${idemBase}:${tag === "fee" ? "fee" : `line:${tag}`}`,
            }
          )
        );
        return created?.id;
      };

      for (let i = ids.length; i < req.lines.length; i++) {
        const id = await createItem(String(i), req.lines[i]);
        if (!id) return undefined;
        ids.push(id);
        cur = await saveProgress(cur, claimAt, { lineItemIds: [...ids] });
      }
      if (wantFee && !cur.stripeFeeItemId) {
        const id = await createItem("fee", {
          description: PROCESSING_FEE_DESCRIPTION,
          quantity: 1,
          unitAmountCents: cur.feeAmountCents,
        });
        if (!id) return undefined;
        cur = await saveProgress(cur, claimAt, { stripeFeeItemId: id });
      }
      cur = await saveProgress(cur, claimAt, { creationState: "lines_added" });
    }

    // 3. Re-read the invoice, check Stripe agrees with our arithmetic, and complete.
    const fresh = await step("invoices.retrieve", () =>
      stripe.invoices.retrieve(invoiceId, {}, { stripeAccount })
    );
    if (!fresh) return undefined;
    // `application_fee_amount` is not on the clover Invoice type, but is read when present.
    const stripeFee = (fresh as unknown as { application_fee_amount?: number | null })
      .application_fee_amount;
    if (
      fresh.total !== cur.totalCents ||
      fresh.subtotal !== cur.totalCents ||
      fresh.currency !== "usd" ||
      fresh.status !== "draft" ||
      cur.feeAmountCents > fresh.total ||
      (typeof stripeFee === "number" && stripeFee !== cur.feeAmountCents)
    ) {
      // The draft stays on the connected account, unsent and uncollectable; the row stays at
      // 'lines_added' (hidden from reads) so the next retry checks again.
      request.log.error(
        {
          clientId: client.id,
          stripeInvoiceId: invoiceId,
          expectedTotalCents: cur.totalCents,
          stripeTotalCents: fresh.total,
          stripeSubtotalCents: fresh.subtotal,
          expectedFeeCents: cur.feeAmountCents,
          stripeFeeCents: stripeFee,
          stripeStatus: fresh.status,
        },
        "Stripe invoice does not match the computed amounts; leaving the draft"
      );
      reply.code(502).send({
        error:
          "The invoice could not be verified against the computed amounts. It was left as an unsent draft.",
        code: "INVOICE_TOTAL_MISMATCH",
      });
      return undefined;
    }
    return saveProgress(cur, claimAt, {
      creationState: "complete",
      status: "draft",
      // Lines before the fee; Stripe's own subtotal already includes the fee item.
      subtotalCents: fresh.subtotal - cur.feeAmountCents,
      totalCents: fresh.total,
      amountPaidCents: fresh.amount_paid,
      amountRemainingCents: fresh.amount_remaining,
      number: fresh.number ?? null,
      dueDate: fresh.due_date ? new Date(fresh.due_date * 1000) : null,
      hostedInvoiceUrl: fresh.hosted_invoice_url ?? null,
      invoicePdf: fresh.invoice_pdf ?? null,
      lastSyncedAt: new Date(),
      claimedAt: null,
    });
  }

  // ── POST /invoices ─────────────────────────────────────────────────────────
  fastify.post("/invoices", { preHandler: writeGuards }, async (request, reply) => {
    const client = (request as RequestWithClient).client;
    const clientId = client.id;
    const stripeAccount = accountOf(request);

    const keyHeader = extractIdempotencyKey(request);
    if (!keyHeader || keyHeader.trim().length === 0) {
      throw errors.badRequest("Idempotency-Key header is required.");
    }
    const rawKey = keyHeader.trim();
    if (rawKey.length > 255) {
      throw errors.badRequest("Idempotency-Key must not exceed 255 characters.");
    }
    // Only a hash of the caller's key is stored and sent to Stripe (free text could carry PII).
    const keyHash = createHash("sha256").update(rawKey).digest("hex");

    // Finalizing and sending are separate steps for now. Refused, not ignored: a caller that
    // sends `send: true` must not believe the invoice went out.
    const raw = request.body;
    if (raw && typeof raw === "object" && ("finalize" in raw || "send" in raw)) {
      throw errors.badRequest(
        "finalize and send are not supported when creating an invoice; the invoice is created as a draft."
      );
    }
    const body = parseBody(createInvoiceBodySchema, request.body, reply);
    if (!body) return;

    const userMetadata = validateStripeMetadata(body.metadata);
    if (Object.keys(userMetadata).some((k) => k.startsWith(USER_METADATA_RESERVED_PREFIX))) {
      throw errors.badRequest(
        `metadata keys starting with '${USER_METADATA_RESERVED_PREFIX}' are reserved.`
      );
    }
    // Leaves room for the two keys this API adds.
    validateStripeMetadata({ ...userMetadata, dfwsc_client_id: clientId, dfwsc_idem_key: keyHash });

    const terms = client.defaultPaymentTermsDays;
    const daysUntilDue =
      body.daysUntilDue ??
      (terms !== null && Number.isInteger(terms) && terms >= 1 && terms <= 365
        ? terms
        : DEFAULT_DAYS_UNTIL_DUE);
    const baseCents = computeBaseCents(body.lines);
    const req: InvoiceRequest = {
      customerId: body.customerId,
      lines: body.lines.map((l) => ({
        description: l.description,
        unitAmountCents: l.unitAmountCents,
        quantity: l.quantity,
      })),
      currency: "usd",
      daysUntilDue,
      description: body.description ?? null,
      footer: body.footer ?? null,
      userMetadata,
    };
    const requestHash = hashInvoiceRequest(req);

    // Everything below that can answer 4xx runs before the first Stripe call.
    let tokenTaken = false;
    let row = await findInvoiceByKey(clientId, keyHash);
    let claimAt = new Date();
    let claimed = false;

    if (!row) {
      const group = client.groupId
        ? ((
            await db.select().from(clientGroups).where(eq(clientGroups.id, client.groupId)).limit(1)
          )[0] ?? null)
        : null;
      let feeCents: number;
      try {
        // API keys can never waive the fee: waiveFee is not part of the body.
        feeCents = await resolveClientFee(client, group, baseCents);
      } catch (e: unknown) {
        throw errors.badRequest((e as Error).message);
      }
      if (!Number.isSafeInteger(feeCents) || feeCents < 0) {
        throw errors.badRequest("Computed fee is invalid.");
      }
      const totalCents = baseCents + feeCents;
      assertTotalWithinCap(totalCents);

      // The customer must be this client's, on this client's connected account.
      const [customer] = await db
        .select({ id: connectCustomers.id })
        .from(connectCustomers)
        .where(
          and(
            eq(connectCustomers.clientId, clientId),
            eq(connectCustomers.connectedAccountId, stripeAccount),
            eq(connectCustomers.stripeCustomerId, req.customerId)
          )
        )
        .limit(1);
      if (!customer) {
        return reply.code(404).send({ error: "Customer not found.", code: "NOT_FOUND" });
      }

      // Rolling 24 hour ceiling, counted from connect_invoices. Two requests racing the last slot
      // can overshoot by one; the ceiling is a runaway guard, not an exact quota.
      const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [usage] = await db
        .select({ n: count(), oldest: min(connectInvoices.createdAt) })
        .from(connectInvoices)
        .where(
          and(eq(connectInvoices.clientId, clientId), gte(connectInvoices.createdAt, windowStart))
        );
      if (usage.n >= INVOICE_DAILY_CREATE_LIMIT) {
        const retryMs = usage.oldest
          ? usage.oldest.getTime() + 24 * 60 * 60 * 1000 - Date.now()
          : 60_000;
        return reply
          .code(429)
          .header("Retry-After", String(Math.max(1, Math.ceil(retryMs / 1000))))
          .send({
            error: `At most ${INVOICE_DAILY_CREATE_LIMIT} invoices can be created per day.`,
            code: "INVOICE_DAILY_LIMIT",
          });
      }

      if (!(await takeWriteToken(request, reply))) return;
      tokenTaken = true;

      // Store BEFORE Stripe. A concurrent request with the same key loses this insert and is
      // handled as a replay below.
      const [inserted] = await db
        .insert(connectInvoices)
        .values({
          id: uuidv4(),
          clientId,
          connectedAccountId: stripeAccount,
          stripeCustomerId: req.customerId,
          idempotencyKey: keyHash,
          requestHash,
          creationState: "reserved",
          status: "draft",
          currency: "usd",
          subtotalCents: baseCents,
          feeAmountCents: feeCents,
          totalCents,
          amountRemainingCents: totalCents,
          claimedAt: claimAt,
          // Millisecond precision on purpose: the list cursor round-trips this value exactly.
          createdAt: claimAt,
        })
        .onConflictDoNothing({
          target: [connectInvoices.clientId, connectInvoices.idempotencyKey],
        })
        .returning();
      if (inserted) {
        row = inserted;
        claimed = true;
      } else {
        row = await findInvoiceByKey(clientId, keyHash);
        if (!row) throw errors.internal();
      }
    }

    if (row.requestHash !== requestHash) {
      return reply.code(409).send({
        error:
          "This Idempotency-Key was already used for a different invoice. Use a new unique key for each new invoice.",
        code: "IDEMPOTENCY_KEY_REUSED",
      });
    }
    if (row.creationState === "complete") {
      return reply.code(200).send(serializeInvoice(row));
    }

    if (!claimed) {
      // Resume: take the claim unless another request holds a live one.
      if (!tokenTaken && !(await takeWriteToken(request, reply))) return;
      claimAt = new Date();
      const [taken] = await db
        .update(connectInvoices)
        .set({ claimedAt: claimAt })
        .where(
          and(
            eq(connectInvoices.id, row.id),
            ne(connectInvoices.creationState, "complete"),
            or(
              isNull(connectInvoices.claimedAt),
              lt(connectInvoices.claimedAt, new Date(claimAt.getTime() - INVOICE_CLAIM_LEASE_MS))
            )
          )
        )
        .returning();
      if (!taken) {
        const latest = await findInvoiceByKey(clientId, keyHash);
        if (latest?.creationState === "complete") {
          return reply.code(200).send(serializeInvoice(latest));
        }
        if (tokenTaken) await writeBucket.refund(request);
        return invoiceKeyInUse(reply);
      }
      row = taken;
    }

    // Give the claim back so an immediate retry resumes instead of waiting out the lease. A
    // finished row already cleared it. Best effort: the lease expires on its own.
    const releaseClaim = async () => {
      await db
        .update(connectInvoices)
        .set({ claimedAt: null })
        .where(and(eq(connectInvoices.id, row.id), eq(connectInvoices.claimedAt, claimAt)))
        .catch(() => undefined);
    };
    pendingRelease.set(request, releaseClaim);

    let done: InvoiceRow | undefined;
    try {
      done = await driveCreate(request, reply, row, claimAt, req, keyHash, !claimed);
    } catch (err) {
      if (err instanceof ClaimLostError) return invoiceKeyInUse(reply);
      if (err instanceof PersistenceError) {
        // The driver error quotes the failed query's parameters (which can include a hosted
        // URL), so only its SQLSTATE is logged.
        const dbCode = (err.cause as { cause?: { code?: unknown } } | undefined)?.cause?.code;
        request.log.error(
          { clientId, invoiceRowId: row.id, dbCode },
          "Invoice step done on Stripe but not recorded; returning 503"
        );
        return reply.code(503).send({
          error:
            "Invoice created but confirmation failed. Please retry with the same Idempotency-Key.",
          code: "LEDGER_PERSISTENCE_FAILED",
        });
      }
      throw err;
    } finally {
      pendingRelease.delete(request);
      await releaseClaim();
    }
    if (!done) return reply;
    return reply.code(201).send(serializeInvoice(done));
  });

  // ── Stale re-check (GET /invoices/:id) ─────────────────────────────────────
  // At most one Stripe lookup per invoice per interval and a bounded map, in process (the same
  // shape as the payments status reconcile).
  const lastInvoiceReconcile = new Map<string, number>();
  const RECONCILE_MAX_TRACKED = 1000;
  const RECONCILE_STRIPE_TIMEOUT_MS = 3000;

  function shouldAttemptInvoiceReconcile(key: string, now: number): boolean {
    const last = lastInvoiceReconcile.get(key);
    if (last !== undefined && now - last < INVOICE_RECONCILE_MIN_AGE_MS) return false;
    if (lastInvoiceReconcile.size >= RECONCILE_MAX_TRACKED) {
      for (const [k, at] of lastInvoiceReconcile) {
        if (now - at >= INVOICE_RECONCILE_MIN_AGE_MS) lastInvoiceReconcile.delete(k);
      }
      if (lastInvoiceReconcile.size >= RECONCILE_MAX_TRACKED) {
        const oldest = lastInvoiceReconcile.keys().next().value;
        if (oldest !== undefined) lastInvoiceReconcile.delete(oldest);
      }
    }
    lastInvoiceReconcile.set(key, now);
    return true;
  }

  /** Returns the row to report: refreshed from Stripe when stale, else as stored. Never throws. */
  async function reconcileStaleInvoice(
    row: InvoiceRow,
    request: FastifyRequest
  ): Promise<InvoiceRow> {
    const invoiceId = row.stripeInvoiceId;
    const now = Date.now();
    if (!invoiceId || (TERMINAL_INVOICE_STATUSES as readonly string[]).includes(row.status)) {
      return row;
    }
    const syncedAt = (row.lastSyncedAt ?? row.createdAt).getTime();
    if (now - syncedAt < INVOICE_RECONCILE_MIN_AGE_MS) return row;
    // Best effort on a read endpoint: honour an open breaker, but run the lookup outside it so
    // its failures do not count towards the breaker that guards invoice writes.
    if (getCircuitBreakerStates().stripe.open) return row;
    if (!shouldAttemptInvoiceReconcile(`${row.connectedAccountId}:${invoiceId}`, now)) return row;

    try {
      const invoice = await stripe.invoices.retrieve(
        invoiceId,
        {},
        {
          stripeAccount: row.connectedAccountId,
          timeout: RECONCILE_STRIPE_TIMEOUT_MS,
          maxNetworkRetries: 0,
        }
      );
      const status = invoice.status;
      if (!status) return row;
      const at = (s: number | null | undefined) => (s ? new Date(s * 1000) : undefined);
      const transitions = invoice.status_transitions;
      const [updated] = await db
        .update(connectInvoices)
        .set({
          status,
          totalCents: invoice.total,
          amountPaidCents: invoice.amount_paid,
          amountRemainingCents: invoice.amount_remaining,
          number: invoice.number ?? null,
          dueDate: invoice.due_date ? new Date(invoice.due_date * 1000) : null,
          hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
          invoicePdf: invoice.invoice_pdf ?? null,
          ...(at(transitions?.finalized_at) ? { finalizedAt: at(transitions.finalized_at) } : {}),
          ...(at(transitions?.paid_at) ? { paidAt: at(transitions.paid_at) } : {}),
          ...(at(transitions?.voided_at) ? { voidedAt: at(transitions.voided_at) } : {}),
          lastSyncedAt: new Date(),
        })
        .where(eq(connectInvoices.id, row.id))
        .returning();
      return updated ?? row;
    } catch (err) {
      // Codes only: a Stripe error message may quote customer data.
      request.log.warn(
        {
          clientId: row.clientId,
          stripeInvoiceId: invoiceId,
          stripeCode: (err as { code?: unknown } | null)?.code,
        },
        "Invoice status re-check with Stripe failed"
      );
      return row;
    }
  }

  // ── GET /invoices/:id ──────────────────────────────────────────────────────
  fastify.get("/invoices/:id", { preHandler: readGuards }, async (request, reply) => {
    const params = parseBody(idParamsSchema, request.params, reply);
    if (!params) return;
    const [row] = await db
      .select()
      .from(connectInvoices)
      .where(
        and(
          eq(connectInvoices.clientId, (request as RequestWithClient).client.id),
          eq(connectInvoices.stripeInvoiceId, params.id),
          eq(connectInvoices.creationState, "complete")
        )
      )
      .limit(1);
    if (!row) return reply.code(404).send(INVOICE_NOT_FOUND);
    return reply.code(200).send(serializeInvoice(await reconcileStaleInvoice(row, request)));
  });

  // ── GET /invoices ──────────────────────────────────────────────────────────
  // Postgres only, newest first, keyset-paged on (created_at desc, id asc).
  fastify.get("/invoices", { preHandler: readGuards }, async (request, reply) => {
    const query = parseBody(listQuerySchema, request.query, reply);
    if (!query) return;
    let after: { createdAt: Date; id: string } | null = null;
    if (query.cursor) {
      after = decodeCursor(query.cursor);
      if (!after) throw errors.badRequest("cursor is invalid.");
    }
    const rows = await db
      .select()
      .from(connectInvoices)
      .where(
        and(
          eq(connectInvoices.clientId, (request as RequestWithClient).client.id),
          eq(connectInvoices.creationState, "complete"),
          query.status ? eq(connectInvoices.status, query.status) : undefined,
          query.customerId ? eq(connectInvoices.stripeCustomerId, query.customerId) : undefined,
          after
            ? or(
                lt(connectInvoices.createdAt, after.createdAt),
                and(
                  eq(connectInvoices.createdAt, after.createdAt),
                  sql`${connectInvoices.id} > ${after.id}`
                )
              )
            : undefined
        )
      )
      .orderBy(desc(connectInvoices.createdAt), asc(connectInvoices.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return reply.code(200).send({
      data: page.map(serializeInvoice),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
    });
  });
}
