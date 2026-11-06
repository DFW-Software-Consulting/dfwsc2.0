import crypto from "node:crypto";
import { and, eq, isNotNull, isNull, max, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/client";
import { clientOnboardingSubmissions, clientOnboardingSyncState } from "../db/schema";
import {
  BillingCustomerStripeError,
  ensureBillingCustomer,
  isValidEmail,
} from "./billing-customer";
import {
  buildClientVCard,
  buildProjectRowData,
  CLIENT_SUBFOLDERS,
  clientContactUid,
  clientFolderName,
  extractIntake,
  formatProjectCode,
  type Intake,
  type IntakeQuestionMap,
  isNextcloudUser,
  normalizeName,
  OnboardingConfigError,
  OnboardingInvalidError,
  type PipelineColumnMap,
  PROMOTABLE_STAGE_IDS,
  type ProjectColumnMap,
  parseLeadReference,
  parseProjectNumber,
  projectBriefContent,
  projectHubContent,
  projectPageTitle,
  projectTeamName,
  resolveIntakeQuestions,
  resolvePipelineColumns,
  resolveProjectColumns,
  selectionValue,
  slugify,
  stageOptionId,
  vCardUid,
  WON_STAGE,
  WON_STAGE_ID,
} from "./client-onboarding-mapping";
import {
  ClientOnboardingNextcloud,
  type ClientOnboardingTargets,
  type CollectivePage,
  type TableRow,
  TEAM_LEVEL_ADMIN,
} from "./client-onboarding-nextcloud";
import {
  CLIENT_ONBOARDING_CLAIM_LEASE_MS,
  CLIENT_ONBOARDING_DEFAULT_POLL_INTERVAL_MS,
  CLIENT_ONBOARDING_MAX_ATTEMPTS,
  CLIENT_ONBOARDING_MAX_DISCOVERY_PAGES,
  CLIENT_ONBOARDING_MAX_PER_CYCLE,
  CLIENT_ONBOARDING_MIN_POLL_INTERVAL_MS,
  CLIENT_ONBOARDING_MIN_WEBHOOK_SECRET_LENGTH,
  CLIENT_ONBOARDING_RETRY_BASE_MS,
  CLIENT_ONBOARDING_RETRY_MAX_MS,
} from "./constants";
import { resetCardBaseline } from "./contact-stripe-sync";
import {
  getNextcloudConfig,
  NextcloudCircuitOpenError,
  type NextcloudConfig,
  NextcloudHttpError,
  NextcloudRequestError,
} from "./nextcloud";
import {
  AddressbookDiscoveryError,
  ContactChangedError,
  type ContactDirectory,
  mergeContactVCard,
} from "./nextcloud-contacts";
import { linkCellUrl, linkValue, parseDate } from "./sales-lead-mapping";
import {
  isBadResponseError,
  NextcloudBadResponseError,
  SUBMISSION_PAGE_SIZE,
} from "./sales-lead-nextcloud";

// "DFWSC — Convert Won Lead to Client" onboarding. For each submission of one
// Nextcloud Form, exactly once: a client folder with Meetings/ Decisions/
// Deliverables/, a contact card (created or updated), a Client Projects row with
// the next CP-### code, a Collectives project page, the row's links, and the
// matching Sales Pipeline row set to Won with a link to the project.
//
// With CLIENT_ONBOARDING_PROJECT_TEAMS=true each project also gets a Nextcloud Team
// ("CP-### <Project name>", admins from CLIENT_ONBOARDING_TEAM_ADMINS, the submitter
// as a member), a collective of the same name whose landing page is the Project Brief,
// and the client folder shared with the team. The Client Projects page then becomes a
// short hub that links to all of it. With the flag off none of this runs.
//
// Same model as the New Lead automation (lib/sales-lead-sync.ts): Forms is the
// queue, progress per submission lives in client_onboarding_submissions, each
// step's output is saved as soon as it succeeds, and rows are claimed with a lease.
// A Nextcloud webhook (routes/nextcloud-webhooks.ts) only asks for a cycle to run
// now; the poller runs one anyway every CLIENT_ONBOARDING_POLL_INTERVAL_MS, so a
// lost webhook delays a submission but never loses it.
//
// Logs carry ids, step labels, statuses and error codes only: never answers,
// company, project or contact names, emails, phone numbers or DAV paths.

type Logger = Pick<FastifyBaseLogger, "info" | "warn" | "error">;

/** Per-project Teams; null when CLIENT_ONBOARDING_PROJECT_TEAMS is off. */
interface ProjectTeamsSettings {
  /** Nextcloud user ids raised to team admin (level 8). */
  admins: string[];
}

interface ClientOnboardingSettings extends ClientOnboardingTargets {
  teams: ProjectTeamsSettings | null;
  /** Create/link the DFWSC billing Stripe Customer (CLIENT_ONBOARDING_BILLING_CUSTOMER). */
  billingCustomer: boolean;
  pollIntervalMs: number;
  /** Shared secret for the webhook; null leaves the webhook off (poll only). */
  webhookSecret: string | null;
}

type ClientOnboardingConfigResult =
  | { status: "disabled" }
  | { status: "invalid"; problems: string[] }
  | { status: "ready"; nextcloud: NextcloudConfig; settings: ClientOnboardingSettings };

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return parsed > 0 && Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseFolderSegments(value: string | undefined): string[] | undefined {
  const segments = (value ?? "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.length || segments.some((s) => s === "." || s === "..")) return undefined;
  return segments;
}

/** Comma-separated user ids. Ids may contain spaces, so only the ends are trimmed. */
function parseTeamAdmins(value: string | undefined): string[] {
  const ids = (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

function loadClientOnboardingConfig(
  env: NodeJS.ProcessEnv = process.env
): ClientOnboardingConfigResult {
  if (env.CLIENT_ONBOARDING_ENABLED?.trim() !== "true") return { status: "disabled" };
  const problems: string[] = [];

  const nc = getNextcloudConfig(env);
  if (!nc.ok) {
    problems.push(
      nc.reason === "not_configured"
        ? "NEXTCLOUD_BASE_URL, NEXTCLOUD_USERNAME and NEXTCLOUD_APP_PASSWORD are required"
        : "NEXTCLOUD_BASE_URL must be a valid https:// URL"
    );
  }
  const ints: Record<string, number | undefined> = {};
  for (const key of [
    "CLIENT_ONBOARDING_FORM_ID",
    "CLIENT_ONBOARDING_PROJECTS_TABLE_ID",
    "CLIENT_ONBOARDING_PIPELINE_TABLE_ID",
    "CLIENT_ONBOARDING_COLLECTIVE_ID",
  ]) {
    ints[key] = parsePositiveInt(env[key]);
    if (ints[key] === undefined) problems.push(`${key} must be a positive integer`);
  }
  const addressbookPath = env.CLIENT_ONBOARDING_ADDRESSBOOK_PATH?.trim() ?? "";
  if (!addressbookPath || addressbookPath.includes("/") || /^\.+$/.test(addressbookPath)) {
    problems.push("CLIENT_ONBOARDING_ADDRESSBOOK_PATH must be one address book collection name");
  }
  const clientsFolder = parseFolderSegments(env.CLIENT_ONBOARDING_CLIENTS_FOLDER);
  if (!clientsFolder) {
    problems.push("CLIENT_ONBOARDING_CLIENTS_FOLDER must be a folder path without . or ..");
  }
  let pollIntervalMs = CLIENT_ONBOARDING_DEFAULT_POLL_INTERVAL_MS;
  if (env.CLIENT_ONBOARDING_POLL_INTERVAL_MS?.trim()) {
    const parsed = parsePositiveInt(env.CLIENT_ONBOARDING_POLL_INTERVAL_MS);
    if (parsed === undefined || parsed < CLIENT_ONBOARDING_MIN_POLL_INTERVAL_MS) {
      problems.push(
        `CLIENT_ONBOARDING_POLL_INTERVAL_MS must be at least ${CLIENT_ONBOARDING_MIN_POLL_INTERVAL_MS}`
      );
    } else {
      pollIntervalMs = parsed;
    }
  }
  // Not trimmed: the secret is compared byte for byte with the header Nextcloud sends.
  const webhookSecret = env.CLIENT_ONBOARDING_WEBHOOK_SECRET || null;
  if (
    webhookSecret !== null &&
    webhookSecret.length < CLIENT_ONBOARDING_MIN_WEBHOOK_SECRET_LENGTH
  ) {
    problems.push(
      `CLIENT_ONBOARDING_WEBHOOK_SECRET must be at least ${CLIENT_ONBOARDING_MIN_WEBHOOK_SECRET_LENGTH} characters`
    );
  }

  let teams: ProjectTeamsSettings | null = null;
  if (env.CLIENT_ONBOARDING_PROJECT_TEAMS?.trim() === "true") {
    const admins = parseTeamAdmins(env.CLIENT_ONBOARDING_TEAM_ADMINS);
    if (!admins.length) {
      problems.push(
        "CLIENT_ONBOARDING_TEAM_ADMINS must list at least one user id when CLIENT_ONBOARDING_PROJECT_TEAMS=true"
      );
    }
    teams = { admins };
  }

  const billingCustomer = env.CLIENT_ONBOARDING_BILLING_CUSTOMER?.trim() === "true";

  if (!nc.ok || problems.length || !clientsFolder) return { status: "invalid", problems };
  return {
    status: "ready",
    nextcloud: nc.config,
    settings: {
      formId: ints.CLIENT_ONBOARDING_FORM_ID as number,
      projectsTableId: ints.CLIENT_ONBOARDING_PROJECTS_TABLE_ID as number,
      pipelineTableId: ints.CLIENT_ONBOARDING_PIPELINE_TABLE_ID as number,
      collectiveId: ints.CLIENT_ONBOARDING_COLLECTIVE_ID as number,
      addressbookPath,
      clientsFolder,
      teams,
      billingCustomer,
      pollIntervalMs,
      webhookSecret,
    },
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

export function getClientOnboardingStats() {
  return { ...stats };
}

let lastLoggedProblem: string | null = null;

function logProblemOnce(logger: Logger, key: string, fields: Record<string, unknown>, msg: string) {
  if (lastLoggedProblem === key) return;
  lastLoggedProblem = key;
  logger.error(fields, msg);
}

export function resetClientOnboardingStateForTests() {
  stats.lastCycleAt = null;
  stats.lastCycleStatus = null;
  lastLoggedProblem = null;
  active = null;
}

// ── Persistence ──────────────────────────────────────────────────────────────

type SubmissionRow = typeof clientOnboardingSubmissions.$inferSelect;
const t = clientOnboardingSubmissions;

class ClaimLostError extends Error {
  constructor() {
    super("Claim on client onboarding submission was lost");
    this.name = "ClaimLostError";
  }
}

/** The allocated CP code was taken in Tables by someone else; a new one is already saved. */
class ProjectCodeTakenError extends Error {
  readonly code = "project_code_taken";
  constructor() {
    super("project_code_taken");
    this.name = "ProjectCodeTakenError";
  }
}

/** Tables accepted a row update but the read-back does not show it; retried. */
class LinksNotPersistedError extends Error {
  readonly code = "tables.link_not_persisted";
  constructor() {
    super("Tables did not store the client onboarding links");
    this.name = "LinksNotPersistedError";
  }
}

async function ensureBaseline(
  api: ClientOnboardingNextcloud,
  formId: number,
  logger: Logger
): Promise<number | null> {
  const [state] = await db
    .select()
    .from(clientOnboardingSyncState)
    .where(eq(clientOnboardingSyncState.formId, formId));
  if (state) return state.baselineSubmissionId;

  const ids = await api.listSubmissionIds(0);
  const baseline = ids.length ? Math.max(...ids) : 0;
  const inserted = await db
    .insert(clientOnboardingSyncState)
    .values({ formId, baselineSubmissionId: baseline })
    .onConflictDoNothing()
    .returning();
  if (inserted.length) {
    logger.info(
      { formId, baselineSubmissionId: baseline },
      "Client onboarding baseline recorded; earlier submissions are skipped."
    );
  }
  return null;
}

async function discover(
  api: ClientOnboardingNextcloud,
  formId: number,
  logger: Logger
): Promise<number> {
  const baseline = await ensureBaseline(api, formId, logger);
  if (baseline === null) return 0;

  const [known] = await db
    .select({ highest: max(t.submissionId) })
    .from(t)
    .where(eq(t.formId, formId));
  const highWater = Math.max(baseline, known?.highest ?? 0);

  const fresh: number[] = [];
  for (let page = 0; page < CLIENT_ONBOARDING_MAX_DISCOVERY_PAGES; page++) {
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
 * Claims the lowest-id due row. The candidate is picked in a MATERIALIZED CTE so it is
 * evaluated once: with the subquery inline, Postgres may re-run it per row of the
 * UPDATE and claim every due row, leaving all but one stuck until the lease runs out.
 */
export async function claimNextOnboarding(formId: number): Promise<SubmissionRow | null> {
  const token = crypto.randomUUID();
  const leaseSeconds = Math.floor(CLIENT_ONBOARDING_CLAIM_LEASE_MS / 1000);
  const claimed = await db.execute<{ submission_id: number }>(sql`
    WITH c AS MATERIALIZED (
      SELECT form_id, submission_id FROM client_onboarding_submissions
      WHERE form_id = ${formId}
        AND status = 'pending'
        AND next_attempt_at <= now()
        AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => ${leaseSeconds}))
      ORDER BY submission_id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE client_onboarding_submissions AS u
    SET claimed_at = now(), claim_token = ${token}
    FROM c
    WHERE u.form_id = c.form_id AND u.submission_id = c.submission_id
    RETURNING u.submission_id
  `);
  if (claimed.rows.length === 0) return null;
  const [row] = await db
    .select()
    .from(clientOnboardingSubmissions)
    .where(
      and(
        eq(clientOnboardingSubmissions.formId, formId),
        eq(clientOnboardingSubmissions.claimToken, token)
      )
    );
  return row ?? null;
}

async function saveUnderClaim(
  row: SubmissionRow,
  patch: Partial<typeof clientOnboardingSubmissions.$inferInsert>
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

/**
 * Gives the claimed submission the next CP-### code, once. Serialized by a
 * transaction-scoped advisory lock, so concurrent cycles (or replicas) never hand
 * out the same number. The number is the highest of every code this service has
 * allocated (including codes of submissions that later failed, so a code is never
 * reused) and the highest code already in the Projects table (`tableHighest`, e.g.
 * rows made by hand), plus one. The code is written in the same transaction, so a
 * retry of any later step keeps it.
 *
 * With `replace`, a code that turned out to be taken in the Projects table (no row
 * made yet) is swapped for a fresh one above everything seen, including the burned
 * code itself, so it is never handed out again.
 */
export async function allocateProjectCode(
  row: Pick<SubmissionRow, "formId" | "submissionId" | "claimToken">,
  tableHighest: number,
  replace = false
): Promise<{ projectNumber: number; projectCode: string }> {
  const claimToken = row.claimToken;
  if (!claimToken) throw new ClaimLostError();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('client_onboarding_project_code'))`);
    const [current] = await tx
      .select({ projectNumber: t.projectNumber, projectCode: t.projectCode })
      .from(t)
      .where(and(eq(t.formId, row.formId), eq(t.submissionId, row.submissionId)));
    if (!replace && current?.projectNumber != null && current.projectCode) {
      return { projectNumber: current.projectNumber, projectCode: current.projectCode };
    }
    const [{ highest }] = await tx.select({ highest: max(t.projectNumber) }).from(t);
    const projectNumber = Math.max(highest ?? 0, tableHighest) + 1;
    const projectCode = formatProjectCode(projectNumber);
    const updated = await tx
      .update(t)
      .set({ projectNumber, projectCode })
      .where(
        and(
          eq(t.formId, row.formId),
          eq(t.submissionId, row.submissionId),
          eq(t.claimToken, claimToken),
          replace ? isNotNull(t.projectCode) : isNull(t.projectCode)
        )
      )
      .returning({ submissionId: t.submissionId });
    if (!updated.length) throw new ClaimLostError();
    return { projectNumber, projectCode };
  });
}

// ── Processing ───────────────────────────────────────────────────────────────

interface ProcessingContext {
  api: ClientOnboardingNextcloud;
  formId: number;
  formHash: string;
  questions: IntakeQuestionMap;
  projectColumns: ProjectColumnMap;
  pipelineColumns: PipelineColumnMap;
  collectiveSlug: string;
  projectsPageId: number;
  /** Per-project Teams settings; null when the flag is off (the team steps do not run). */
  teams: ProjectTeamsSettings | null;
  /** Billing Customer step on; see billingCustomerStep. */
  billingCustomer: boolean;
  /** Address books listed once per cycle; see ContactDirectory. */
  contacts: ContactDirectory;
  logger: Logger;
}

type Outcome = "completed" | "retry" | "failed" | "lost";

const RETRYABLE_HTTP_STATUSES = new Set([401, 408, 423, 425, 429]);

function classify(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof OnboardingInvalidError) return { code: error.code, retryable: false };
  if (error instanceof LinksNotPersistedError) return { code: error.code, retryable: true };
  if (error instanceof ProjectCodeTakenError) return { code: error.code, retryable: true };
  if (error instanceof ContactChangedError) {
    return { code: "carddav.contact_changed", retryable: true };
  }
  if (error instanceof AddressbookDiscoveryError) {
    return { code: "carddav.discovery_failed", retryable: true };
  }
  if (error instanceof NextcloudHttpError) {
    return {
      code: `${error.label}:${error.status}`,
      retryable: error.status >= 500 || RETRYABLE_HTTP_STATUSES.has(error.status),
    };
  }
  if (error instanceof NextcloudRequestError) {
    return { code: `${error.label}:${error.kind}`, retryable: true };
  }
  if (error instanceof BillingCustomerStripeError) {
    return { code: error.code, retryable: error.retryable };
  }
  if (isBadResponseError(error)) return { code: `${error.label}:bad_response`, retryable: true };
  return { code: "internal_error", retryable: true };
}

function retryDelayMs(attempts: number): number {
  return Math.min(
    CLIENT_ONBOARDING_RETRY_BASE_MS * 2 ** Math.max(attempts - 1, 0),
    CLIENT_ONBOARDING_RETRY_MAX_MS
  );
}

/** Writes link cells, then reads the row back: Tables can answer 200 and store nothing. */
async function writeLinks(
  api: ClientOnboardingNextcloud,
  rowId: number,
  links: [columnId: number, title: string, url: string][],
  extra: Record<string, unknown> = {}
): Promise<void> {
  const data: Record<string, unknown> = { ...extra };
  for (const [columnId, title, url] of links) data[columnId] = linkValue(title, url);
  await api.updateRow(rowId, data);
  const stored = await api.getRow(rowId);
  for (const [columnId, , url] of links) {
    const storedUrl = linkCellUrl(stored?.cells.get(columnId));
    if (storedUrl === null || !storedUrl.includes(url)) throw new LinksNotPersistedError();
  }
}

async function folderStep(row: SubmissionRow, intake: Intake, ctx: ProcessingContext) {
  if (row.folderFileId !== null) return;
  const { api } = ctx;
  let folderName = row.folderName;
  if (folderName === null) {
    folderName = clientFolderName(intake.company, row.submissionId);
    await saveUnderClaim(row, { folderName });
  }
  // A returning client's folder is reused: MKCOL on an existing folder is accepted.
  await api.ensureClientFolder([folderName]);
  for (const sub of CLIENT_SUBFOLDERS) await api.ensureClientFolder([folderName, sub]);
  const fileId = await api.getClientFolderId([folderName]);
  await saveUnderClaim(row, { folderFileId: fileId });
  ctx.logger.info({ formId: ctx.formId, submissionId: row.submissionId }, "Client folder ready.");
}

async function contactStep(row: SubmissionRow, intake: Intake, ctx: ProcessingContext) {
  if (row.contactStatus !== null) return;
  const { api } = ctx;
  const ids = { formId: ctx.formId, submissionId: row.submissionId };
  const uid = clientContactUid(ctx.formId, row.submissionId);
  // A valid billing email is also written to the card as "Account email", which the contact ->
  // billing Customer sync (lib/contact-stripe-sync.ts) reads.
  const billing = intake.billingEmail?.trim();
  const accountEmail = billing && isValidEmail(billing) ? billing : undefined;
  const { own, matches } = await ctx.contacts.find(intake, uid);
  if (own) {
    // Created by an earlier attempt of this submission whose result was not saved.
    await saveUnderClaim(row, { contactStatus: "created", contactUid: uid });
    ctx.logger.info(
      { ...ids, addressbook: own.addressbook },
      "Client contact card already created."
    );
    return;
  }
  if (matches.length > 1) {
    await saveUnderClaim(row, { contactStatus: "ambiguous" });
    ctx.logger.warn(
      {
        ...ids,
        matches: matches.length,
        addressbooks: [...new Set(matches.map((m) => m.addressbook))],
      },
      "Several contact cards match the client; none was changed."
    );
    return;
  }
  if (matches.length === 1) {
    const [card] = matches;
    // Not our card: only add what is missing, never overwrite its name or company.
    const merged = mergeContactVCard(card.data, intake, new Date(), {
      additive: true,
      category: "Client",
      accountEmail,
    });
    const contactUid = vCardUid(card.data);
    try {
      if (card.readOnly) throw new NextcloudHttpError(403, "carddav.update_contact");
      if (merged !== null) {
        // Our own write, not a person's edit: if this card is synced to a billing Customer,
        // its next sighting must be a baseline so the change is not pushed. Reset before the
        // write (a sync cycle that reads the new content then sees the reset) and after it
        // (a cycle that read the old content cannot store a baseline over the new one). A
        // write that fails in between leaves the card to be re-baselined, never pushed.
        const synced = contactUid?.startsWith("dfwsc-client-") ? contactUid : null;
        if (synced) await resetCardBaseline(synced);
        await api.updateCard(card, merged);
        ctx.contacts.invalidate(card.addressbook);
        if (synced) await resetCardBaseline(synced);
      }
    } catch (error) {
      // A read-only shared book refuses the write. Creating a card elsewhere would
      // duplicate the client, so leave it for an operator and carry on.
      if (error instanceof NextcloudHttpError && error.status === 403) {
        await saveUnderClaim(row, { contactStatus: "read_only", contactUid });
        ctx.logger.warn(
          { ...ids, addressbook: card.addressbook },
          "Matched existing contact in a read-only address book; not modified."
        );
        return;
      }
      throw error;
    }
    await saveUnderClaim(row, { contactStatus: "updated", contactUid });
    ctx.logger.info(
      { ...ids, addressbook: card.addressbook, changed: merged !== null },
      "Client contact card updated."
    );
    return;
  }
  await api.createCard(uid, buildClientVCard(intake, uid, new Date(), accountEmail));
  ctx.contacts.invalidate(api.targets.addressbookPath);
  await saveUnderClaim(row, { contactStatus: "created", contactUid: uid });
  ctx.logger.info(
    { ...ids, addressbook: api.targets.addressbookPath },
    "Client contact card created."
  );
}

async function projectRowStep(
  row: SubmissionRow,
  intake: Intake,
  ownerUserId: string | null,
  ctx: ProcessingContext
) {
  if (row.tableRowId !== null) return;
  const { api, projectColumns: cols } = ctx;
  const ids = { formId: ctx.formId, submissionId: row.submissionId };
  const rows = await api.listRows(api.targets.projectsTableId);
  const codeOf = (r: TableRow) => r.cells.get(cols.projectCode.id);
  const tableHighest = Math.max(0, ...rows.map((r) => parseProjectNumber(codeOf(r)) ?? 0));

  if (row.projectCode === null) {
    Object.assign(row, await allocateProjectCode(row, tableHighest));
    ctx.logger.info({ ...ids, projectCode: row.projectCode }, "Client project code allocated.");
  }
  const code = row.projectCode as string;

  // A create whose response was lost left a row with our code: adopt it. A row
  // with our code but another project name was made by someone else.
  const existing = rows.filter((r) => String(codeOf(r) ?? "").trim() === code);
  let rowId: number;
  if (existing.length) {
    const ours = existing.filter(
      (r) =>
        normalizeName(String(r.cells.get(cols.projectName.id) ?? "")) ===
        normalizeName(intake.projectName)
    );
    if (ours.length > 1) throw new OnboardingInvalidError("project_code_taken");
    if (ours.length === 0) {
      // The code is burned (never reused). Take a fresh one above both the database
      // and the table, then retry; every collision uses an attempt, so repeated
      // collisions end in `failed` like any other retried error.
      Object.assign(row, await allocateProjectCode(row, tableHighest, true));
      ctx.logger.warn(
        { ...ids, projectCode: row.projectCode },
        "Client project code was taken in Tables; allocated a new one."
      );
      throw new ProjectCodeTakenError();
    }
    rowId = ours[0].id;
    ctx.logger.info({ ...ids, rowId }, "Client project row already existed; adopted it.");
  } else {
    rowId = await api.createRow(
      api.targets.projectsTableId,
      buildProjectRowData(intake, cols, code, ownerUserId)
    );
    ctx.logger.info({ ...ids, rowId, projectCode: code }, "Client project row created.");
  }
  await saveUnderClaim(row, { tableRowId: rowId });
}

/** An untouched page: empty, or only the page's own title as a heading. */
function isPageSeed(body: string, title: string, welcomeSeed = false): boolean {
  const text = body.trim();
  return text === "" || text === `# ${title.trim()}` || (welcomeSeed && isWelcomeText(text));
}

/**
 * The text Collectives puts on a new collective's landing page ("# Welcome <emoji> <name>"
 * followed by instructions to add pages and edit). Anything else is a human edit.
 */
function isWelcomeText(text: string): boolean {
  return /^#\s*Welcome\b/.test(text) && text.includes("Add pages with the");
}

/** Names used in the log lines of writeIntoSeedPage. */
interface SeedPageLabels {
  /** "Client project page": the page the log lines talk about. */
  page: string;
  /** "brief" or "hub": what is written into it. */
  content: string;
  /** A new collective's landing page still holding Collectives' default welcome text is a seed. */
  welcomeSeed?: boolean;
}

/**
 * Writes `content` into a page file, but never over a human edit: only into a seed
 * (empty, or just the page's own title heading) and only while it still has the ETag
 * we read. Every outcome is final for the step; the caller records it as done.
 */
async function writeIntoSeedPage(
  ctx: ProcessingContext,
  ids: { formId: number; submissionId: number },
  page: CollectivePage,
  content: string,
  labels: SeedPageLabels
): Promise<void> {
  const { api } = ctx;
  if (page.collectivePath && page.fileName) {
    const segments = [page.collectivePath, page.filePath, page.fileName]
      .flatMap((p) => p.split("/"))
      .filter(Boolean);
    const current = await api.getFile(segments);
    if (current === null) {
      ctx.logger.warn(
        { ...ids, pageId: page.id },
        `${labels.page} file not found; ${labels.content} skipped.`
      );
    } else if (!isPageSeed(current.body, page.title, labels.welcomeSeed)) {
      ctx.logger.info({ ...ids, pageId: page.id }, `${labels.page} already has content.`);
    } else {
      if (current.etag === null) {
        ctx.logger.warn(
          { ...ids, pageId: page.id },
          `${labels.page} has no ETag; writing unguarded.`
        );
      }
      const written = await api.putFile(segments, content, current.etag);
      if (written) {
        ctx.logger.info({ ...ids, pageId: page.id }, `Client project ${labels.content} written.`);
      } else {
        ctx.logger.warn(
          { ...ids, pageId: page.id },
          `${labels.page} changed meanwhile; ${labels.content} skipped.`
        );
      }
    }
  } else {
    // The collective is not mounted in the service account's files: the page stays
    // empty. Its row still links to it, so this is not worth failing the onboarding.
    ctx.logger.warn({ ...ids, pageId: page.id }, `${labels.page} content skipped.`);
  }
}

function briefFor(row: SubmissionRow, intake: Intake, ctx: ProcessingContext): string {
  const { api } = ctx;
  return projectBriefContent({
    projectCode: row.projectCode as string,
    summary: intake.summary,
    targetDate: intake.targetDate ? parseDate(intake.targetDate) : undefined,
    rowUrl: api.rowLink(api.targets.projectsTableId, row.tableRowId as number),
    folderUrl: api.folderLink(row.folderFileId as number),
    intakeTitle: `Intake submission #${row.submissionId}`,
    intakeUrl: api.intakeResultsLink(ctx.formHash),
  });
}

/** The manager hub: links to the team wiki, client folder, table row and team. */
async function hubFor(row: SubmissionRow, ctx: ProcessingContext): Promise<string> {
  const { api } = ctx;
  const wiki = (await api.listCollectives()).find((c) => c.id === row.collectiveId);
  if (!wiki) throw new NextcloudBadResponseError("collectives.list");
  return projectHubContent({
    projectCode: row.projectCode as string,
    wikiUrl: api.collectiveLink(wiki.slug ?? slugify(wiki.name), wiki.id),
    folderUrl: api.folderLink(row.folderFileId as number),
    rowUrl: api.rowLink(api.targets.projectsTableId, row.tableRowId as number),
    teamUrl: api.teamLink(row.teamId as string),
  });
}

async function pageStep(row: SubmissionRow, intake: Intake, ctx: ProcessingContext) {
  const { api } = ctx;
  const ids = { formId: ctx.formId, submissionId: row.submissionId };
  const code = row.projectCode as string;
  const title = projectPageTitle(code, intake.projectName, row.submissionId);

  if (row.pageId === null) {
    // The title starts with our own code, so a page with it under Projects is ours
    // (a create whose response was lost).
    const existing = (await api.listPages()).find(
      (p) => p.parentId === ctx.projectsPageId && p.title === title
    );
    const page = existing ?? (await api.createPage(ctx.projectsPageId, title));
    const pageUrl = api.pageLink(ctx.collectiveSlug, {
      id: page.id,
      slug: page.slug ?? slugify(page.title || title),
    });
    await saveUnderClaim(row, { pageId: page.id, pageUrl });
    ctx.logger.info(
      { ...ids, pageId: page.id, adopted: Boolean(existing) },
      "Client project page created."
    );
  }

  if (row.pageContentAt === null) {
    const page = await api.getPage(row.pageId as number);
    // Per-project Teams: the brief lives in the team's own wiki, so this page is a hub.
    const content = ctx.teams ? await hubFor(row, ctx) : briefFor(row, intake, ctx);
    await writeIntoSeedPage(ctx, ids, page, content, {
      page: "Client project page",
      content: ctx.teams ? "hub" : "brief",
    });
    await saveUnderClaim(row, { pageContentAt: new Date() });
  }
}

// ── Per-project Teams (CLIENT_ONBOARDING_PROJECT_TEAMS=true) ──────────────────

/** Emoji of the project collectives (Collectives needs one only for the sidebar). */
const PROJECT_WIKI_EMOJI = "📋";

function isClientError(error: unknown): boolean {
  return error instanceof NextcloudHttpError && error.status >= 400 && error.status < 500;
}

/** Nextcloud refused a team-related write; the operator has to change something. */
function refused(
  ctx: ProcessingContext,
  ids: { formId: number; submissionId: number },
  code: string,
  hint: string
): OnboardingInvalidError {
  ctx.logger.error({ ...ids, errorCode: code }, hint);
  return new OnboardingInvalidError(code);
}

/**
 * The project's Team: found by its exact name when the service account is its admin or
 * owner (a create whose response was lost), else created. Then the configured admins
 * are added and raised to level 8, and the submitter is added as a plain member. Members
 * already in the team are never added twice.
 */
async function teamStep(
  row: SubmissionRow,
  intake: Intake,
  submitter: string | null,
  ctx: ProcessingContext
) {
  const teams = ctx.teams;
  if (row.teamMembersAt !== null || !teams) return;
  const { api } = ctx;
  const ids = { formId: ctx.formId, submissionId: row.submissionId };

  if (row.teamId === null) {
    const name = projectTeamName(row.projectCode as string, intake.projectName, row.submissionId);
    const existing = (await api.listTeams()).find((t) => t.name === name);
    let teamId: string;
    if (existing) {
      if (existing.initiatorLevel < TEAM_LEVEL_ADMIN) {
        throw refused(
          ctx,
          ids,
          "team_name_taken",
          "A Team with this project's name exists but the service account is not its admin; fix or remove it."
        );
      }
      teamId = existing.id;
    } else {
      try {
        teamId = (await api.createTeam(name)).id;
      } catch (error) {
        if (error instanceof NextcloudHttpError && error.status === 403) {
          throw refused(
            ctx,
            ids,
            "circles.create_forbidden",
            "Nextcloud refused to create a Team for the service account; allow it to create Teams (Teams app settings), then retry the submission."
          );
        }
        throw error;
      }
    }
    await saveUnderClaim(row, { teamId });
    ctx.logger.info({ ...ids, adopted: Boolean(existing) }, "Client project team ready.");
  }

  const teamId = row.teamId as string;
  const members = await api.listTeamMembers(teamId);
  const byUser = new Map(members.filter((m) => m.userType === 1).map((m) => [m.userId, m]));
  // The service account owns the team it created, so it is never added again.
  const isOwner = (userId: string) => userId === api.serviceUsername;
  for (const userId of teams.admins) {
    if (isOwner(userId)) continue;
    let member = byUser.get(userId);
    if (!member) {
      try {
        member = await api.addTeamUser(teamId, userId);
      } catch (error) {
        if (isClientError(error)) {
          throw refused(
            ctx,
            ids,
            "team_admin_add_failed",
            "Nextcloud would not add a user from CLIENT_ONBOARDING_TEAM_ADMINS to the Team; check that every id names an existing, enabled user, then retry the submission."
          );
        }
        throw error;
      }
      byUser.set(userId, member);
    }
    if (member.level < TEAM_LEVEL_ADMIN) {
      await api.setTeamMemberLevel(teamId, member.id, TEAM_LEVEL_ADMIN);
    }
  }
  if (submitter && !isOwner(submitter) && !byUser.has(submitter)) {
    try {
      await api.addTeamUser(teamId, submitter);
    } catch (error) {
      // A deleted, disabled or unknown submitter must not block the onboarding.
      if (!isClientError(error)) throw error;
      ctx.logger.warn(
        { ...ids, status: (error as NextcloudHttpError).status },
        "Form submitter could not be added to the Team; continuing without."
      );
    }
  }
  await saveUnderClaim(row, { teamMembersAt: new Date() });
  ctx.logger.info({ ...ids, admins: teams.admins.length }, "Client project team members set.");
}

/**
 * The project's wiki: a collective with the team's name. Collectives builds it on the
 * existing team (the service account is its admin) rather than creating a second one;
 * the result is checked against the team id. The Project Brief goes on its landing page.
 */
async function projectWikiStep(row: SubmissionRow, intake: Intake, ctx: ProcessingContext) {
  if (row.collectiveContentAt !== null || !ctx.teams) return;
  const { api } = ctx;
  const ids = { formId: ctx.formId, submissionId: row.submissionId };

  if (row.collectiveId === null) {
    const teamName = projectTeamName(
      row.projectCode as string,
      intake.projectName,
      row.submissionId
    );
    // Reuse the collective already built on this team (a create whose response was lost).
    const existing = (await api.listCollectives()).find((c) =>
      c.circleId !== null ? c.circleId === row.teamId : c.name === teamName
    );
    const collective = existing ?? (await api.createCollective(teamName, PROJECT_WIKI_EMOJI));
    if (!existing && collective.circleId !== null && collective.circleId !== row.teamId) {
      // Record it first so a retry or an operator sees it instead of creating another.
      await saveUnderClaim(row, { collectiveId: collective.id });
      ctx.logger.error(
        { ...ids, collectiveId: collective.id },
        "Wiki collective is on another Team."
      );
      throw refused(
        ctx,
        ids,
        "collective_team_mismatch",
        "Collectives built the project wiki on another Team than the project's; fix it in Nextcloud."
      );
    }
    await saveUnderClaim(row, { collectiveId: collective.id });
    ctx.logger.info(
      { ...ids, collectiveId: collective.id, adopted: Boolean(existing) },
      "Client project wiki ready."
    );
  }

  const collectiveId = row.collectiveId as number;
  const landing = (await api.listPages(collectiveId)).find((p) => p.parentId === 0);
  if (!landing) throw new NextcloudBadResponseError("collectives.pages");
  await writeIntoSeedPage(ctx, ids, landing, briefFor(row, intake, ctx), {
    page: "Client project wiki page",
    content: "brief",
    welcomeSeed: true,
  });
  await saveUnderClaim(row, { collectiveContentAt: new Date() });
}

/** Shares the client folder with the team (read, update, create, delete; no reshare). */
async function folderShareStep(row: SubmissionRow, ctx: ProcessingContext) {
  if (row.folderShareId !== null || !ctx.teams) return;
  const { api } = ctx;
  const ids = { formId: ctx.formId, submissionId: row.submissionId };
  const teamId = row.teamId as string;
  const path = api.clientFolderSharePath([row.folderName as string]);
  const existing = (await api.listSharesOfPath(path)).find((s) => api.isTeamShare(s, teamId));
  let share = existing;
  if (!share) {
    try {
      share = await api.shareWithTeam(path, teamId);
    } catch (error) {
      if (error instanceof NextcloudHttpError && error.status === 403) {
        throw refused(
          ctx,
          ids,
          "files_sharing.create_forbidden",
          "Nextcloud refused to share the client folder with the Team: sharing with Teams may be disabled, or dfwsc-admin may lack share rights on the client folder. Check the server's sharing settings and the /clients share, then retry the submission."
        );
      }
      throw error;
    }
  }
  await saveUnderClaim(row, { folderShareId: share.id });
  ctx.logger.info(
    { ...ids, shareId: share.id, adopted: Boolean(existing) },
    "Client folder shared with the team."
  );
}

async function projectLinksStep(row: SubmissionRow, ctx: ProcessingContext) {
  if (row.linksBackfilledAt !== null) return;
  const { api, projectColumns: cols } = ctx;
  await writeLinks(api, row.tableRowId as number, [
    [cols.projectFolder.id, "Client folder", api.folderLink(row.folderFileId as number)],
    [cols.projectPage.id, `${row.projectCode} page`, row.pageUrl as string],
    [
      cols.intakeSubmission.id,
      `Intake submission #${row.submissionId}`,
      api.intakeResultsLink(ctx.formHash),
    ],
  ]);
  await saveUnderClaim(row, { linksBackfilledAt: new Date() });
}

async function findLeadRows(intake: Intake, ctx: ProcessingContext): Promise<TableRow[]> {
  const { api } = ctx;
  const pipelineTableId = api.targets.pipelineTableId;
  const ref = parseLeadReference(intake.leadLink, intake.company);
  if (ref.kind === "row") {
    if (ref.tableId !== null && ref.tableId !== pipelineTableId) return [];
    const found = await api.getRow(ref.rowId);
    return found && found.tableId === pipelineTableId ? [found] : [];
  }
  const wanted = normalizeName(ref.name);
  const companyColumn = ctx.pipelineColumns.company.id;
  return (await api.listRows(pipelineTableId)).filter(
    (r) => normalizeName(String(r.cells.get(companyColumn) ?? "")) === wanted
  );
}

async function leadStep(row: SubmissionRow, intake: Intake, ctx: ProcessingContext) {
  if (row.leadStatus !== null) return;
  const { api, pipelineColumns: cols } = ctx;
  const ids = { formId: ctx.formId, submissionId: row.submissionId };
  const candidates = await findLeadRows(intake, ctx);
  // No match, several, or a lead already linked to another project: flag it for an
  // operator and leave the pipeline alone. It is not a failure of the onboarding.
  if (candidates.length !== 1) {
    const leadStatus = candidates.length ? "ambiguous" : "no_match";
    await saveUnderClaim(row, { leadStatus });
    ctx.logger.warn(
      { ...ids, leadStatus, matches: candidates.length },
      "Sales Pipeline lead not updated; needs an operator."
    );
    return;
  }
  const [lead] = candidates;
  // Only a lead still in an open stage is promoted. Won is kept as is (its link is
  // still written); Lost, an empty stage or an unknown id is flagged and the row
  // is not touched at all.
  const stageId = stageOptionId(lead.cells.get(cols.stage.id));
  const alreadyWon = stageId === WON_STAGE_ID;
  if (!alreadyWon && (stageId === null || !PROMOTABLE_STAGE_IDS.has(stageId))) {
    await saveUnderClaim(row, { leadStatus: "ambiguous", leadRowId: lead.id });
    ctx.logger.warn(
      {
        ...ids,
        leadRowId: lead.id,
        leadStatus: "ambiguous",
        reason: "lead_stage_not_promotable",
        stageId,
      },
      "Sales Pipeline lead is not in an open stage; not changed."
    );
    return;
  }
  const projectUrl = api.rowLink(api.targets.projectsTableId, row.tableRowId as number);
  const linked = linkCellUrl(lead.cells.get(cols.clientProject.id));
  if (linked !== null && linked.trim() !== "" && !linked.includes(projectUrl)) {
    await saveUnderClaim(row, { leadStatus: "already_linked", leadRowId: lead.id });
    ctx.logger.warn(
      { ...ids, leadRowId: lead.id, leadStatus: "already_linked" },
      "Sales Pipeline lead already links another project; not changed."
    );
    return;
  }
  await writeLinks(
    api,
    lead.id,
    [[cols.clientProject.id, row.projectCode as string, projectUrl]],
    alreadyWon ? {} : { [cols.stage.id]: selectionValue(cols.stage, WON_STAGE) }
  );
  await saveUnderClaim(row, { leadStatus: "won", leadRowId: lead.id });
  ctx.logger.info({ ...ids, leadRowId: lead.id }, "Sales Pipeline lead set to Won.");
}

// 6. DFWSC's own Stripe Customer for billing development work. Not Stripe Connect: no
// clients row, no Express account. A Stripe failure fails the attempt (retried with
// backoff); the earlier steps are already saved and are skipped on the retry.
async function billingCustomerStep(row: SubmissionRow, intake: Intake, ctx: ProcessingContext) {
  if (!ctx.billingCustomer || row.billingStatus !== null) return;
  const ids = { formId: ctx.formId, submissionId: row.submissionId };
  const billing = intake.billingEmail?.trim();
  const contact = intake.email?.trim();
  if (billing && !isValidEmail(billing)) {
    ctx.logger.warn(
      { ...ids, reason: "billing_email_invalid" },
      "Billing email is not a valid address; using the contact email."
    );
  }
  const email =
    billing && isValidEmail(billing) ? billing : contact && isValidEmail(contact) ? contact : null;
  const noEmail = async (reason: string) => {
    await saveUnderClaim(row, { billingStatus: "no_email" });
    ctx.logger.warn(
      { ...ids, billingStatus: "no_email", reason },
      "No usable email on the submission; billing Customer not created. Needs an operator."
    );
  };
  if (!email) {
    await noEmail(contact ? "contact_email_invalid" : "missing_email");
    return;
  }
  const result = await ensureBillingCustomer({
    clientCode: row.projectCode as string,
    company: intake.company,
    email,
    submissionId: row.submissionId,
  });
  if (result.status === "invalid_email") {
    await noEmail("stripe_rejected_email");
    return;
  }
  if (result.status === "ambiguous") {
    await saveUnderClaim(row, { billingStatus: "ambiguous" });
    ctx.logger.warn(
      { ...ids, billingStatus: "ambiguous" },
      "Several Stripe Customers share the email; billing Customer not linked. Needs an operator."
    );
    return;
  }
  await saveUnderClaim(row, {
    billingStatus: "linked",
    billingCustomerId: result.stripeCustomerId,
  });
  ctx.logger.info({ ...ids, source: result.source }, "Billing Stripe Customer linked.");
}

async function runSteps(row: SubmissionRow, ctx: ProcessingContext): Promise<void> {
  const { api } = ctx;
  const submission = await api.getSubmission(row.submissionId);
  if (!submission) throw new OnboardingInvalidError("submission_not_found");
  const intake = extractIntake(submission.answers, ctx.questions);
  const owner = isNextcloudUser(submission.userId) ? submission.userId : null;

  await folderStep(row, intake, ctx); // 1
  await contactStep(row, intake, ctx); // 2
  await projectRowStep(row, intake, owner, ctx); // 3
  await teamStep(row, intake, owner, ctx); // 3b, flag only
  await projectWikiStep(row, intake, ctx); // 3c, flag only
  await folderShareStep(row, ctx); // 3d, flag only
  await pageStep(row, intake, ctx); // 4 (hub when the flag is on)
  await projectLinksStep(row, ctx); // 3, links (needs the page)
  await leadStep(row, intake, ctx); // 5
  await billingCustomerStep(row, intake, ctx); // 6, flag only

  await saveUnderClaim(row, {
    status: "completed",
    completedAt: new Date(),
    lastErrorCode: null,
    claimedAt: null,
    claimToken: null,
  });
}

async function processClaim(row: SubmissionRow, ctx: ProcessingContext): Promise<Outcome> {
  const ids = { formId: ctx.formId, submissionId: row.submissionId };
  const attemptsBefore = row.attempts;
  try {
    await runSteps(row, ctx);
    ctx.logger.info(ids, "Client onboarding processed.");
    return "completed";
  } catch (error) {
    if (error instanceof NextcloudCircuitOpenError) {
      await saveUnderClaim(row, { claimedAt: null, claimToken: null }).catch(() => undefined);
      throw error;
    }
    if (error instanceof ClaimLostError) {
      ctx.logger.warn(ids, "Client onboarding claim was taken over by another cycle.");
      return "lost";
    }
    const { code, retryable } = classify(error);
    const attempts = attemptsBefore + 1;
    const giveUp = !retryable || attempts >= CLIENT_ONBOARDING_MAX_ATTEMPTS;
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
        "Client onboarding failed; needs an operator."
      );
      return "failed";
    }
    ctx.logger.warn(
      { ...ids, errorCode: code, attempts },
      "Client onboarding step failed; will retry."
    );
    return "retry";
  }
}

async function buildContext(
  api: ClientOnboardingNextcloud,
  formId: number,
  teams: ProjectTeamsSettings | null,
  billingCustomer: boolean,
  logger: Logger
): Promise<ProcessingContext> {
  const form = await api.getForm();
  const collective = await api.getCollective();
  if (!collective) throw new OnboardingConfigError("collective_not_found");
  // "Projects" directly below the collective's landing page.
  const pages = await api.listPages();
  const roots = new Set(pages.filter((p) => p.parentId === 0).map((p) => p.id));
  const projects = pages.filter((p) => roots.has(p.parentId) && p.title.trim() === "Projects");
  if (projects.length !== 1) throw new OnboardingConfigError("projects_page_missing", ["Projects"]);
  return {
    api,
    formId,
    logger,
    formHash: form.hash,
    questions: resolveIntakeQuestions(form.questions),
    projectColumns: resolveProjectColumns(await api.getColumns(api.targets.projectsTableId)),
    pipelineColumns: resolvePipelineColumns(await api.getColumns(api.targets.pipelineTableId)),
    collectiveSlug: collective.slug ?? slugify(collective.name),
    projectsPageId: projects[0].id,
    teams,
    billingCustomer,
    contacts: api.contactDirectory((addressbook, status) =>
      logger.warn(
        { formId, addressbook, status },
        "Address book could not be read; skipped when looking for an existing contact."
      )
    ),
  };
}

interface CycleResult {
  status: CycleStatus;
  discovered: number;
  completed: number;
  retried: number;
  failed: number;
}

export async function runClientOnboardingCycle(options: {
  logger: Logger;
  env?: NodeJS.ProcessEnv;
}): Promise<CycleResult> {
  const { logger } = options;
  const result: CycleResult = { status: "ok", discovered: 0, completed: 0, retried: 0, failed: 0 };
  const config = loadClientOnboardingConfig(options.env);
  if (config.status === "disabled") return { ...result, status: "disabled" };
  if (config.status === "invalid") {
    logProblemOnce(
      logger,
      `invalid:${config.problems.join("|")}`,
      { problems: config.problems },
      "Client onboarding config is invalid; nothing processed."
    );
    return finish({ ...result, status: "invalid_config" });
  }

  const { formId } = config.settings;
  const api = new ClientOnboardingNextcloud(config.nextcloud, config.settings);
  let ctx: ProcessingContext | null = null;
  try {
    result.discovered = await discover(api, formId, logger);
    for (let i = 0; i < CLIENT_ONBOARDING_MAX_PER_CYCLE; i++) {
      const row = await claimNextOnboarding(formId);
      if (!row) break;
      if (!ctx) {
        try {
          ctx = await buildContext(
            api,
            formId,
            config.settings.teams,
            config.settings.billingCustomer,
            logger
          );
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
    if (error instanceof OnboardingConfigError) {
      logProblemOnce(
        logger,
        `config:${error.code}:${JSON.stringify(error.detail)}`,
        { errorCode: error.code, names: error.detail },
        "Client onboarding form, tables or collective do not match what is expected; nothing processed."
      );
      return finish({ ...result, status: "config_error" });
    }
    if (error instanceof NextcloudCircuitOpenError) {
      logger.warn({ formId }, "Nextcloud circuit is open; client onboarding cycle skipped.");
      return finish({ ...result, status: "nextcloud_unavailable" });
    }
    const { code, retryable } = classify(error);
    if (!retryable) {
      logProblemOnce(
        logger,
        `http:${code}`,
        { formId, errorCode: code },
        "Nextcloud refused a client onboarding request; check the shares and ids."
      );
      return finish({ ...result, status: "config_error" });
    }
    if (code === "internal_error") {
      logger.error(
        { formId, errorName: (error as Error)?.name },
        "Client onboarding cycle failed."
      );
      return finish({ ...result, status: "error" });
    }
    logger.warn({ formId, errorCode: code }, "Client onboarding cycle could not reach Nextcloud.");
    return finish({ ...result, status: "nextcloud_unavailable" });
  }
  lastLoggedProblem = null;
  if (result.discovered || result.completed || result.retried || result.failed) {
    logger.info({ formId, ...result }, "Client onboarding cycle finished.");
  }
  return finish(result);
}

function finish(result: CycleResult): CycleResult {
  stats.lastCycleAt = new Date();
  stats.lastCycleStatus = result.status;
  return result;
}

// ── Runner: poller + webhook trigger ─────────────────────────────────────────

export interface ClientOnboardingRunner {
  /** Asks for a cycle now. One runs at a time; a request during a cycle queues one more. */
  trigger(): void;
  /** Stops the timer and waits for a running cycle to finish. */
  stop(): Promise<void>;
}

interface ActiveRunner {
  runner: ClientOnboardingRunner;
  webhookSecret: string | null;
}

let active: ActiveRunner | null = null;

/** The running automation's webhook secret and trigger; null when the webhook is off. */
export function getClientOnboardingWebhook(): {
  secret: string;
  trigger: () => void;
} | null {
  if (!active?.webhookSecret) return null;
  return { secret: active.webhookSecret, trigger: active.runner.trigger };
}

/**
 * Starts the poller when CLIENT_ONBOARDING_ENABLED=true and the config is valid;
 * otherwise logs why (once) and returns null. Never throws: the payment API must
 * start regardless.
 */
export function startClientOnboarding(
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env
): ClientOnboardingRunner | null {
  const config = loadClientOnboardingConfig(env);
  if (config.status === "disabled") return null;
  if (config.status === "invalid") {
    logger.error(
      { problems: config.problems },
      "Client onboarding is enabled but its config is invalid; not started."
    );
    return null;
  }

  let running: Promise<unknown> | null = null;
  let again = false;
  let stopped = false;
  const run = () => {
    running = runClientOnboardingCycle({ logger, env })
      .catch((error: unknown) => {
        logger.error({ errorName: (error as Error)?.name }, "Client onboarding cycle crashed.");
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

  const runner: ClientOnboardingRunner = {
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
    },
    "Client onboarding started."
  );
  return runner;
}
