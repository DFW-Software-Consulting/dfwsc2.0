import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import type { clients } from "../../db/schema";
import { requireApiKey } from "../../lib/auth";
import {
  isCircuitOpenError,
  isStripeBusyError,
  withStripeCircuit,
} from "../../lib/circuit-breakers";
import {
  CARD_PAYMENTS_NOT_ACTIVE_ERROR,
  getChargeableAccountId,
} from "../../lib/connected-account";
import {
  INVOICE_READ_RATE_LIMIT_MAX,
  INVOICE_WRITE_BUCKET_CAPACITY,
  INVOICE_WRITE_REFILL_PER_MINUTE,
  RATE_LIMIT_WINDOW_MS,
} from "../../lib/constants";
import { errors } from "../../lib/errors";
import { rateLimit, tokenBucketRateLimit } from "../../lib/rate-limit";
import { errorLogFields } from "../../lib/safe-error-log";
import { resolveCardPaymentsStatus } from "../../lib/stripe-connect-account";
import { mapStripeError } from "../../lib/stripe-errors";

// Connected-account invoicing: customers, and draft invoices with their reads. Every Stripe call
// is a DIRECT call on the client's own Express account: `stripeAccount` is passed on every call,
// and the platform's billing_customers are never involved. Postgres keeps ids and an opaque
// externalRef only; email, name and phone live on Stripe and are never logged.
//
// This file holds what every route module shares: types, error bodies, the guards, and the
// per-plugin state (rate limiters, the claim-release map) built ONCE in createInvoicingDeps.

export type ClientRow = typeof clients.$inferSelect;
export type RequestWithClient = FastifyRequest & { client: ClientRow };

export const STRIPE_CIRCUIT_OPEN_ERROR = {
  error: "Invoicing service is temporarily unavailable.",
  code: "STRIPE_CIRCUIT_OPEN",
};
const STRIPE_RATE_LIMITED_ERROR = {
  error: "Invoicing service is busy. Please retry.",
  code: "RATE_LIMITED",
};
export const REQUEST_REJECTED = {
  error: "Stripe could not complete the request.",
  code: "STRIPE_REQUEST_REJECTED",
};
export const USER_METADATA_RESERVED_PREFIX = "dfwsc_";
export const INVOICE_NOT_FOUND = { error: "Invoice not found.", code: "NOT_FOUND" };

export const idParamsSchema = z.object({ id: z.string().min(1).max(255) });

/**
 * The caller's Idempotency-Key header as the hash that is stored and sent to Stripe (the key is
 * free text and could otherwise carry personal data). Throws the 400 for a missing or long key.
 */
export function parseIdempotencyKeyHash(request: FastifyRequest): string {
  const key = request.headers["idempotency-key"];
  const keyHeader = Array.isArray(key) ? key[0] : key;
  if (!keyHeader || keyHeader.trim().length === 0) {
    throw errors.badRequest("Idempotency-Key header is required.");
  }
  const rawKey = keyHeader.trim();
  if (rawKey.length > 255) {
    throw errors.badRequest("Idempotency-Key must not exceed 255 characters.");
  }
  return createHash("sha256").update(rawKey).digest("hex");
}

/** Throws the 400 for a caller metadata key in the namespace this API reserves for itself. */
export function assertNoReservedMetadataKeys(userMetadata: Record<string, string>): void {
  if (Object.keys(userMetadata).some((k) => k.startsWith(USER_METADATA_RESERVED_PREFIX))) {
    throw errors.badRequest(
      `metadata keys starting with '${USER_METADATA_RESERVED_PREFIX}' are reserved.`
    );
  }
}

export function isResourceMissing(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "resource_missing";
}

export const accountOf = (request: FastifyRequest): string =>
  (request as RequestWithClient).client.stripeAccountId as string;

export const invoiceKeyInUse = (reply: FastifyReply) =>
  reply.code(409).send({
    error: "A request with this Idempotency-Key is already being processed. Retry shortly.",
    code: "IDEMPOTENCY_KEY_IN_USE",
  });

