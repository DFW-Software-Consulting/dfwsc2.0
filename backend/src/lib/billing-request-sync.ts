import crypto from "node:crypto";
import { and, eq, max, sql } from "drizzle-orm";
import { db } from "../db/client";
import { billingCustomers, billingRequestSubmissions, billingRequestSyncState } from "../db/schema";
import {
  type BillingQuestionMap,
  type BillingRequest,
  BillingRequestConfigError,
  BillingRequestInvalidError,
  chicagoUnix,
  normalizeCompany,
  parseBillingRequest,
  peekBillingRequest,
  resolveBillingQuestions,
} from "./billing-request-mapping";
import { BillingRequestNextcloud } from "./billing-request-nextcloud";
import {
  BILLING_REQUESTS_STATE_KEY,
  BILLING_REQUESTS_TABLE_TITLE,
  billingRequestColumns,
  renderBillingRequest,
} from "./billing-request-render";
import { BillingRequestStripeError, runStripeSteps } from "./billing-request-stripe";
import { markCustomerDirty } from "./billing-snapshot";
import { isNextcloudUser } from "./client-onboarding-mapping";
import {
  BILLING_DEFAULT_DAYS_UNTIL_DUE,
  BILLING_DEFAULT_MAX_AMOUNT_CENTS,
  BILLING_REQUESTS_CLAIM_LEASE_MS,
  BILLING_REQUESTS_DEFAULT_MAX_AGE_HOURS,
  BILLING_REQUESTS_DEFAULT_POLL_INTERVAL_MS,
  BILLING_REQUESTS_MAX_ATTEMPTS,
  BILLING_REQUESTS_MAX_DISCOVERY_PAGES,
  BILLING_REQUESTS_MAX_PER_CYCLE,
  BILLING_REQUESTS_MIN_POLL_INTERVAL_MS,
  BILLING_REQUESTS_MIN_WEBHOOK_SECRET_LENGTH,
  BILLING_REQUESTS_RETRY_BASE_MS,
  BILLING_REQUESTS_RETRY_MAX_MS,
} from "./constants";
import {
  intVar,
  isAuthError,
  isOutage,
  type MirrorLogger,
  type ProvisionCache,
  type Provisioned,
  parseShareGroups,
  provisionMirrorTable,
} from "./mirror-table";
import {
  getNextcloudConfig,
  NextcloudCircuitOpenError,
  type NextcloudConfig,
  NextcloudHttpError,
  NextcloudRequestError,
  nextcloudRequest,
} from "./nextcloud";
import { PortalMirrorNextcloud } from "./portal-mirror-nextcloud";
import { contentHash, toRowData } from "./portal-mirror-render";
import { isBadResponseError, SUBMISSION_PAGE_SIZE } from "./sales-lead-nextcloud";

// "New invoice" form: for each submission of one Nextcloud Form, exactly once, a one-off Stripe
// invoice (finalized and emailed, or left as a draft) or a recurring plan (Subscription Schedule)
// for a client in billing_customers, on DFWSC's own Stripe account. The result of every request
// is a row in the read-only Nextcloud Table "Billing Requests".
//
// Same model as client onboarding (lib/client-onboarding-sync.ts): Forms is the queue, progress per
// submission lives in billing_request_submissions, rows are claimed with a lease, a webhook only
// asks for a cycle to run now and the poll runs one anyway. Stripe objects are created through
// lib/billing-request-stripe.ts with idempotency keys and their ids saved as they appear.
//
// Safety: the submitter must belong to BILLING_REQUESTS_ALLOWED_GROUPS in Nextcloud; the company
// must match the client's; amounts are capped; a request that fails validation never reaches Stripe
// and is not retried. Submissions that existed when the automation was first enabled are skipped.
//
// Logs carry ids, statuses and error codes only: never answers, company, description or amounts.

type Logger = MirrorLogger;
type SubmissionRow = typeof billingRequestSubmissions.$inferSelect;
const t = billingRequestSubmissions;

