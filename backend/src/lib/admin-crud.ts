import type { z } from "zod";
import { requireAdminJwt } from "./auth";
import { MAX_FEE_PERCENT, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from "./constants";
import { adminRateLimit } from "./rate-limit";
import { isValidHttpsUrl } from "./validation";

/**
 * Pieces shared by the admin CRUD routes for clients and client groups: the route guard, list
 * pagination, and the fee / payment-URL rules and PATCH mapping that both resources expose.
 */

const adminCrudRateLimit = adminRateLimit({
  max: RATE_LIMIT_MAX,
  windowMs: RATE_LIMIT_WINDOW_MS,
});

/** Admin JWT check followed by the per-admin rate limit, for every admin CRUD route. */
export const adminCrudPreHandler = [requireAdminJwt, adminCrudRateLimit];

export function parsePagination(query: { limit?: string; offset?: string }) {
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return null;
  if (!Number.isInteger(offset) || offset < 0) return null;
  return { limit, offset };
}

interface FeeAndUrlFields {
  processingFeePercent?: number | null;
  processingFeeCents?: number | null;
  paymentSuccessUrl?: string | null;
  paymentCancelUrl?: string | null;
}

/**
 * superRefine rules for the processing fee fields. Clients and groups run these and the URL rules
 * in opposite orders, and the first failing rule is the message the client sees, so each route
 * calls `addFeeIssues` and `addUrlIssues` itself at the position it has always checked them.
 */
export function addFeeIssues(body: FeeAndUrlFields, ctx: z.core.$RefinementCtx) {
  if (body.processingFeePercent != null && body.processingFeeCents != null) {
    ctx.addIssue({
      code: "custom",
      message: "Set one fee type, not both.",
      path: ["processingFeePercent"],
    });
  }
  if (
    body.processingFeePercent != null &&
    (body.processingFeePercent <= 0 || body.processingFeePercent > MAX_FEE_PERCENT)
  ) {
    ctx.addIssue({
      code: "custom",
      message: `processingFeePercent must be greater than 0 and at most ${MAX_FEE_PERCENT}.`,
      path: ["processingFeePercent"],
    });
  }
  if (
    body.processingFeeCents != null &&
    (!Number.isInteger(body.processingFeeCents) || body.processingFeeCents < 0)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "processingFeeCents must be a non-negative integer.",
      path: ["processingFeeCents"],
    });
  }
}

export function addUrlIssues(body: FeeAndUrlFields, ctx: z.core.$RefinementCtx) {
  if (body.paymentSuccessUrl != null && !isValidHttpsUrl(body.paymentSuccessUrl)) {
    ctx.addIssue({
      code: "custom",
      message: "paymentSuccessUrl must be a valid HTTPS URL.",
      path: ["paymentSuccessUrl"],
    });
  }
  if (body.paymentCancelUrl != null && !isValidHttpsUrl(body.paymentCancelUrl)) {
    ctx.addIssue({
      code: "custom",
      message: "paymentCancelUrl must be a valid HTTPS URL.",
      path: ["paymentCancelUrl"],
    });
  }
}

/**
 * PATCH column values for the fee fields present in `body`. A fee is stored as text when it is a
 * percent, and setting one fee type clears the other so the two stay mutually exclusive.
 */
export function feeSetValues(body: FeeAndUrlFields) {
  const values: { processingFeePercent?: string | null; processingFeeCents?: number | null } = {};
  if ("processingFeePercent" in body) {
    const percent = body.processingFeePercent;
    values.processingFeePercent = percent != null ? String(percent) : null;
    if (percent != null) values.processingFeeCents = null;
  }
  if ("processingFeeCents" in body) {
    const cents = body.processingFeeCents;
    values.processingFeeCents = cents;
    if (cents != null) values.processingFeePercent = null;
  }
  return values;
}
