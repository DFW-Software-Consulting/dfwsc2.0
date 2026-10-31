import crypto from "node:crypto";
import { and, eq, max, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/client";
import { salesLeadSubmissions, salesLeadSyncState } from "../db/schema";
import {
  SALES_LEAD_CLAIM_LEASE_MS,
  SALES_LEAD_DEFAULT_POLL_INTERVAL_MS,
  SALES_LEAD_MAX_ATTEMPTS,
  SALES_LEAD_MAX_DISCOVERY_PAGES,
  SALES_LEAD_MAX_FOLDER_SUFFIX,
  SALES_LEAD_MAX_PER_CYCLE,
  SALES_LEAD_MIN_POLL_INTERVAL_MS,
  SALES_LEAD_RETRY_BASE_MS,
  SALES_LEAD_RETRY_MAX_MS,
} from "./constants";
import {
  getNextcloudConfig,
  NextcloudCircuitOpenError,
  type NextcloudConfig,
  NextcloudHttpError,
  NextcloudRequestError,
} from "./nextcloud";
import {
  buildRowData,
  buildVCard,
  type ColumnMap,
  contactUid,
  extractLead,
  folderNameCandidate,
  hasPerson,
  leadRef,
  linkValue,
  type QuestionMap,
  resolveColumns,
  resolveQuestions,
  SalesLeadConfigError,
  SalesLeadInvalidError,
  sanitizeFolderName,
} from "./sales-lead-mapping";
import {
  isBadResponseError,
  SalesLeadNextcloud,
  type SalesLeadTargets,
  SUBMISSION_PAGE_SIZE,
} from "./sales-lead-nextcloud";

// "DFWSC — New Lead" automation. An in-process poller reads new submissions of
// one Nextcloud Form and, for each, creates exactly once: a Sales Pipeline row
// (Tables), a contact card when a person was given (CardDAV) and a lead folder
// (WebDAV), then fills the row's Contact Card and Notes / Files links.
//
// Forms is the queue: a submission is only recorded here once seen, and nothing
// is lost while Nextcloud or this API is down. Progress per submission lives in
// sales_lead_submissions; each step's output is saved as soon as it succeeds, so
// a retry resumes at the first step without output. Rows are claimed with a
// lease (FOR UPDATE SKIP LOCKED), so overlapping cycles or replicas never work
// on the same submission at once.
//
// Logs carry ids, step labels, statuses and error codes only: never answers,
// company or contact names, emails, phone numbers, folder names or DAV paths.

type Logger = Pick<FastifyBaseLogger, "info" | "warn" | "error">;

interface SalesLeadSettings extends SalesLeadTargets {
  pollIntervalMs: number;
}

export type SalesLeadConfigResult =
  | { status: "disabled" }
  | { status: "invalid"; problems: string[] }
  | { status: "ready"; nextcloud: NextcloudConfig; settings: SalesLeadSettings };

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return parsed > 0 && Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Path segments of a folder setting such as "DFWSC Sales/Leads"; undefined when unsafe. */
function parseFolderSegments(value: string | undefined): string[] | undefined {
  const segments = (value ?? "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.length || segments.some((s) => s === "." || s === "..")) return undefined;
  return segments;
}

export function loadSalesLeadConfig(env: NodeJS.ProcessEnv = process.env): SalesLeadConfigResult {
  if (env.SALES_AUTOMATION_ENABLED?.trim() !== "true") return { status: "disabled" };
  const problems: string[] = [];

  const nc = getNextcloudConfig(env);
  if (!nc.ok) {
    problems.push(
      nc.reason === "not_configured"
        ? "NEXTCLOUD_BASE_URL, NEXTCLOUD_USERNAME and NEXTCLOUD_APP_PASSWORD are required"
        : "NEXTCLOUD_BASE_URL must be a valid https:// URL"
    );
  }
  const formId = parsePositiveInt(env.SALES_LEAD_FORM_ID);
  if (formId === undefined) problems.push("SALES_LEAD_FORM_ID must be a positive integer");
  const tableId = parsePositiveInt(env.SALES_PIPELINE_TABLE_ID);
  if (tableId === undefined) problems.push("SALES_PIPELINE_TABLE_ID must be a positive integer");
  const addressbookPath = env.SALES_ADDRESSBOOK_PATH?.trim() ?? "";
  if (!addressbookPath || addressbookPath.includes("/") || /^\.+$/.test(addressbookPath)) {
    problems.push("SALES_ADDRESSBOOK_PATH must be one address book collection name");
  }
  const leadsFolder = parseFolderSegments(env.SALES_LEADS_FOLDER);
  if (!leadsFolder) problems.push("SALES_LEADS_FOLDER must be a folder path without . or ..");
  let pollIntervalMs = SALES_LEAD_DEFAULT_POLL_INTERVAL_MS;
  if (env.SALES_POLL_INTERVAL_MS?.trim()) {
    const parsed = parsePositiveInt(env.SALES_POLL_INTERVAL_MS);
    if (parsed === undefined || parsed < SALES_LEAD_MIN_POLL_INTERVAL_MS) {
      problems.push(`SALES_POLL_INTERVAL_MS must be at least ${SALES_LEAD_MIN_POLL_INTERVAL_MS}`);
    } else {
      pollIntervalMs = parsed;
    }
  }

  if (!nc.ok || problems.length || formId === undefined || tableId === undefined || !leadsFolder) {
    return { status: "invalid", problems };
  }
  return {
    status: "ready",
    nextcloud: nc.config,
    settings: { formId, tableId, addressbookPath, leadsFolder, pollIntervalMs },
  };
}

// ── Cycle state for metrics ──────────────────────────────────────────────────

type CycleStatus =
  | "disabled"
  | "invalid_config"
  | "config_error"
  | "nextcloud_unavailable"
  | "error"
  | "ok";

const stats: { lastCycleAt: Date | null; lastCycleStatus: CycleStatus | null } = {
  lastCycleAt: null,
  lastCycleStatus: null,
};

export function getSalesLeadSyncStats() {
  return { ...stats };
}

// The same configuration problem is logged once, not on every 2-minute cycle,
// until a cycle succeeds again.
let lastLoggedProblem: string | null = null;

function logProblemOnce(logger: Logger, key: string, fields: Record<string, unknown>, msg: string) {
  if (lastLoggedProblem === key) return;
  lastLoggedProblem = key;
  logger.error(fields, msg);
}

export function resetSalesLeadSyncStateForTests() {
  stats.lastCycleAt = null;
  stats.lastCycleStatus = null;
  lastLoggedProblem = null;
}

// ── Persistence ──────────────────────────────────────────────────────────────

type SubmissionRow = typeof salesLeadSubmissions.$inferSelect;

class ClaimLostError extends Error {
  constructor() {
    super("Claim on sales lead submission was lost");
    this.name = "ClaimLostError";
  }
}

/** Records the baseline on first sight of a form; returns it. */
async function ensureBaseline(
  api: SalesLeadNextcloud,
  formId: number,
  logger: Logger
): Promise<number | null> {
  const [state] = await db
    .select()
    .from(salesLeadSyncState)
    .where(eq(salesLeadSyncState.formId, formId));
  if (state) return state.baselineSubmissionId;

  const ids = await api.listSubmissionIds(0);
  const baseline = ids.length ? Math.max(...ids) : 0;
  const inserted = await db
    .insert(salesLeadSyncState)
    .values({ formId, baselineSubmissionId: baseline })
    .onConflictDoNothing()
    .returning();
  if (inserted.length) {
    logger.info(
      { formId, baselineSubmissionId: baseline },
      "Sales lead automation baseline recorded; earlier submissions are skipped."
    );
  }
  // First sight of the form: nothing after the baseline exists yet.
  return null;
}

/** Records submission ids newer than everything already known. Returns how many were new. */
async function discover(api: SalesLeadNextcloud, formId: number, logger: Logger): Promise<number> {
  const baseline = await ensureBaseline(api, formId, logger);
  if (baseline === null) return 0;

  const [known] = await db
    .select({ highest: max(salesLeadSubmissions.submissionId) })
    .from(salesLeadSubmissions)
    .where(eq(salesLeadSubmissions.formId, formId));
  const highWater = Math.max(baseline, known?.highest ?? 0);

  const fresh: number[] = [];
  for (let page = 0; page < SALES_LEAD_MAX_DISCOVERY_PAGES; page++) {
    const ids = await api.listSubmissionIds(page * SUBMISSION_PAGE_SIZE);
    const newer = ids.filter((id) => id > highWater);
    fresh.push(...newer);
    // Newest first: once a page reaches known ids, or runs short, there is nothing older to find.
    if (newer.length < ids.length || ids.length < SUBMISSION_PAGE_SIZE) break;
  }
  if (!fresh.length) return 0;
  const inserted = await db
    .insert(salesLeadSubmissions)
    .values(fresh.map((submissionId) => ({ formId, submissionId })))
    .onConflictDoNothing()
    .returning({ submissionId: salesLeadSubmissions.submissionId });
  return inserted.length;
}

async function claimNext(formId: number): Promise<SubmissionRow | null> {
  const t = salesLeadSubmissions;
  const token = crypto.randomUUID();
  const leaseSeconds = Math.floor(SALES_LEAD_CLAIM_LEASE_MS / 1000);
  const [row] = await db
    .update(t)
    .set({ claimedAt: sql`now()`, claimToken: token })
    .where(
      sql`(${t.formId}, ${t.submissionId}) IN (
        SELECT form_id, submission_id FROM sales_lead_submissions
        WHERE form_id = ${formId}
          AND status = 'pending'
          AND next_attempt_at <= now()
          AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => ${leaseSeconds}))
        ORDER BY submission_id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )`
    )
    .returning();
  return row ?? null;
}

/** Saves step output under the caller's claim; throws when another cycle took it over. */
async function saveUnderClaim(
  row: SubmissionRow,
  patch: Partial<typeof salesLeadSubmissions.$inferInsert>
): Promise<void> {
  const t = salesLeadSubmissions;
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
}

// ── Processing ───────────────────────────────────────────────────────────────

interface ProcessingContext {
  api: SalesLeadNextcloud;
  formId: number;
  questions: QuestionMap;
  columns: ColumnMap;
  logger: Logger;
}

type Outcome = "completed" | "retry" | "failed" | "lost";

const RETRYABLE_HTTP_STATUSES = new Set([401, 408, 423, 425, 429]);

function classify(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof SalesLeadInvalidError) return { code: error.code, retryable: false };
  if (error instanceof NextcloudHttpError) {
    return {
      code: `${error.label}:${error.status}`,
      retryable: error.status >= 500 || RETRYABLE_HTTP_STATUSES.has(error.status),
    };
  }
  if (error instanceof NextcloudRequestError) {
    return { code: `${error.label}:${error.kind}`, retryable: true };
  }
  if (isBadResponseError(error)) return { code: `${error.label}:bad_response`, retryable: true };
  return { code: "internal_error", retryable: true };
}

function retryDelayMs(attempts: number): number {
  return Math.min(
    SALES_LEAD_RETRY_BASE_MS * 2 ** Math.max(attempts - 1, 0),
    SALES_LEAD_RETRY_MAX_MS
  );
}

async function chooseFolderName(api: SalesLeadNextcloud, base: string): Promise<string> {
  for (let n = 1; n <= SALES_LEAD_MAX_FOLDER_SUFFIX; n++) {
    const candidate = folderNameCandidate(base, n);
    if (!(await api.folderExists(candidate))) return candidate;
  }
  throw new SalesLeadInvalidError("folder_names_exhausted");
}

async function runSteps(row: SubmissionRow, ctx: ProcessingContext): Promise<void> {
  const { api, formId, columns, logger } = ctx;
  const ids = { formId, submissionId: row.submissionId };

  const submission = await api.getSubmission(row.submissionId);
  if (!submission) throw new SalesLeadInvalidError("submission_not_found");
  const lead = extractLead(submission.answers, ctx.questions);
  const ref = leadRef(formId, row.submissionId);

  // 1. Pipeline row. Searching Lead Ref first means a create whose response was
  // lost (Nextcloud made the row, we never saw its id) is adopted, not repeated.
  let rowId = row.tableRowId;
  if (rowId === null) {
    rowId = await api.findRowId(columns.leadRef.id, ref);
    if (rowId === null) {
      const { data, dropped } = buildRowData(lead, columns, ref);
      if (dropped.length) {
        logger.warn({ ...ids, fields: dropped }, "Sales lead answers left out of the row.");
      }
      rowId = await api.createRow(data);
      logger.info({ ...ids, rowId }, "Sales lead row created.");
    } else {
      logger.info({ ...ids, rowId }, "Sales lead row already existed; adopted it.");
    }
    await saveUnderClaim(row, { tableRowId: rowId });
  }

  // 2. Contact card, only when a person was given. The UID is deterministic and the
  // PUT is create-only, so a repeat is a no-op.
  let uid = row.contactUid;
  if (uid === null && hasPerson(lead)) {
    uid = contactUid(formId, row.submissionId);
    await api.putContact(uid, buildVCard(lead, uid));
    await saveUnderClaim(row, { contactUid: uid });
    logger.info(ids, "Sales lead contact card created.");
  }

  // 3. Folder. The chosen name is saved before MKCOL, so on a retry an existing
  // folder with that name is ours, not a collision.
  let fileId = row.folderFileId;
  if (fileId === null) {
    let folderName = row.folderName;
    if (folderName === null) {
      const base = sanitizeFolderName(lead.company, row.submissionId);
      folderName = await chooseFolderName(api, base);
      await saveUnderClaim(row, { folderName });
      if (folderName !== base) {
        logger.warn(
          { ...ids, duplicateCompany: true },
          "Sales lead folder name was taken; suffixed."
        );
      }
    }
    await api.createFolder(folderName);
    fileId = await api.getFileId(folderName);
    await saveUnderClaim(row, { folderFileId: fileId });
    logger.info(ids, "Sales lead folder created.");
  }

  // 4. Links on the row.
  if (row.linksBackfilledAt === null) {
    const data: Record<string, unknown> = {
      [columns.notesFiles.id]: linkValue("Lead folder", api.folderLink(fileId)),
    };
    if (uid !== null)
      data[columns.contactCard.id] = linkValue("Contact card", api.contactLink(uid));
    await api.updateRow(rowId, data);
  }

  const now = new Date();
  await saveUnderClaim(row, {
    status: "completed",
    linksBackfilledAt: row.linksBackfilledAt ?? now,
    completedAt: now,
    lastErrorCode: null,
    claimedAt: null,
    claimToken: null,
  });
}

async function processClaim(row: SubmissionRow, ctx: ProcessingContext): Promise<Outcome> {
  const ids = { formId: ctx.formId, submissionId: row.submissionId };
  try {
    await runSteps(row, ctx);
    ctx.logger.info(ids, "Sales lead processed.");
    return "completed";
  } catch (error) {
    if (error instanceof NextcloudCircuitOpenError) {
      // Not this submission's fault: hand it back without using an attempt.
      await saveUnderClaim(row, { claimedAt: null, claimToken: null }).catch(() => undefined);
      throw error;
    }
    if (error instanceof ClaimLostError) {
      ctx.logger.warn(ids, "Sales lead claim was taken over by another cycle.");
      return "lost";
    }
    const { code, retryable } = classify(error);
    const attempts = row.attempts + 1;
    const giveUp = !retryable || attempts >= SALES_LEAD_MAX_ATTEMPTS;
    try {
      await saveUnderClaim(row, {
        attempts,
        lastErrorCode: code,
        status: giveUp ? "failed" : "pending",
        nextAttemptAt: new Date(Date.now() + retryDelayMs(attempts)),
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
        "Sales lead failed; needs an operator."
      );
      return "failed";
    }
    ctx.logger.warn({ ...ids, errorCode: code, attempts }, "Sales lead step failed; will retry.");
    return "retry";
  }
}

export interface CycleResult {
  status: CycleStatus;
  discovered: number;
  completed: number;
  retried: number;
  failed: number;
}

export async function runSalesLeadCycle(options: {
  logger: Logger;
  env?: NodeJS.ProcessEnv;
}): Promise<CycleResult> {
  const { logger } = options;
  const result: CycleResult = { status: "ok", discovered: 0, completed: 0, retried: 0, failed: 0 };
  const config = loadSalesLeadConfig(options.env);
  if (config.status === "disabled") return { ...result, status: "disabled" };
  if (config.status === "invalid") {
    logProblemOnce(
      logger,
      `invalid:${config.problems.join("|")}`,
      { problems: config.problems },
      "Sales lead automation config is invalid; nothing processed."
    );
    return finish({ ...result, status: "invalid_config" });
  }

  const { formId } = config.settings;
  const api = new SalesLeadNextcloud(config.nextcloud, config.settings);
  let ctx: ProcessingContext | null = null;
  try {
    result.discovered = await discover(api, formId, logger);
    for (let i = 0; i < SALES_LEAD_MAX_PER_CYCLE; i++) {
      const row = await claimNext(formId);
      if (!row) break;
      if (!ctx) {
        try {
          ctx = {
            api,
            formId,
            logger,
            questions: resolveQuestions(await api.getQuestions()),
            columns: resolveColumns(await api.getColumns()),
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
  } catch (error) {
    if (error instanceof SalesLeadConfigError) {
      logProblemOnce(
        logger,
        `config:${error.message}`,
        { errorCode: error.code, titles: error.detail },
        "Sales lead form or table does not match the expected titles; nothing processed."
      );
      return finish({ ...result, status: "config_error" });
    }
    if (error instanceof NextcloudCircuitOpenError) {
      logger.warn({ formId }, "Nextcloud circuit is open; sales lead cycle skipped.");
      return finish({ ...result, status: "nextcloud_unavailable" });
    }
    const { code, retryable } = classify(error);
    if (!retryable) {
      // 403/404 on the form or table: a share or id is wrong, not an outage.
      logProblemOnce(
        logger,
        `http:${code}`,
        { formId, errorCode: code },
        "Nextcloud refused a sales lead request; check the shares and ids."
      );
      return finish({ ...result, status: "config_error" });
    }
    if (code === "internal_error") {
      // Only the error's class: messages from lower layers are not known to be PII-free.
      logger.error({ formId, errorName: (error as Error)?.name }, "Sales lead cycle failed.");
      return finish({ ...result, status: "error" });
    }
    logger.warn({ formId, errorCode: code }, "Sales lead cycle could not reach Nextcloud.");
    return finish({ ...result, status: "nextcloud_unavailable" });
  }
  lastLoggedProblem = null;
  if (result.discovered || result.completed || result.retried || result.failed) {
    logger.info({ formId, ...result }, "Sales lead cycle finished.");
  }
  return finish(result);
}

function finish(result: CycleResult): CycleResult {
  stats.lastCycleAt = new Date();
  stats.lastCycleStatus = result.status;
  return result;
}

// ── Poller ───────────────────────────────────────────────────────────────────

export interface SalesLeadPoller {
  /** Stops the timer and waits for a running cycle to finish. */
  stop(): Promise<void>;
}

/**
 * Starts the poller when SALES_AUTOMATION_ENABLED=true and the config is valid;
 * otherwise logs why (once) and returns null. Never throws: the payment API must
 * start regardless.
 */
export function startSalesLeadPoller(
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env
): SalesLeadPoller | null {
  const config = loadSalesLeadConfig(env);
  if (config.status === "disabled") return null;
  if (config.status === "invalid") {
    logger.error(
      { problems: config.problems },
      "Sales lead automation is enabled but its config is invalid; poller not started."
    );
    return null;
  }

  let running: Promise<unknown> | null = null;
  const tick = () => {
    if (running) return;
    running = runSalesLeadCycle({ logger, env })
      .catch((error: unknown) => {
        logger.error({ errorName: (error as Error)?.name }, "Sales lead cycle crashed.");
      })
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, config.settings.pollIntervalMs);
  timer.unref();
  tick();
  logger.info(
    { formId: config.settings.formId, pollIntervalMs: config.settings.pollIntervalMs },
    "Sales lead automation poller started."
  );

  return {
    async stop() {
      clearInterval(timer);
      if (running) await running;
    },
  };
}