const STATE_KEY = BILLING_REQUESTS_STATE_KEY;
const DEFAULT_ALLOWED_GROUPS = ["dfwsc-admins", "managers"];
const DEFAULT_SHARE_GROUPS = ["dfwsc-admins", "managers"];

interface BillingRequestSettings {
  formId: number;
  pollIntervalMs: number;
  /** Shared secret for the webhook; null leaves the webhook off (poll only). */
  webhookSecret: string | null;
  allowedGroups: string[];
  shareGroups: string[];
  maxAmountCents: number;
  autoSend: boolean;
  daysUntilDue: number;
  /** A submission older than this is not billed unless Stripe was already called for it. */
  maxAgeHours: number;
  minGapMs: number;
}

type ConfigResult =
  | { status: "disabled" }
  | { status: "invalid"; problems: string[] }
  | { status: "ready"; nextcloud: NextcloudConfig; settings: BillingRequestSettings };

export function loadBillingRequestsConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  if (env.BILLING_REQUESTS_ENABLED?.trim() !== "true") return { status: "disabled" };
  const problems: string[] = [];

  const nc = getNextcloudConfig(env);
  if (!nc.ok) {
    problems.push(
      nc.reason === "not_configured"
        ? "NEXTCLOUD_BASE_URL, NEXTCLOUD_USERNAME and NEXTCLOUD_APP_PASSWORD are required"
        : "NEXTCLOUD_BASE_URL must be a valid https:// URL"
    );
  }
  const formIdText = env.BILLING_REQUESTS_FORM_ID?.trim() ?? "";
  const formId = /^\d+$/.test(formIdText) ? Number(formIdText) : 0;
  if (!Number.isSafeInteger(formId) || formId <= 0) {
    problems.push("BILLING_REQUESTS_FORM_ID must be a positive integer");
  }
  const pollIntervalMs = intVar(
    env.BILLING_REQUESTS_POLL_INTERVAL_MS,
    "BILLING_REQUESTS_POLL_INTERVAL_MS",
    BILLING_REQUESTS_MIN_POLL_INTERVAL_MS,
    24 * 60 * 60 * 1000,
    BILLING_REQUESTS_DEFAULT_POLL_INTERVAL_MS,
    problems
  );
  // Not trimmed: the secret is compared byte for byte with the header Nextcloud sends.
  const webhookSecret = env.BILLING_REQUESTS_WEBHOOK_SECRET || null;
  if (webhookSecret !== null && webhookSecret.length < BILLING_REQUESTS_MIN_WEBHOOK_SECRET_LENGTH) {
    problems.push(
      `BILLING_REQUESTS_WEBHOOK_SECRET must be at least ${BILLING_REQUESTS_MIN_WEBHOOK_SECRET_LENGTH} characters`
    );
  }
  const allowedGroups = parseShareGroups(
    env.BILLING_REQUESTS_ALLOWED_GROUPS,
    "BILLING_REQUESTS_ALLOWED_GROUPS",
    DEFAULT_ALLOWED_GROUPS,
    problems
  );
  const shareGroups = parseShareGroups(
    env.BILLING_REQUESTS_SHARE_GROUPS,
    "BILLING_REQUESTS_SHARE_GROUPS",
    DEFAULT_SHARE_GROUPS,
    problems
  );
  const maxAmountCents = intVar(
    env.BILLING_MAX_AMOUNT_CENTS,
    "BILLING_MAX_AMOUNT_CENTS",
    1,
    100_000_000,
    BILLING_DEFAULT_MAX_AMOUNT_CENTS,
    problems
  );
  const daysUntilDue = intVar(
    env.BILLING_DEFAULT_DAYS_UNTIL_DUE,
    "BILLING_DEFAULT_DAYS_UNTIL_DUE",
    1,
    365,
    BILLING_DEFAULT_DAYS_UNTIL_DUE,
    problems
  );
  const maxAgeHours = intVar(
    env.BILLING_REQUESTS_MAX_AGE_HOURS,
    "BILLING_REQUESTS_MAX_AGE_HOURS",
    1,
    24 * 365,
    BILLING_REQUESTS_DEFAULT_MAX_AGE_HOURS,
    problems
  );
  let autoSend = true;
  const autoSendText = env.BILLING_AUTO_SEND?.trim().toLowerCase();
  if (autoSendText) {
    if (autoSendText === "true" || autoSendText === "false") autoSend = autoSendText === "true";
    else problems.push("BILLING_AUTO_SEND must be true or false");
  }

  if (!nc.ok || problems.length) return { status: "invalid", problems };
  return {
    status: "ready",
    nextcloud: nc.config,
    settings: {
      formId,
      pollIntervalMs,
      webhookSecret,
      allowedGroups,
      shareGroups,
      maxAmountCents,
      autoSend,
      daysUntilDue,
      maxAgeHours,
      minGapMs: 200,
    },
  };
}

