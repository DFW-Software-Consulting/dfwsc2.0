import { vi } from "vitest";

export const PLANTED_EMAIL = "jane.planted@customer.example";
export const PLANTED_URL = "https://invoice.stripe.com/i/acct_planted/live_secret_token";
export const PLANTED_PARAM = "planted-sql-param-4f9c";

/** Everything a logger call received, with Error objects expanded (message, stack, cause). */
export function dump(value: unknown, seen = new WeakSet<object>()): string {
  return JSON.stringify(value, (_key, v) => {
    if (v !== null && typeof v === "object") {
      if (seen.has(v)) return "[circular]";
      seen.add(v);
    }
    if (v instanceof Error) {
      return { ...v, name: v.name, message: v.message, stack: v.stack, cause: v.cause };
    }
    return v;
  });
}

export type LoggedCall = { level: string; fields: unknown; msg: unknown };

/** Records what request-scoped and app-level loggers receive (the app logger is silent in tests). */
export function captureAppLogs(app: { log: any }) {
  const calls: LoggedCall[] = [];
  const record = (level: string) =>
    ((...args: unknown[]) => {
      const [first, second] = args;
      if (typeof first === "string") calls.push({ level, fields: undefined, msg: first });
      else calls.push({ level, fields: first, msg: second });
    }) as never;
  const wrap = (target: any) => {
    for (const level of ["error", "warn", "info"]) {
      vi.spyOn(target, level).mockImplementation(record(level));
    }
    return target;
  };
  const originalChild = app.log.child.bind(app.log);
  const childSpy = vi
    .spyOn(app.log, "child")
    .mockImplementation(((...a: unknown[]) => wrap(originalChild(...a))) as never);
  wrap(app.log);
  return {
    calls,
    text: () => dump(calls),
    find: (msg: string) => calls.find((c) => c.msg === msg),
    restore: () => {
      childSpy.mockRestore();
      for (const level of ["error", "warn", "info"]) vi.spyOn(app.log, level).mockRestore();
    },
  };
}

/** A Stripe SDK-shaped error whose message quotes customer data. */
export function plantedStripeError() {
  return Object.assign(new Error(`No such customer ${PLANTED_EMAIL}: ${PLANTED_URL}`), {
    type: "StripeInvalidRequestError",
    code: "resource_missing",
    statusCode: 404,
    requestId: "req_planted",
  });
}

/** A Drizzle-wrapped pg error whose message, detail and params quote row values. */
export function plantedDbError() {
  const pg = Object.assign(new Error(`duplicate key (${PLANTED_EMAIL})`), {
    code: "23505",
    severity: "ERROR",
    detail: `Key (email)=(${PLANTED_EMAIL}) already exists.`,
    constraint: "uq_planted",
    table: "planted_table",
    column: "email",
    routine: "_bt_check_unique",
  });
  const wrapped = new Error(
    `Failed query: insert into t values ($1, $2)\nparams: ${PLANTED_PARAM},${PLANTED_URL}`,
    { cause: pg }
  );
  wrapped.name = "DrizzleQueryError";
  return wrapped;
}

/** A nodemailer-shaped error whose message quotes the recipient. */
export function plantedMailError() {
  return Object.assign(new Error(`Recipient address rejected: ${PLANTED_EMAIL}`), {
    code: "EENVELOPE",
    responseCode: 550,
    command: "RCPT TO",
    response: `550 5.1.1 <${PLANTED_EMAIL}> user unknown`,
  });
}

export function expectNoPlanted(text: string) {
  for (const secret of [PLANTED_EMAIL, PLANTED_URL, PLANTED_PARAM, "live_secret_token"]) {
    if (text.includes(secret)) throw new Error(`log output contains planted value: ${secret}`);
  }
}
