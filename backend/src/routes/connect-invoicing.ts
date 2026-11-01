import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Stripe from "stripe";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { db } from "../db/client";
import { type clients, connectCustomers } from "../db/schema";
import { requireApiKey } from "../lib/auth";
import { isCircuitOpenError, isStripeBusyError, withStripeCircuit } from "../lib/circuit-breakers";
import { getChargeableAccountId } from "../lib/connected-account";
import {
  INVOICE_READ_RATE_LIMIT_MAX,
  INVOICE_WRITE_BUCKET_CAPACITY,
  INVOICE_WRITE_REFILL_PER_MINUTE,
  RATE_LIMIT_WINDOW_MS,
} from "../lib/constants";
import { errors, isUniqueViolation } from "../lib/errors";
import { rateLimit, tokenBucketRateLimit } from "../lib/rate-limit";
import { stripe } from "../lib/stripe";
import { mapStripeError } from "../lib/stripe-errors";
import { validateStripeMetadata } from "../lib/stripe-input";
import { parseBody } from "../lib/validation";

// Connected-account invoicing, customers only (invoices land in a later change). Every Stripe call
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
    opts: { write?: boolean } = {}
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
        "Connected-account customer Stripe call failed"
      );
      if (isResourceMissing(err)) {
        reply.code(404).send({ error: "Customer not found.", code: "NOT_FOUND" });
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
}