// ── Cycle state ──────────────────────────────────────────────────────────────

type CycleStatus =
  | "disabled"
  | "invalid_config"
  | "config_error"
  | "nextcloud_unavailable"
  | "stripe_unavailable"
  | "error"
  | "ok";

const stats: { lastCycleAt: Date | null; lastCycleStatus: CycleStatus | null } = {
  lastCycleAt: null,
  lastCycleStatus: null,
};

export function getBillingRequestsStats() {
  return { ...stats };
}

let lastLoggedProblem: string | null = null;
const provisionCache: ProvisionCache = { current: null };

function logProblemOnce(logger: Logger, key: string, fields: Record<string, unknown>, msg: string) {
  if (lastLoggedProblem === key) return;
  lastLoggedProblem = key;
  logger.error(fields, msg);
}

export function resetBillingRequestsStateForTests() {
  stats.lastCycleAt = null;
  stats.lastCycleStatus = null;
  lastLoggedProblem = null;
  provisionCache.current = null;
  active = null;
}

// ── Persistence ──────────────────────────────────────────────────────────────

class ClaimLostError extends Error {
  constructor() {
    super("Claim on billing request submission was lost");
    this.name = "ClaimLostError";
  }
}

async function ensureBaseline(
  api: BillingRequestNextcloud,
  formId: number,
  logger: Logger
): Promise<number | null> {
  const [state] = await db
    .select()
    .from(billingRequestSyncState)
    .where(eq(billingRequestSyncState.formId, formId));
  if (state) return state.baselineSubmissionId;

  const ids = await api.listSubmissionIds(0);
  const baseline = ids.length ? Math.max(...ids) : 0;
  const inserted = await db
    .insert(billingRequestSyncState)
    .values({ formId, baselineSubmissionId: baseline })
    .onConflictDoNothing()
    .returning();
  if (inserted.length) {
    logger.info(
      { formId, baselineSubmissionId: baseline },
      "Billing requests baseline recorded; earlier submissions are skipped."
    );
  }
  return null;
}

async function discover(api: BillingRequestNextcloud, formId: number, logger: Logger) {
  const baseline = await ensureBaseline(api, formId, logger);
  if (baseline === null) return 0;

  const [known] = await db
    .select({ highest: max(t.submissionId) })
    .from(t)
    .where(eq(t.formId, formId));
  const highWater = Math.max(baseline, known?.highest ?? 0);

  const fresh: number[] = [];
  for (let page = 0; page < BILLING_REQUESTS_MAX_DISCOVERY_PAGES; page++) {
    const ids = await api.listSubmissionIds(page * SUBMISSION_PAGE_SIZE);
    const newer = ids.filter((id) => id > highWater);
    fresh.push(...newer);
    if (newer.length < ids.length || ids.length < SUBMISSION_PAGE_SIZE) break;
  }
  if (!fresh.length) return 0;
  const inserted = await db
    .insert(t)
    .values(fresh.map((submissionId) => ({ formId, submissionId })))
    .onConflictDoNothing()
    .returning({ submissionId: t.submissionId });
  return inserted.length;
}

/**
 * Claims the lowest-id due row. The candidate is picked in a MATERIALIZED CTE so it is evaluated
 * once (see claimNextOnboarding for why).
 */
