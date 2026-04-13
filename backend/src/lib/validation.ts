import type { FastifyReply } from "fastify";
import { stripe } from "./stripe";
import { isWorkspace, type Workspace } from "./workspace";

export type { Workspace };

// Constants for Stripe operations
export const STRIPE_LIST_LIMIT = 100;
export const DEFAULT_DAYS_UNTIL_DUE = 30;
export const DEFAULT_INVOICE_DUE_DAYS = 30;

// Date format validation (YYYY-MM-DD)
export const DATE_FORMAT_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates workspace parameter and sends error response if invalid.
 * Returns the workspace if valid, null otherwise (response already sent).
 */
export function validateWorkspace(workspace: unknown, res: FastifyReply): Workspace | null {
  if (!isWorkspace(workspace)) {
    res.status(400).send({
      error: "workspace is required (dfwsc_services|client_portal).",
    });
    return null;
  }
  return workspace;
}

/**
 * Validates workspace from query parameter.
 * Returns the workspace if valid, null otherwise (response already sent).
 */
export function validateWorkspaceQuery(workspace: unknown, res: FastifyReply): Workspace | null {
  if (!isWorkspace(workspace)) {
    res.status(400).send({
      error: "workspace query parameter is required (dfwsc_services|client_portal).",
    });
    return null;
  }
  return workspace;
}

/**
 * Validates date format (YYYY-MM-DD) and returns Date object if valid.
 * Sends error response and returns null if invalid.
 */
export function validateDateFormat(
  dateStr: string,
  fieldName: string,
  res: FastifyReply
): Date | null {
  if (!DATE_FORMAT_REGEX.test(dateStr)) {
    res.status(400).send({ error: `${fieldName} must be in YYYY-MM-DD format.` });
    return null;
  }
  const dateObj = new Date(dateStr);
  if (Number.isNaN(dateObj.getTime())) {
    res.status(400).send({ error: `${fieldName} is invalid.` });
    return null;
  }
  return dateObj;
}

/**
 * Validates date range (startDate < endDate).
 * Sends error response and returns false if invalid.
 */
export function validateDateRange(startDate: Date, endDate: Date, res: FastifyReply): boolean {
  if (endDate <= startDate) {
    res.status(400).send({ error: "endDate must be after startDate." });
    return false;
  }
  return true;
}

/**
 * Validates tax rate ID by retrieving it from Stripe.
 * Sends error response and returns false if invalid.
 */
export async function validateTaxRate(taxRateId: string, res: FastifyReply): Promise<boolean> {
  try {
    await stripe.taxRates.retrieve(taxRateId);
    return true;
  } catch {
    res.status(400).send({ error: "Invalid taxRateId." });
    return false;
  }
}

/**
 * Validates pagination limit parameter.
 * Returns parsed limit or null if invalid (response already sent).
 */
export function validateLimit(limit: unknown, res: FastifyReply): number | null {
  if (limit === undefined) return null;

  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    res.status(400).send({ error: "limit must be an integer between 1 and 100." });
    return null;
  }
  return parsed;
}

/**
 * Validates amount in cents (positive integer).
 * Sends error response and returns false if invalid.
 */
export function validateAmountCents(amount: unknown, res: FastifyReply): boolean {
  if (!Number.isInteger(amount) || (amount as number) <= 0) {
    res.status(400).send({ error: "amountCents must be a positive integer." });
    return false;
  }
  return true;
}

/**
 * Validates required string field is not empty.
 * Sends error response and returns false if invalid.
 */
export function validateRequiredString(
  value: unknown,
  fieldName: string,
  res: FastifyReply
): boolean {
  if (!value || typeof value !== "string" || value.trim().length === 0) {
    res.status(400).send({ error: `${fieldName} is required.` });
    return false;
  }
  return true;
}

/**
 * Validates interval is one of the allowed values.
 * Sends error response and returns false if invalid.
 */
export function validateInterval(
  interval: unknown,
  allowedIntervals: readonly string[],
  res: FastifyReply
): boolean {
  if (!allowedIntervals.includes(interval as string)) {
    res.status(400).send({
      error: `interval must be one of: ${allowedIntervals.join(", ")}.`,
    });
    return false;
  }
  return true;
}

/**
 * Calculates days until due from an optional due date string.
 * Returns the calculated days or default value.
 */
export function calculateDaysUntilDue(
  dueDate: string | null | undefined,
  defaultDays: number = DEFAULT_DAYS_UNTIL_DUE
): number {
  if (!dueDate) return defaultDays;

  const days = Math.max(1, Math.ceil((new Date(dueDate).getTime() - Date.now()) / 86_400_000));
  return days;
}
