const SQLSTATE = /^[0-9A-Z]{5}$/;

function isStripeError(err: unknown): boolean {
  const type = (err as { type?: unknown } | null)?.type;
  return typeof type === "string" && type.startsWith("Stripe");
}

// A pg error, or the Drizzle wrapper around one. Their message and stack quote the failed query's
// parameters (hosted URLs, descriptions, metadata) and `detail` quotes row values.
function dbCauseOf(err: unknown, strict = true): Record<string, unknown> | undefined {
  for (let e: unknown = err, depth = 0; e != null && depth < 4; depth++) {
    const o = e as Record<string, unknown>;
    if (
      typeof o.code === "string" &&
      SQLSTATE.test(o.code) &&
      (!strict || "severity" in o || "routine" in o)
    ) {
      return o;
    }
    e = o.cause;
  }
  return undefined;
}

function isDbError(err: unknown): boolean {
  const e = err as { name?: unknown; message?: unknown } | null;
  return (
    e?.name === "DrizzleQueryError" ||
    (typeof e?.message === "string" && e.message.startsWith("Failed query")) ||
    dbCauseOf(err) !== undefined
  );
}

// Retry-path log fields. Stripe errors: identifiers only (their message can quote emails and
// hosted URLs). DB errors: SQLSTATE and schema names only, never message, detail, params or stack.
// Anything else is our own bug, whose message and stack are the only way to find it.
export function retryErrorFields(err: unknown) {
  if (isStripeError(err) || !(err instanceof Error)) return safeErrorFields(err);
  if (isDbError(err)) return dbErrorFields(err);
  return { ...safeErrorFields(err), errMessage: err.message, errStack: err.stack };
}

// Only identifiers: a Stripe error message can quote customer data (emails, hosted URLs).
export function safeErrorFields(err: unknown) {
  const e = err as {
    type?: unknown;
    code?: unknown;
    statusCode?: unknown;
    requestId?: unknown;
    name?: unknown;
  } | null;
  return {
    errType: e?.type ?? e?.name,
    errCode: e?.code,
    errStatusCode: e?.statusCode,
    errRequestId: e?.requestId,
  };
}

// DB error fields: SQLSTATE and schema names only, never message, detail, params or stack.
export function dbErrorFields(err: unknown) {
  const c = dbCauseOf(err, false);
  const top = err as { name?: unknown; code?: unknown } | null;
  return {
    errName: top?.name,
    errCode: c?.code ?? top?.code,
    errConstraint: c?.constraint,
    errTable: c?.table,
    errColumn: c?.column,
    errRoutine: c?.routine,
  };
}