async function claimNextBillingRequest(formId: number): Promise<SubmissionRow | null> {
  const token = crypto.randomUUID();
  const leaseSeconds = Math.floor(BILLING_REQUESTS_CLAIM_LEASE_MS / 1000);
  const claimed = await db.execute<{ submission_id: number }>(sql`
    WITH c AS MATERIALIZED (
      SELECT form_id, submission_id FROM billing_request_submissions
      WHERE form_id = ${formId}
        AND status = 'pending'
        AND next_attempt_at <= now()
        AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => ${leaseSeconds}))
      ORDER BY submission_id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE billing_request_submissions AS u
    SET claimed_at = now(), claim_token = ${token}
    FROM c
    WHERE u.form_id = c.form_id AND u.submission_id = c.submission_id
    RETURNING u.submission_id
  `);
  if (claimed.rows.length === 0) return null;
  const [row] = await db
    .select()
    .from(t)
    .where(and(eq(t.formId, formId), eq(t.claimToken, token)));
  return row ?? null;
}

async function saveUnderClaim(
  row: SubmissionRow,
  patch: Partial<typeof billingRequestSubmissions.$inferInsert>
): Promise<void> {
  if (!row.claimToken) throw new ClaimLostError();
  const updated = await db
    .update(t)
    .set(patch)
    .where(
      and(
        eq(t.formId, row.formId),
        eq(t.submissionId, row.submissionId),
        eq(t.claimToken, row.claimToken)
      )
    )
    .returning({ submissionId: t.submissionId });
  if (!updated.length) throw new ClaimLostError();
  Object.assign(row, patch);
}

// ── Errors ───────────────────────────────────────────────────────────────────

type Outcome = "completed" | "retry" | "failed" | "lost";

const RETRYABLE_HTTP_STATUSES = new Set([401, 403, 408, 423, 425, 429]);

function classify(error: unknown): { code: string; retryable: boolean; stripeDown: boolean } {
  if (error instanceof BillingRequestInvalidError) {
    return { code: error.code, retryable: false, stripeDown: false };
  }
  if (error instanceof BillingRequestStripeError) {
    return { code: error.code, retryable: error.retryable, stripeDown: error.stopCycle };
  }
  if (error instanceof NextcloudHttpError) {
    return {
      code: `${error.label}:${error.status}`,
      retryable: error.status >= 500 || RETRYABLE_HTTP_STATUSES.has(error.status),
      stripeDown: false,
    };
  }
  if (error instanceof NextcloudRequestError) {
    return { code: `${error.label}:${error.kind}`, retryable: true, stripeDown: false };
  }
  if (isBadResponseError(error)) {
    return { code: `${error.label}:bad_response`, retryable: true, stripeDown: false };
  }
  return { code: "internal_error", retryable: true, stripeDown: false };
}

function retryDelayMs(attempts: number): number {
  return Math.min(
    BILLING_REQUESTS_RETRY_BASE_MS * 2 ** Math.max(attempts - 1, 0),
    BILLING_REQUESTS_RETRY_MAX_MS
  );
}

// ── Context ──────────────────────────────────────────────────────────────────

interface ProcessingContext {
  api: BillingRequestNextcloud;
  formId: number;
  logger: Logger;
  questions: BillingQuestionMap;
  settings: BillingRequestSettings;
  /** The results table; null when it could not be provisioned (requests still run). */
  table: { nc: PortalMirrorNextcloud; prov: Provisioned } | null;
  /** Stripe looks unavailable: stop taking rows this cycle. */
  stop: boolean;
}

