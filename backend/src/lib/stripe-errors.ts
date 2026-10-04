import type { FastifyReply } from "fastify";
import { isCircuitOpenError, isStripeBusyError } from "./circuit-breakers";
import {
  STRIPE_BUSY_RETRY_AFTER_SECONDS,
  STRIPE_RATE_LIMITED_RETRY_AFTER_SECONDS,
} from "./constants";

/**
 * Body for a Stripe call that could not get a concurrency slot in time. Always mapped (503 with
 * `Retry-After`), whatever the call site: nothing was sent to Stripe, so retrying is safe, and a
 * webhook answering non-2xx here makes Stripe redeliver the event.
 */
const STRIPE_BUSY_ERROR: StripeErrorBody = {
  error: "Payment service is handling a high volume of requests. Please retry shortly.",
  code: "STRIPE_BUSY",
};

export interface StripeErrorBody {
  error: string;
  code?: string;
}

export interface StripeErrorMapping {
  /** Response body sent when the Stripe circuit breaker is open. */
  circuitOpen: StripeErrorBody;
  /** HTTP status for the circuitOpen response. Defaults to 503. */
  circuitOpenStatus?: number;
  /** `code` value used for a declined-card (`StripeCardError`) response. Omit to skip this branch. */
  cardDeclinedCode?: string;
  /**
   * Response body sent for a Stripe rate-limit (`StripeRateLimitError`) error, with
   * `Retry-After` (Stripe sends none). Omit to skip this branch.
   */
  rateLimited?: StripeErrorBody;
  /**
   * Map permanent caller errors instead of letting them fall through as retryable:
   * `StripeInvalidRequestError` -> 400 (Stripe's message), `StripeIdempotencyError` -> 409
   * `IDEMPOTENCY_KEY_REUSED` (parameter mismatch, permanent, fixed message) or 409 `IDEMPOTENCY_KEY_IN_USE`
   * (same key still in flight, retryable), `StripePermissionError` -> 409 `ACCOUNT_NOT_CONNECTED`.
   * Opt-in because other call sites rely on their own fallback for these errors.
   */
  permanentErrors?: boolean;
}

/**
 * Class name of a Stripe SDK error. The SDK (stripe-node 19) sets `type` to the class name
 * (e.g. "StripeInvalidRequestError") and leaves `name` as "Error", so `type` is the real
 * discriminator; `name` is the fallback for errors that set it instead.
 */
function stripeErrorKind(err: Error): string {
  const type = (err as { type?: unknown }).type;
  return typeof type === "string" && type.startsWith("Stripe") ? type : err.name;
}

/**
 * Shared Stripe-error -> HTTP mapping used across the payments/connect/products/webhooks
 * routes: circuit-open -> 503, StripeCardError -> 402, StripeRateLimitError -> 429.
 *
 * Sends the appropriate reply and returns `true` when `err` matched one of the
 * configured cases (the caller should stop / return). Returns `false` when `err`
 * didn't match, so each call site can run its own (differing) fallback behavior.
 */
export function mapStripeError(
  err: unknown,
  reply: FastifyReply,
  mapping: StripeErrorMapping
): boolean {
  if (isCircuitOpenError(err)) {
    reply.code(mapping.circuitOpenStatus ?? 503).send(mapping.circuitOpen);
    return true;
  }

  if (isStripeBusyError(err)) {
    reply.header("Retry-After", String(STRIPE_BUSY_RETRY_AFTER_SECONDS));
    reply.code(503).send(STRIPE_BUSY_ERROR);
    return true;
  }

  const kind = err instanceof Error ? stripeErrorKind(err) : undefined;

  if (mapping.cardDeclinedCode && err instanceof Error && kind === "StripeCardError") {
    reply.code(402).send({ error: err.message, code: mapping.cardDeclinedCode });
    return true;
  }

  if (mapping.rateLimited && err instanceof Error && kind === "StripeRateLimitError") {
    reply.header("Retry-After", String(STRIPE_RATE_LIMITED_RETRY_AFTER_SECONDS));
    reply.code(429).send(mapping.rateLimited);
    return true;
  }

  if (mapping.permanentErrors && err instanceof Error) {
    // Stripe answers 409 `idempotency_key_in_use` while the first request is still running.
    // Match on `code` regardless of class: the SDK picks the class from the wire `type`, which
    // may be `idempotency_error` or `invalid_request_error` for this case.
    if ((err as { code?: unknown }).code === "idempotency_key_in_use") {
      reply.code(409).send({
        error:
          "A request with this Idempotency-Key is still in progress. Retry shortly with the same key.",
        code: "IDEMPOTENCY_KEY_IN_USE",
      });
      return true;
    }
    if (kind === "StripeInvalidRequestError") {
      const param = (err as { param?: unknown }).param;
      reply.code(400).send({
        error: err.message,
        code: "INVALID_REQUEST",
        ...(typeof param === "string" ? { param } : {}),
      });
      return true;
    }
    if (kind === "StripeIdempotencyError") {
      // Fixed text: Stripe's message quotes the key it received, which is not necessarily
      // the key the caller sent.
      reply.code(409).send({
        error:
          "This Idempotency-Key was already used for a different payment. Use a new unique key for each new payment.",
        code: "IDEMPOTENCY_KEY_REUSED",
      });
      return true;
    }
    if (kind === "StripePermissionError") {
      reply.code(409).send({
        error: "Client Stripe account is not connected or cannot accept charges.",
        code: "ACCOUNT_NOT_CONNECTED",
      });
      return true;
    }
  }

  return false;
}
