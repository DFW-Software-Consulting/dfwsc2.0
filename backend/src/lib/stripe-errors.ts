import type { FastifyReply } from "fastify";
import { isCircuitOpenError } from "./circuit-breakers";

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
  /** Response body sent for a Stripe rate-limit (`StripeRateLimitError`) error. Omit to skip this branch. */
  rateLimited?: StripeErrorBody;
  /**
   * Map permanent caller errors instead of letting them fall through as retryable:
   * `StripeInvalidRequestError` -> 400 (Stripe's message), `StripeIdempotencyError` -> 409
   * `IDEMPOTENCY_KEY_REUSED`, `StripePermissionError` -> 409 `ACCOUNT_NOT_CONNECTED`.
   * Opt-in because other call sites rely on their own fallback for these errors.
   */
  permanentErrors?: boolean;
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

  if (mapping.cardDeclinedCode && err instanceof Error && err.name === "StripeCardError") {
    reply.code(402).send({ error: err.message, code: mapping.cardDeclinedCode });
    return true;
  }

  if (mapping.rateLimited && err instanceof Error && err.name === "StripeRateLimitError") {
    reply.code(429).send(mapping.rateLimited);
    return true;
  }

  if (mapping.permanentErrors && err instanceof Error) {
    if (err.name === "StripeInvalidRequestError") {
      const param = (err as { param?: unknown }).param;
      reply.code(400).send({
        error: err.message,
        code: "INVALID_REQUEST",
        ...(typeof param === "string" ? { param } : {}),
      });
      return true;
    }
    if (err.name === "StripeIdempotencyError") {
      reply.code(409).send({ error: err.message, code: "IDEMPOTENCY_KEY_REUSED" });
      return true;
    }
    if (err.name === "StripePermissionError") {
      reply.code(409).send({
        error: "Client Stripe account is not connected or cannot accept charges.",
        code: "ACCOUNT_NOT_CONNECTED",
      });
      return true;
    }
  }

  return false;
}
