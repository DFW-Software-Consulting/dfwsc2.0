export class AppError extends Error {
  statusCode: number;
  code?: string;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const errors = {
  notFound: (resource: string) => new AppError(`${resource} not found.`, 404, "NOT_FOUND"),
  unauthorized: (msg = "Authentication required") => new AppError(msg, 401, "UNAUTHORIZED"),
  forbidden: (msg = "Insufficient permissions") => new AppError(msg, 403, "FORBIDDEN"),
  badRequest: (msg: string) => new AppError(msg, 400, "BAD_REQUEST"),
  conflict: (msg: string) => new AppError(msg, 409, "CONFLICT"),
  internal: (msg = "Internal server error") => new AppError(msg, 500, "INTERNAL_ERROR"),
  emailFailed: (msg: string) => new AppError(msg, 502, "EMAIL_DELIVERY_FAILED"),
  stripeFailed: (msg: string) => new AppError(msg, 502, "STRIPE_FAILED"),
};

/**
 * Walk an error's `cause` chain looking for a string-valued field.
 * Drizzle wraps the underlying `pg` driver error in a `DrizzleQueryError`, so
 * the Postgres `code`/`constraint` live under `error.cause` (and are not present
 * on the top-level object). This inspects both.
 */
function findInCauseChain(err: unknown, field: string): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current != null; depth++) {
    const value = (current as Record<string, unknown>)[field];
    if (typeof value === "string") return value;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Postgres SQLSTATE code for a (possibly Drizzle-wrapped) DB error, e.g. "23505". */
function dbErrorCode(err: unknown): string | undefined {
  return findInCauseChain(err, "code");
}

/** The violated constraint name for a (possibly Drizzle-wrapped) DB error. */
export function dbErrorConstraint(err: unknown): string | undefined {
  return findInCauseChain(err, "constraint");
}

/** True when the error is a Postgres unique-violation (SQLSTATE 23505). */
export function isUniqueViolation(err: unknown): boolean {
  return dbErrorCode(err) === "23505";
}
