import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Stripe from "stripe";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { db } from "../../db/client";
import { connectCustomers } from "../../db/schema";
import { withStripeCircuit } from "../../lib/circuit-breakers";
import { isUniqueViolation } from "../../lib/errors";
import { stripe } from "../../lib/stripe";
import { validateStripeMetadata } from "../../lib/stripe-input";
import { parseBody } from "../../lib/validation";
import {
  accountOf,
  assertNoReservedMetadataKeys,
  type InvoicingDeps,
  idParamsSchema,
  parseIdempotencyKeyHash,
  type RequestWithClient,
  USER_METADATA_RESERVED_PREFIX,
} from "./shared";

type CustomerRow = typeof connectCustomers.$inferSelect;

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

const lookupQuerySchema = z.object({
  externalRef: z
    .string({ error: "externalRef query parameter is required." })
    .trim()
    .min(1, "externalRef query parameter is required.")
    .max(100, "externalRef must not exceed 100 characters."),
});

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
export function replayMatches(
  row: CustomerRow,
  customer: Stripe.Customer,
  req: ReplayRequest
): boolean {
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

/** Customer routes: create (idempotent), look up by externalRef or id, update. */
export function registerCustomerRoutes(fastify: FastifyInstance, deps: InvoicingDeps) {
  const { readGuards, writeGuards, stripeCall, takeWriteToken } = deps;

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

    // Only a hash of the caller's key is stored and sent to Stripe (see parseIdempotencyKeyHash).
    const idempotencyKey = parseIdempotencyKeyHash(request);
    const stripeIdempotencyKey = `${clientId}:cust:${idempotencyKey}`;

    const body = parseBody(createBodySchema, request.body, reply);
    if (!body) return;

    const userMetadata = validateStripeMetadata(body.metadata);
    assertNoReservedMetadataKeys(userMetadata);
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