/** Finds or creates the results table and its read-only shares. Non-outage failures are logged once. */
async function provisionResults(
  nc: NextcloudConfig,
  settings: BillingRequestSettings,
  logger: Logger
): Promise<ProcessingContext["table"]> {
  const mirror = new PortalMirrorNextcloud(nc, settings.minGapMs, nextcloudRequest);
  try {
    const { value } = await provisionMirrorTable(
      mirror,
      {
        title: BILLING_REQUESTS_TABLE_TITLE,
        emoji: "🧾",
        stateKey: STATE_KEY,
        specs: billingRequestColumns(),
        shareGroups: settings.shareGroups,
        baseUrl: nc.baseUrl,
        overrideTableId: null,
      },
      provisionCache,
      logger
    );
    return { nc: mirror, prov: value };
  } catch (error) {
    if (isOutage(error)) throw error;
    logProblemOnce(
      logger,
      `table:${(error as Error)?.name}:${(error as { status?: number })?.status ?? ""}`,
      { errorName: (error as Error)?.name },
      "Billing Requests table could not be provisioned; requests run without result rows."
    );
    return null;
  }
}

/**
 * Writes the row's current state to the results table (create, or update when the content
 * changed). Returns what to save, or null when there is nothing to write or no table.
 */
async function writeResultRow(
  state: SubmissionRow,
  ctx: ProcessingContext
): Promise<{ ncRowId: number; ncRowHash: string } | null> {
  if (!ctx.table) return null;
  const { nc, prov } = ctx.table;
  const values = renderBillingRequest(state);
  const hash = contentHash(values);
  if (state.ncRowId !== null && state.ncRowHash === hash) return null;
  const data = toRowData(prov.specs, prov.columnIds, values);
  let id = state.ncRowId;
  if (id !== null) {
    try {
      await nc.updateRow(id, data);
    } catch (error) {
      if (!(error instanceof NextcloudHttpError && error.status === 404)) throw error;
      id = null; // deleted in Nextcloud: written again
    }
  }
  if (id === null) id = await nc.createRow(prov.tableId, data);
  return { ncRowId: id, ncRowHash: hash };
}

// ── Processing one request ───────────────────────────────────────────────────

async function authorize(userId: string | null, ctx: ProcessingContext): Promise<void> {
  if (!isNextcloudUser(userId)) throw new BillingRequestInvalidError("unauthorized");
  const { api } = ctx;
  const groups = await api.getUserGroups(userId);
  if (groups === null || !groups.some((g) => ctx.settings.allowedGroups.includes(g))) {
    throw new BillingRequestInvalidError("unauthorized");
  }
}

async function lookupCustomer(request: BillingRequest) {
  // Trimmed and upper-cased on both sides; codes that differ only in case are ambiguous, not guessed.
  const matches = await db
    .select()
    .from(billingCustomers)
    .where(
      sql`upper(btrim(${billingCustomers.clientCode})) = ${request.clientCode.trim().toUpperCase()}`
    )
    .limit(2);
  if (!matches.length) throw new BillingRequestInvalidError("unknown_client_code");
  if (matches.length > 1) throw new BillingRequestInvalidError("ambiguous_client_code");
  const [customer] = matches;
  if (normalizeCompany(customer.company) !== normalizeCompany(request.company)) {
    throw new BillingRequestInvalidError("company_mismatch");
  }
  return customer;
}