/**
 * Guard for every invoicing route: a valid API key, then the per-client opt-in. Writes also need a
 * connected account that can take charges; reads only need an account id (so a client whose
 * charges were switched off can still read what it created).
 */
function requireInvoicingClient(mode: "read" | "write" | "charge") {
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
    const usable = mode === "read" ? client.stripeAccountId : getChargeableAccountId(client);
    if (!usable) {
      return reply.code(409).send({
        error: "Client Stripe account is not connected or cannot accept charges.",
        code: "ACCOUNT_NOT_CONNECTED",
      });
    }
    if (mode !== "charge") return;
    // Routes that end up charging the account also need the card_payments capability.
    let cardPayments: string;
    try {
      cardPayments = await resolveCardPaymentsStatus(client, usable);
    } catch (err) {
      request.log.error(
        { clientId: client.id, ...errorLogFields(err) },
        "Could not read the card_payments capability from Stripe"
      );
      if (
        mapStripeError(err, reply, {
          circuitOpen: STRIPE_CIRCUIT_OPEN_ERROR,
          rateLimited: STRIPE_RATE_LIMITED_ERROR,
        })
      )
        return;
      throw errors.stripeFailed("Invoicing request failed. Please try again.");
    }
    if (cardPayments !== "active") {
      return reply.code(409).send(CARD_PAYMENTS_NOT_ACTIVE_ERROR);
    }
  };
}

export interface StripeCallOptions {
  write?: boolean;
  notFound?: string;
  /** Never return Stripe's own text: an invalid-request error becomes a generic 502. */
  generic?: boolean;
}

export type StripeCall = <T>(
  request: FastifyRequest,
  reply: FastifyReply,
  action: string,
  call: () => Promise<T>,
  opts?: StripeCallOptions
) => Promise<T | undefined>;

/** The state and guards every route module of the plugin shares. Built once per plugin. */
export interface InvoicingDeps {
  /** A create (or lifecycle write) that holds a claim registers its release here (see onSend). */
  pendingRelease: WeakMap<FastifyRequest, () => Promise<void>>;
  writeBucket: ReturnType<typeof tokenBucketRateLimit>;
  writeGuards: RouteShorthandOptions["preHandler"];
  chargeGuards: RouteShorthandOptions["preHandler"];
  readGuards: RouteShorthandOptions["preHandler"];
  /** Void and delete: allowed when charges are off, so a client can still cancel what it sent. */
  lifecycleOpenGuards: RouteShorthandOptions["preHandler"];
  takeWriteToken: (request: FastifyRequest, reply: FastifyReply) => Promise<boolean>;
  stripeCall: StripeCall;
}

export function createInvoicingDeps(): InvoicingDeps {
  // A create that gives its claim back must do so BEFORE the response leaves, or a caller that
  // retries the moment it sees the error would find the row still claimed (IN_USE). Errors are
  // sent from inside the handler, so the release is also run from onSend.
  const pendingRelease = new WeakMap<FastifyRequest, () => Promise<void>>();

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
  // Invoice create, finalize and send charge (or prepare to charge) the connected account.
  const chargeGuards = [requireInvoicingClient("charge")];
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
    opts: {
      write?: boolean;
      notFound?: string;
      /** Never return Stripe's own text: an invalid-request error becomes a generic 502. */
      generic?: boolean;
    } = {}
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
        opts.generic &&
        (err as { type?: unknown } | null)?.type === "StripeInvalidRequestError"
      ) {
        if ((err as { code?: unknown }).code === "idempotency_key_in_use") {
          invoiceKeyInUse(reply);
        } else {
          reply.code(502).send(REQUEST_REJECTED);
        }
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

  return {
    pendingRelease,
    writeBucket,
    writeGuards,
    chargeGuards,
    readGuards,
    lifecycleOpenGuards: [requireInvoicingClient("read")],
    takeWriteToken,
    stripeCall,
  };
}