async function runSteps(row: SubmissionRow, ctx: ProcessingContext): Promise<void> {
  const { api } = ctx;
  const submission = await api.getSubmission(row.submissionId);
  if (!submission) throw new BillingRequestInvalidError("submission_not_found");

  // What can be shown about the request even if it is refused below.
  const peek = peekBillingRequest(submission.answers, ctx.questions);
  if (row.submittedAt === null) {
    await saveUnderClaim(row, {
      requestedBy: isNextcloudUser(submission.userId)
        ? submission.userId.slice(0, 64)
        : "anonymous",
      submittedAt: submission.submittedAt ? new Date(submission.submittedAt * 1000) : new Date(),
      clientCode: peek.clientCode,
      kind: peek.kind,
    });
  }

  // An earlier attempt may have sent a Stripe create (even if its answer or id was lost). Such a
  // request is resumed whatever its age or start date; the Stripe lookups come before any refusal
  // that depends on time.
  const priorAttempt =
    row.stripeStartedAt !== null ||
    row.stripeInvoiceId !== null ||
    row.stripeProductId !== null ||
    row.stripeScheduleId !== null;

  // Too old to bill. With no Stripe call ever made that is final. After one, only an object that is
  // actually found (a saved id, or the metadata lookup in runStripeSteps) resumes the request.
  const tooOld =
    row.submittedAt !== null &&
    Date.now() - row.submittedAt.getTime() > ctx.settings.maxAgeHours * 3_600_000;
  // Only a billing object counts as found: an invoice or a schedule. A saved Product is an orphan
  // that bills nothing and does not rescue an old request.
  const hasSavedId = row.stripeInvoiceId !== null || row.stripeScheduleId !== null;
  if (tooOld && row.stripeStartedAt === null && !hasSavedId) {
    throw new BillingRequestInvalidError("request_expired");
  }
  const expiredUnlessFound = tooOld && !hasSavedId;

  // Once Stripe has been called for this request it was authorized; a retry does not re-ask.
  if (!priorAttempt) await authorize(submission.userId, ctx);

  const requestedAt = row.submittedAt ?? new Date();
  const request = parseBillingRequest(submission.answers, ctx.questions, {
    // The cap was applied when the request was first accepted; lowering it does not strand a resume.
    maxAmountCents: priorAttempt ? Number.MAX_SAFE_INTEGER : ctx.settings.maxAmountCents,
    now: requestedAt,
  });
  const customer = await lookupCustomer(request);
  await saveUnderClaim(row, {
    clientCode: customer.clientCode,
    kind: request.kind,
    amountCents: request.amountCents,
    planInterval: request.kind === "recurring" ? request.interval : null,
    planPayments: request.kind === "recurring" ? request.payments : null,
    planStartDate: request.kind === "recurring" ? request.startDate : null,
  });

  let startUnix: number | null = null;
  let startPassed = false;
  if (request.kind === "recurring") {
    startUnix = chicagoUnix(request.startDate);
    startPassed = !row.stripeScheduleId && startUnix * 1000 <= Date.now() + 60_000;
    // Nothing was ever sent: refuse now. Otherwise runStripeSteps refuses after it looked for the schedule.
    if (startPassed && !priorAttempt) throw new BillingRequestInvalidError("start_date_passed");
  }

  const outcome = await runStripeSteps(
    row,
    {
      formId: row.formId,
      submissionId: row.submissionId,
      stripeCustomerId: customer.stripeCustomerId,
      request,
      autoSend: ctx.settings.autoSend,
      daysUntilDue: ctx.settings.daysUntilDue,
      startUnix,
      startPassed,
      expiredUnlessFound,
    },
    (patch) => saveUnderClaim(row, patch)
  );
  await saveUnderClaim(row, { outcome });

  // Client Billing picks the new invoice or plan up soon instead of at the next sweep.
  try {
    await markCustomerDirty(customer.stripeCustomerId);
  } catch (error) {
    ctx.logger.warn(
      { formId: row.formId, submissionId: row.submissionId, errorName: (error as Error)?.name },
      "Billing request: could not mark the client's billing snapshot dirty."
    );
  }

  const completedAt = new Date();
  const written = await writeResultRow(
    { ...row, status: "completed", lastErrorCode: null, completedAt },
    ctx
  );
  await saveUnderClaim(row, {
    status: "completed",
    completedAt,
    lastErrorCode: null,
    claimedAt: null,
    claimToken: null,
    ...(written ?? {}),
  });
}

async function processClaim(row: SubmissionRow, ctx: ProcessingContext): Promise<Outcome> {
  const ids = { formId: ctx.formId, submissionId: row.submissionId };
  const attemptsBefore = row.attempts;
  try {
    await runSteps(row, ctx);
    ctx.logger.info({ ...ids, outcome: row.outcome }, "Billing request processed.");
    return "completed";
  } catch (error) {
    if (error instanceof NextcloudCircuitOpenError) {
      await saveUnderClaim(row, { claimedAt: null, claimToken: null }).catch(() => undefined);
      throw error;
    }
    if (error instanceof ClaimLostError) {
      ctx.logger.warn(ids, "Billing request claim was taken over by another cycle.");
      return "lost";
    }
    const { code, retryable, stripeDown } = classify(error);
    if (stripeDown) ctx.stop = true;
    const attempts = attemptsBefore + 1;
    const giveUp = !retryable || attempts >= BILLING_REQUESTS_MAX_ATTEMPTS;
    // Stripe already did its part: failing to write the result row must not read as a failed invoice.
    const stripeDone = row.outcome !== null;
    const status = giveUp ? (stripeDone ? "completed" : "failed") : "pending";
    const patch: Partial<typeof t.$inferInsert> = {
      attempts,
      lastErrorCode: code,
      status,
      nextAttemptAt: new Date(Date.now() + retryDelayMs(attempts)),
      ...(status === "completed" ? { completedAt: new Date() } : {}),
    };
    try {
      // Best effort: the failure must be recorded even if the table cannot be written.
      let written: Awaited<ReturnType<typeof writeResultRow>> = null;
      try {
        written = await writeResultRow({ ...row, ...patch }, ctx);
      } catch (writeError) {
        ctx.logger.warn(
          { ...ids, errorName: (writeError as Error)?.name },
          "Billing request: result row could not be written."
        );
      }
      await saveUnderClaim(row, {
        ...patch,
        ...(written ?? {}),
        claimedAt: null,
        claimToken: null,
      });
    } catch (saveError) {
      if (saveError instanceof ClaimLostError) return "lost";
      throw saveError;
    }
    if (giveUp) {
      ctx.logger.error(
        { ...ids, errorCode: code, attempts },
        "Billing request failed; needs an operator."
      );
      return stripeDone ? "completed" : "failed";
    }
    ctx.logger.warn(
      { ...ids, errorCode: code, attempts },
      "Billing request step failed; will retry."
    );
    return "retry";
  }
}

// ── Cycle ────────────────────────────────────────────────────────────────────

interface CycleResult {
  status: CycleStatus;
  discovered: number;
  completed: number;
  retried: number;
  failed: number;
}

export async function runBillingRequestsCycle(options: {
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  /** Tests only: overrides the 200 ms spacing between results-table calls. */
  minGapMs?: number;
}): Promise<CycleResult> {
  const { logger } = options;
  const result: CycleResult = { status: "ok", discovered: 0, completed: 0, retried: 0, failed: 0 };
  const config = loadBillingRequestsConfig(options.env);
  if (config.status === "disabled") return { ...result, status: "disabled" };
  if (config.status === "invalid") {
    logProblemOnce(
      logger,
      `invalid:${config.problems.join("|")}`,
      { problems: config.problems },
      "Billing requests config is invalid; nothing processed."
    );
    return finish({ ...result, status: "invalid_config" });
  }
  if (options.minGapMs !== undefined) config.settings.minGapMs = options.minGapMs;

  const { settings } = config;
  const { formId } = settings;
  const api = new BillingRequestNextcloud(config.nextcloud, formId);
  let ctx: ProcessingContext | null = null;
  try {
    result.discovered = await discover(api, formId, logger);
    // The table exists (and is shared) before the first request, not only after it.
    const table = await provisionResults(config.nextcloud, settings, logger);
    for (let i = 0; i < BILLING_REQUESTS_MAX_PER_CYCLE; i++) {
      if (ctx?.stop) break;
      const row = await claimNextBillingRequest(formId);
      if (!row) break;
      if (!ctx) {
        try {
          const form = await api.getForm();
          ctx = {
            api,
            formId,
            logger,
            questions: resolveBillingQuestions(form.questions),
            settings,
            table,
            stop: false,
          };
        } catch (error) {
          await saveUnderClaim(row, { claimedAt: null, claimToken: null }).catch(() => undefined);
          throw error;
        }
      }
      const outcome = await processClaim(row, ctx);
      if (outcome === "completed") result.completed++;
      else if (outcome === "retry") result.retried++;
      else if (outcome === "failed") result.failed++;
    }
    if (ctx?.stop) return finish({ ...result, status: "stripe_unavailable" });
  } catch (error) {
    if (error instanceof BillingRequestConfigError) {
      logProblemOnce(
        logger,
        `config:${error.code}:${error.detail.join(",")}`,
        { errorCode: error.code, names: error.detail },
        "Billing request form does not match what is expected; nothing processed."
      );
      return finish({ ...result, status: "config_error" });
    }
    if (error instanceof NextcloudCircuitOpenError) {
      logger.warn({ formId }, "Nextcloud circuit is open; billing requests cycle skipped.");
      return finish({ ...result, status: "nextcloud_unavailable" });
    }
    const { code, retryable } = classify(error);
    if (isAuthError(error) || (!retryable && error instanceof NextcloudHttpError)) {
      logProblemOnce(
        logger,
        `http:${code}`,
        { formId, errorCode: code },
        "Nextcloud refused a billing requests call; check the form id and the shares."
      );
      return finish({ ...result, status: "config_error" });
    }
    if (code === "internal_error") {
      logger.error({ formId, errorName: (error as Error)?.name }, "Billing requests cycle failed.");
      return finish({ ...result, status: "error" });
    }
    logger.warn({ formId, errorCode: code }, "Billing requests cycle could not reach Nextcloud.");
    return finish({ ...result, status: "nextcloud_unavailable" });
  }
  lastLoggedProblem = null;
  if (result.discovered || result.completed || result.retried || result.failed) {
    logger.info({ formId, ...result }, "Billing requests cycle finished.");
  }
  return finish(result);
}

function finish(result: CycleResult): CycleResult {
  stats.lastCycleAt = new Date();
  stats.lastCycleStatus = result.status;
  return result;
}

// ── Runner: poller + webhook trigger ─────────────────────────────────────────

export interface BillingRequestsRunner {
  /** Asks for a cycle now. One runs at a time; a request during a cycle queues one more. */
  trigger(): void;
  /** Stops the timer and waits for a running cycle to finish. */
  stop(): Promise<void>;
}

interface ActiveRunner {
  runner: BillingRequestsRunner;
  webhookSecret: string | null;
}

let active: ActiveRunner | null = null;

/** The running automation's webhook secret and trigger; null when the webhook is off. */
export function getBillingRequestsWebhook(): { secret: string; trigger: () => void } | null {
  if (!active?.webhookSecret) return null;
  return { secret: active.webhookSecret, trigger: active.runner.trigger };
}

/**
 * Starts the poller when BILLING_REQUESTS_ENABLED=true and the config is valid; otherwise logs why
 * and returns null. Never throws: the payment API must start regardless.
 */
export function startBillingRequests(
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env
): BillingRequestsRunner | null {
  const config = loadBillingRequestsConfig(env);
  if (config.status === "disabled") return null;
  if (config.status === "invalid") {
    logger.error(
      { problems: config.problems },
      "Billing requests are enabled but their config is invalid; not started."
    );
    return null;
  }

  let running: Promise<unknown> | null = null;
  let again = false;
  let stopped = false;
  const run = () => {
    running = runBillingRequestsCycle({ logger, env })
      .catch((error: unknown) => {
        logger.error({ errorName: (error as Error)?.name }, "Billing requests cycle crashed.");
      })
      .finally(() => {
        running = null;
        if (again && !stopped) {
          again = false;
          run();
        }
      });
  };
  const trigger = () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    run();
  };
  const timer = setInterval(trigger, config.settings.pollIntervalMs);
  timer.unref();

  const runner: BillingRequestsRunner = {
    trigger,
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (active?.runner === runner) active = null;
      while (running) await running;
    },
  };
  active = { runner, webhookSecret: config.settings.webhookSecret };
  trigger();
  logger.info(
    {
      formId: config.settings.formId,
      pollIntervalMs: config.settings.pollIntervalMs,
      webhook: config.settings.webhookSecret !== null,
      autoSend: config.settings.autoSend,
    },
    "Billing requests started."
  );
  return runner;
}
