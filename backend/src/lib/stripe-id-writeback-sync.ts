import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { billingCustomers, clientOnboardingSubmissions, stripeIdWritebacks } from "../db/schema";
import {
  AuthBackoff,
  intVar,
  isAuthError,
  isOutage,
  type MirrorLogger,
  withMirrorLock,
} from "./mirror-table";
import { getNextcloudConfig, NextcloudHttpError, nextcloudRequest } from "./nextcloud";
import {
  AddressbookDiscoveryError,
  ContactChangedError,
  createContactDirectory,
  type StoredCard,
  updateCard,
} from "./nextcloud-contacts";
import { type MirrorRow, PortalMirrorNextcloud } from "./portal-mirror-nextcloud";
import type { TableColumn } from "./sales-lead-mapping";
import {
  buildDesiredState,
  type DesiredCard,
  type DesiredRow,
  mergeStripeIdIntoVCard,
  STRIPE_ID_COLUMN_TITLE,
} from "./stripe-id-writeback-render";

// "Stripe ID write-back": when a DFWSC billing client is linked to a Stripe Customer
// (billing_customers.stripe_customer_id), writes that id onto the client's own Nextcloud
// records so it can be looked up by it: the raw `cus_...` id in the "Stripe Customer ID" column
// of the client's Client Projects row, and a labelled Stripe Dashboard URL on the contact card.
// Off unless STRIPE_ID_WRITEBACK=true. The database wins: billing_customers is the source of
// truth and a hand edit of either record is reverted by the daily verify pass.
//
// An idempotent reconciler, not an onboarding step. Every cycle derives the desired state from
// billing_customers joined to the onboarding submissions and touches Nextcloud only where its
// hash differs from the last confirmed write (stripe_id_writebacks), plus once a day a verify
// pass that re-reads the table and the cards to repair edits and deletions. The card URL is not
// a field the contact -> Stripe sync maps, so a write-back never echoes into Stripe.
//
// Logs carry ids, codes, counts and statuses only: never emails, names or DAV paths.

const CYCLE_LOCK_NAME = "stripe_id_writeback_cycle";
const DEFAULT_INTERVAL_MS = 300_000;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
const VERIFY_EVERY_MS = 24 * 60 * 60 * 1000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60 * 1000;
const PROJECT_CODE_TITLE = "Project Code";

type Target = "project_row" | "contact_card";
type Status = "ok" | "not_found" | "ambiguous" | "read_only" | "forbidden" | "error";

interface WritebackSettings {
  nextcloud: NonNullable<ReturnType<typeof getNextcloudConfig> & { ok: true }>["config"];
  projectsTableId: number;
  addressbook: string;
  intervalMs: number;
  dryRun: boolean;
  minGapMs: number;
}

type ConfigResult =
  | { status: "disabled" }
  | { status: "invalid"; problems: string[] }
  | { status: "ready"; settings: WritebackSettings; warnings: string[] };

/** Fails safe: anything that is not clearly "live" is a dry run, and unknown values are flagged. */
function parseDryRun(raw: string | undefined, warnings: string[]): boolean {
  const value = raw?.trim().toLowerCase() ?? "";
  if (["true", "1", "yes"].includes(value)) return true;
  if (["", "false", "0", "no"].includes(value)) return false;
  warnings.push(
    "STRIPE_ID_WRITEBACK_DRY_RUN is not a recognised value (use true or false); running as a dry run"
  );
  return true;
}

export function loadStripeIdWritebackConfig(env: NodeJS.ProcessEnv): ConfigResult {
  if (env.STRIPE_ID_WRITEBACK?.trim() !== "true") return { status: "disabled" };
  const problems: string[] = [];
  const warnings: string[] = [];
  const nc = getNextcloudConfig(env);
  if (!nc.ok) {
    problems.push(
      nc.reason === "not_configured"
        ? "NEXTCLOUD_BASE_URL, NEXTCLOUD_USERNAME and NEXTCLOUD_APP_PASSWORD are required"
        : "NEXTCLOUD_BASE_URL must be a valid https:// URL"
    );
  }
  const tableText = env.CLIENT_ONBOARDING_PROJECTS_TABLE_ID?.trim() ?? "";
  const projectsTableId = /^\d+$/.test(tableText) ? Number(tableText) : 0;
  if (!Number.isSafeInteger(projectsTableId) || projectsTableId <= 0) {
    problems.push("CLIENT_ONBOARDING_PROJECTS_TABLE_ID must be a positive integer");
  }
  const addressbook = env.CLIENT_ONBOARDING_ADDRESSBOOK_PATH?.trim() ?? "";
  if (!addressbook || addressbook.includes("/") || /^\.+$/.test(addressbook)) {
    problems.push("CLIENT_ONBOARDING_ADDRESSBOOK_PATH must be one address book collection name");
  }
  const intervalMs = intVar(
    env.STRIPE_ID_WRITEBACK_INTERVAL_MS,
    "STRIPE_ID_WRITEBACK_INTERVAL_MS",
    MIN_INTERVAL_MS,
    MAX_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
    problems
  );
  const dryRun = parseDryRun(env.STRIPE_ID_WRITEBACK_DRY_RUN, warnings);
  if (!nc.ok || problems.length) return { status: "invalid", problems };
  return {
    status: "ready",
    settings: {
      nextcloud: nc.config,
      projectsTableId,
      addressbook,
      intervalMs,
      dryRun,
      minGapMs: 200,
    },
    warnings,
  };
}

// ── State ────────────────────────────────────────────────────────────────────

export interface StripeIdWritebackResult {
  status:
    | "disabled"
    | "invalid_config"
    | "nextcloud_unavailable"
    | "busy"
    | "backoff"
    | "error"
    | "ok";
  /** Nextcloud records changed (rows and cards). */
  written: number;
  /** Records checked and already correct. */
  unchanged: number;
  /** Dry run only: writes that would have been made. */
  planned: number;
  /** Records left in a non-ok status. */
  failed: number;
  verified: boolean;
}

const result = (
  status: StripeIdWritebackResult["status"],
  extra: Partial<StripeIdWritebackResult> = {}
): StripeIdWritebackResult => ({
  status,
  written: 0,
  unchanged: 0,
  planned: 0,
  failed: 0,
  verified: false,
  ...extra,
});

const stats: {
  lastCycleAt: Date | null;
  lastCycleStatus: StripeIdWritebackResult["status"] | null;
} = { lastCycleAt: null, lastCycleStatus: null };

export function getStripeIdWritebackStats() {
  return { ...stats };
}

let lastVerifyAt = 0;
let lastLoggedProblem: string | null = null;
const loggedWarnings = new Set<string>();
let columnCreateAttempted = false;
let activeTrigger: (() => void) | null = null;
const authBackoff = new AuthBackoff();

export function resetStripeIdWritebackStateForTests() {
  lastVerifyAt = 0;
  lastLoggedProblem = null;
  loggedWarnings.clear();
  columnCreateAttempted = false;
  stats.lastCycleAt = null;
  stats.lastCycleStatus = null;
  authBackoff.reset();
}

/** Asks the running reconciler for a cycle now; a no-op when the flag is off. */
export function triggerStripeIdWriteback(): void {
  activeTrigger?.();
}

function logProblemOnce(
  logger: MirrorLogger,
  key: string,
  fields: Record<string, unknown>,
  msg: string
) {
  if (lastLoggedProblem === key) return;
  lastLoggedProblem = key;
  logger.error(fields, msg);
}

class NotPersistedError extends Error {
  constructor() {
    super("The Stripe Customer ID cell was not stored");
    this.name = "NotPersistedError";
  }
}

// ── Stored state ─────────────────────────────────────────────────────────────

type StateRow = typeof stripeIdWritebacks.$inferSelect;
const stateKey = (target: Target, key: string) => `${target}:${key}`;

interface Outcome {
  status: Status;
  lastError?: string | null;
  ncRowId?: number | null;
  addressbook?: string | null;
  cardHref?: string | null;
  /** The write happened now (as opposed to the record already being correct). */
  wrote?: boolean;
  /** Retry at the next cycle instead of backing off. */
  retryNow?: boolean;
}

const retryDelayMs = (attempts: number) =>
  Math.min(RETRY_BASE_MS * 2 ** Math.min(attempts, 20), RETRY_MAX_MS);

async function record(
  target: Target,
  key: string,
  hash: string,
  previous: StateRow | undefined,
  outcome: Outcome,
  now: Date
): Promise<void> {
  const ok = outcome.status === "ok";
  const attempts = ok ? 0 : (previous?.attempts ?? 0) + 1;
  const base = {
    ncRowId: outcome.ncRowId === undefined ? (previous?.ncRowId ?? null) : outcome.ncRowId,
    addressbook:
      outcome.addressbook === undefined ? (previous?.addressbook ?? null) : outcome.addressbook,
    cardHref: outcome.cardHref === undefined ? (previous?.cardHref ?? null) : outcome.cardHref,
    desiredHash: hash,
    writtenHash: ok ? hash : (previous?.writtenHash ?? null),
    writtenAt: outcome.wrote ? now : (previous?.writtenAt ?? null),
    verifiedAt: ok ? now : (previous?.verifiedAt ?? null),
    status: outcome.status,
    attempts,
    nextAttemptAt: ok
      ? null
      : outcome.retryNow
        ? now
        : new Date(now.getTime() + retryDelayMs(attempts - 1)),
    lastError: ok ? null : (outcome.lastError ?? outcome.status),
  };
  await db
    .insert(stripeIdWritebacks)
    .values({ target, targetKey: key, ...base })
    .onConflictDoUpdate({
      target: [stripeIdWritebacks.target, stripeIdWritebacks.targetKey],
      set: { ...base, updatedAt: now },
    });
}

/** Whether a record needs a look this cycle: a changed or unconfirmed desired state, or verify. */
function isDue(state: StateRow | undefined, hash: string, verifyDue: boolean, now: Date): boolean {
  if (!state) return true;
  const changed = state.desiredHash !== hash;
  if (!changed && state.nextAttemptAt && state.nextAttemptAt.getTime() > now.getTime()) {
    return false;
  }
  return verifyDue || changed || state.writtenHash !== hash || state.status !== "ok";
}

// ── Desired state ────────────────────────────────────────────────────────────

async function loadDesired(logger: MirrorLogger) {
  const links = await db
    .select({
      clientCode: billingCustomers.clientCode,
      stripeCustomerId: billingCustomers.stripeCustomerId,
      email: billingCustomers.email,
    })
    .from(billingCustomers);
  const s = clientOnboardingSubmissions;
  const submissions = await db
    .select({
      projectCode: s.projectCode,
      tableRowId: s.tableRowId,
      contactUid: s.contactUid,
      contactStatus: s.contactStatus,
    })
    .from(s)
    .where(sql`${s.projectCode} IS NOT NULL`);
  return buildDesiredState(links, submissions, (clientCode) => {
    logger.warn(
      { clientCode },
      "Stripe ID write-back skipped a client with a malformed Stripe id."
    );
  });
}

// ── Client Projects rows ─────────────────────────────────────────────────────

const cellText = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value).trim() : "";

function locateRow(
  desired: DesiredRow,
  state: StateRow | undefined,
  rows: MirrorRow[],
  codeColumnId: number
): { row: MirrorRow | null; ambiguous: boolean } {
  const codeOf = (r: MirrorRow) => cellText(r.cells.get(codeColumnId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of [state?.ncRowId, desired.tableRowId]) {
    const row = id == null ? undefined : byId.get(id);
    if (row && codeOf(row) === desired.clientCode) return { row, ambiguous: false };
  }
  const matches = rows.filter((r) => codeOf(r) === desired.clientCode);
  if (matches.length > 1) return { row: null, ambiguous: true };
  return { row: matches[0] ?? null, ambiguous: false };
}

interface Counters {
  written: number;
  unchanged: number;
  planned: number;
  failed: number;
}

/** Finds the "Stripe Customer ID" column, creating it once when absent. */
async function resolveIdColumn(
  nc: PortalMirrorNextcloud,
  settings: WritebackSettings,
  columns: TableColumn[],
  logger: MirrorLogger
): Promise<{ column: TableColumn | null; reason: string | null }> {
  const found = columns.find((c) => c.title.trim() === STRIPE_ID_COLUMN_TITLE);
  if (found) {
    if (found.type !== "text" || (found.subtype && found.subtype !== "line")) {
      logProblemOnce(
        logger,
        "column_type",
        { column: STRIPE_ID_COLUMN_TITLE },
        "The Stripe Customer ID column is not a single-line text column; project rows are not written."
      );
      return { column: null, reason: "column_type" };
    }
    return { column: found, reason: null };
  }
  if (settings.dryRun) {
    logger.info(
      { tableId: settings.projectsTableId, column: STRIPE_ID_COLUMN_TITLE },
      "Stripe ID write-back (dry run): would create the missing column."
    );
    return { column: null, reason: "column_missing" };
  }
  if (columnCreateAttempted) return { column: null, reason: "column_missing" };
  try {
    const id = await nc.createColumn(settings.projectsTableId, {
      key: "stripeCustomerId",
      title: STRIPE_ID_COLUMN_TITLE,
      type: "text",
    });
    columnCreateAttempted = true;
    logger.info(
      { tableId: settings.projectsTableId, columnId: id },
      "Stripe Customer ID column created."
    );
    return {
      column: { id, title: STRIPE_ID_COLUMN_TITLE, type: "text", subtype: "line" },
      reason: null,
    };
  } catch (error) {
    if (!(error instanceof NextcloudHttpError) || error.status !== 403) throw error;
    columnCreateAttempted = true;
    logger.error(
      { tableId: settings.projectsTableId, column: STRIPE_ID_COLUMN_TITLE },
      'The service account may not add columns to the Client Projects table. Add a single-line text column titled exactly "Stripe Customer ID" to it by hand; project rows are written once it exists. Contact cards are written regardless.'
    );
    return { column: null, reason: "column_missing" };
  }
}

async function syncProjectRows(
  nc: PortalMirrorNextcloud,
  settings: WritebackSettings,
  desired: Map<string, DesiredRow>,
  states: Map<string, StateRow>,
  verifyDue: boolean,
  now: Date,
  logger: MirrorLogger,
  out: Counters
): Promise<void> {
  const due = [...desired.values()].filter((d) =>
    isDue(states.get(stateKey("project_row", d.clientCode)), d.hash, verifyDue, now)
  );
  if (!due.length) return;
  const fail = async (
    d: DesiredRow,
    status: Status,
    lastError: string,
    ncRowId?: number | null,
    retryNow = false
  ) => {
    out.failed += 1;
    if (!settings.dryRun) {
      await record(
        "project_row",
        d.clientCode,
        d.hash,
        states.get(stateKey("project_row", d.clientCode)),
        { status, lastError, ncRowId, retryNow },
        now
      );
    }
  };

  const columns = await nc.getColumns(settings.projectsTableId);
  const codeColumn = columns.find((c) => c.title.trim() === PROJECT_CODE_TITLE);
  if (!codeColumn) {
    logProblemOnce(
      logger,
      "project_code_column",
      { column: PROJECT_CODE_TITLE },
      "The Client Projects table has no Project Code column; project rows are not written."
    );
    for (const d of due) await fail(d, "error", "project_code_column_missing", undefined, true);
    return;
  }
  const { column, reason } = await resolveIdColumn(nc, settings, columns, logger);
  if (!column) {
    // A column added by hand is picked up on the next cycle, not after a backoff.
    for (const d of due) await fail(d, "forbidden", reason ?? "column_missing", undefined, true);
    return;
  }
  const rows = await nc.listRows(settings.projectsTableId);

  for (const d of due) {
    const state = states.get(stateKey("project_row", d.clientCode));
    const { row, ambiguous } = locateRow(d, state, rows, codeColumn.id);
    if (ambiguous) {
      logger.warn(
        { clientCode: d.clientCode },
        "Several Client Projects rows share the project code; not written."
      );
      await fail(d, "ambiguous", "ambiguous", null);
      continue;
    }
    if (!row) {
      await fail(d, "not_found", "row_not_found", null);
      continue;
    }
    if (cellText(row.cells.get(column.id)) === d.customerId) {
      out.unchanged += 1;
      if (!settings.dryRun) {
        await record(
          "project_row",
          d.clientCode,
          d.hash,
          state,
          { status: "ok", ncRowId: row.id },
          now
        );
      }
      continue;
    }
    if (settings.dryRun) {
      out.planned += 1;
      logger.info(
        {
          target: "project_row",
          clientCode: d.clientCode,
          stripeCustomerId: d.customerId,
          rowId: row.id,
        },
        "Stripe ID write-back (dry run): would write the Customer id to the project row."
      );
      continue;
    }
    try {
      await nc.updateRow(row.id, { [column.id]: d.customerId });
      // Tables can answer 200 and store nothing: read the cell back.
      const stored = await nc.getRow(row.id);
      if (!stored || cellText(stored.cells.get(column.id)) !== d.customerId) {
        throw new NotPersistedError();
      }
      out.written += 1;
      await record(
        "project_row",
        d.clientCode,
        d.hash,
        state,
        { status: "ok", ncRowId: row.id, wrote: true },
        now
      );
      logger.info(
        {
          target: "project_row",
          clientCode: d.clientCode,
          stripeCustomerId: d.customerId,
          rowId: row.id,
        },
        "Stripe Customer id written to the project row."
      );
    } catch (error) {
      if (error instanceof NextcloudHttpError && error.status === 404) {
        await fail(d, "not_found", "row_not_found", null);
      } else if (error instanceof NextcloudHttpError && error.status === 403) {
        await fail(d, "forbidden", "http_403");
      } else if (error instanceof NotPersistedError) {
        await fail(d, "error", "not_persisted");
      } else if (isOutage(error)) {
        throw error;
      } else {
        logger.warn(
          { clientCode: d.clientCode, errorName: (error as Error)?.name },
          "Stripe ID write-back could not write a project row; will retry with backoff."
        );
        await fail(d, "error", (error as Error)?.name ?? "error");
      }
    }
  }
}

// ── Contact cards ────────────────────────────────────────────────────────────

async function syncContactCards(
  settings: WritebackSettings,
  desired: Map<string, DesiredCard>,
  states: Map<string, StateRow>,
  verifyDue: boolean,
  now: Date,
  logger: MirrorLogger,
  out: Counters
): Promise<void> {
  const isEntryDue = (entry: DesiredCard) =>
    isDue(states.get(stateKey("contact_card", entry.key)), entry.hash, verifyDue, now);
  if (![...desired.values()].some(isEntryDue)) return;

  const directory = createContactDirectory(
    settings.nextcloud,
    settings.addressbook,
    (_book, status) => {
      logger.warn({ status }, "Stripe ID write-back skipped an address book it cannot read.");
    }
  );
  type Resolved = {
    entry: DesiredCard;
    /** Not due entries are resolved only so a shared card gets the union of ids. */
    due: boolean;
    card: StoredCard | null;
    status: Status | null;
    error: string;
  };
  const resolved: Resolved[] = [];
  for (const entry of desired.values()) {
    const previous = states.get(stateKey("contact_card", entry.key));
    const due = isEntryDue(entry);
    try {
      if (entry.uid) {
        const card = await directory.findByUid(entry.uid);
        resolved.push(
          card
            ? { entry, due, card, status: null, error: "" }
            : { entry, due, card: null, status: "not_found", error: "card_not_found" }
        );
      } else if (entry.email) {
        const matches = await directory.findByEmail(entry.email);
        if (matches.length === 1)
          resolved.push({ entry, due, card: matches[0], status: null, error: "" });
        else if (matches.length === 0)
          resolved.push({ entry, due, card: null, status: "not_found", error: "no_email_match" });
        else
          resolved.push({
            entry,
            due,
            card: null,
            status: "ambiguous",
            error: "email_matches_several",
          });
      } else {
        resolved.push({ entry, due, card: null, status: "not_found", error: "no_lookup_key" });
      }
    } catch (error) {
      if (!(error instanceof AddressbookDiscoveryError)) throw error;
      if (previous === undefined)
        logger.warn(
          { cardKey: entry.key },
          "Stripe ID write-back could not search the address books."
        );
      resolved.push({ entry, due, card: null, status: "error", error: "addressbook_discovery" });
    }
  }

  const fail = async (r: Resolved, status: Status, lastError: string, retryNow = false) => {
    out.failed += 1;
    if (!settings.dryRun) {
      await record(
        "contact_card",
        r.entry.key,
        r.entry.hash,
        states.get(stateKey("contact_card", r.entry.key)),
        { status, lastError, retryNow },
        now
      );
    }
  };

  // Cards reached by several entries (shared UID is one entry already; an email match can land on
  // a card another entry reaches by UID) get the union of their ids, written once.
  const byHref = new Map<string, { card: StoredCard; ids: Set<string>; members: Resolved[] }>();
  for (const r of resolved) {
    if (!r.card) {
      if (r.due) await fail(r, r.status as Status, r.error);
      continue;
    }
    const group = byHref.get(r.card.href) ?? { card: r.card, ids: new Set<string>(), members: [] };
    for (const id of r.entry.customerIds) group.ids.add(id);
    group.members.push(r);
    byHref.set(r.card.href, group);
  }

  for (const { card, ids, members: all } of byHref.values()) {
    const members = all.filter((m) => m.due);
    if (members.length === 0) continue;
    const customerIds = [...ids].sort();
    const codes = all.flatMap((m) => m.entry.codes);
    const where = { addressbook: card.addressbook, cardHref: card.href };
    const mark = async (outcome: Outcome) => {
      for (const m of members) {
        const previous = states.get(stateKey("contact_card", m.entry.key));
        if (outcome.status !== "ok") out.failed += 1;
        if (!settings.dryRun) {
          await record(
            "contact_card",
            m.entry.key,
            m.entry.hash,
            previous,
            { ...where, ...outcome },
            now
          );
        }
      }
    };
    if (card.readOnly) {
      logger.warn(
        { clientCodes: codes },
        "The contact card is in a read-only address book; Stripe id not written."
      );
      await mark({ status: "read_only", lastError: "read_only" });
      continue;
    }
    if (customerIds.length > 1) {
      logger.warn(
        { clientCodes: codes, stripeCustomerIds: customerIds },
        "One contact card is linked to several Stripe Customers; writing one URL entry for each."
      );
    }
    const merged = mergeStripeIdIntoVCard(card.data, customerIds, now);
    if (merged === null) {
      out.unchanged += members.length;
      await mark({ status: "ok" });
      continue;
    }
    if (settings.dryRun) {
      out.planned += members.length;
      logger.info(
        { target: "contact_card", clientCodes: codes, stripeCustomerIds: customerIds },
        "Stripe ID write-back (dry run): would write the Customer link to the contact card."
      );
      continue;
    }
    try {
      await updateCard(settings.nextcloud, card, merged);
      directory.invalidate(card.addressbook);
      out.written += members.length;
      await mark({ status: "ok", wrote: true });
      logger.info(
        { target: "contact_card", clientCodes: codes, stripeCustomerIds: customerIds },
        "Stripe Customer link written to the contact card."
      );
    } catch (error) {
      if (error instanceof ContactChangedError) {
        // Edited since we read it: re-read and retry next cycle.
        await mark({ status: "error", lastError: "card_changed", retryNow: true });
      } else if (error instanceof NextcloudHttpError && error.status === 403) {
        await mark({ status: "read_only", lastError: "http_403" });
      } else if (error instanceof NextcloudHttpError && error.status === 404) {
        await mark({ status: "not_found", lastError: "card_not_found" });
      } else if (isOutage(error)) {
        throw error;
      } else {
        logger.warn(
          { clientCodes: codes, errorName: (error as Error)?.name },
          "Stripe ID write-back could not write a contact card; will retry with backoff."
        );
        await mark({ status: "error", lastError: (error as Error)?.name ?? "error" });
      }
    }
  }
}

// ── Cycle ────────────────────────────────────────────────────────────────────

async function syncOnce(
  settings: WritebackSettings,
  logger: MirrorLogger,
  cycleStart: Date
): Promise<StripeIdWritebackResult> {
  const out = result("ok");
  const desired = await loadDesired(logger);
  const states = new Map(
    (await db.select().from(stripeIdWritebacks)).map((r) => [stateKey(r.target, r.targetKey), r])
  );

  // A link that no longer exists: forget the bookkeeping; Nextcloud is left as it is.
  if (!settings.dryRun) {
    for (const row of states.values()) {
      const live =
        row.target === "project_row"
          ? desired.rows.has(row.targetKey)
          : desired.cards.has(row.targetKey);
      if (live) continue;
      await db
        .delete(stripeIdWritebacks)
        .where(
          and(
            eq(stripeIdWritebacks.target, row.target),
            eq(stripeIdWritebacks.targetKey, row.targetKey)
          )
        );
    }
  }

  const verifyDue = Date.now() - lastVerifyAt >= VERIFY_EVERY_MS;
  const nc = new PortalMirrorNextcloud(settings.nextcloud, settings.minGapMs, nextcloudRequest);
  await syncProjectRows(nc, settings, desired.rows, states, verifyDue, cycleStart, logger, out);
  await syncContactCards(settings, desired.cards, states, verifyDue, cycleStart, logger, out);
  if (verifyDue) {
    lastVerifyAt = Date.now();
    out.verified = true;
  }

  if (out.written || out.planned || out.failed || out.verified) {
    logger.info(
      {
        written: out.written,
        unchanged: out.unchanged,
        planned: out.planned,
        failed: out.failed,
        verified: out.verified,
        dryRun: settings.dryRun,
      },
      "Stripe ID write-back cycle finished."
    );
  }
  return out;
}

export async function runStripeIdWritebackCycle(options: {
  logger: MirrorLogger;
  env?: NodeJS.ProcessEnv;
  /** Tests only: overrides the 200 ms spacing between Tables calls. */
  minGapMs?: number;
}): Promise<StripeIdWritebackResult> {
  const { logger, env = process.env } = options;
  const config = loadStripeIdWritebackConfig(env);
  if (config.status === "disabled") return result("disabled");
  const finish = (r: StripeIdWritebackResult) => {
    stats.lastCycleAt = new Date();
    stats.lastCycleStatus = r.status;
    return r;
  };
  if (config.status === "invalid") {
    logProblemOnce(
      logger,
      `invalid:${config.problems.join("|")}`,
      { problems: config.problems },
      "Stripe ID write-back is enabled but its config is invalid; skipped."
    );
    return finish(result("invalid_config"));
  }
  for (const warning of config.warnings) {
    if (!loggedWarnings.has(warning)) {
      loggedWarnings.add(warning);
      logger.warn({ warning }, "Stripe ID write-back config warning.");
    }
  }
  if (options.minGapMs !== undefined) config.settings.minGapMs = options.minGapMs;
  if (Date.now() < authBackoff.until) return result("backoff");
  try {
    const outcome = await withMirrorLock(CYCLE_LOCK_NAME, logger, result("busy"), (started) =>
      syncOnce(config.settings, logger, started)
    );
    if (outcome.status === "ok") {
      lastLoggedProblem = null;
      authBackoff.succeeded();
    }
    return outcome.status === "busy" ? outcome : finish(outcome);
  } catch (error) {
    if (isOutage(error)) {
      if (isAuthError(error)) authBackoff.failed(config.settings.intervalMs);
      logger.warn(
        { errorName: (error as Error).name },
        "Stripe ID write-back: Nextcloud unavailable."
      );
      return finish(result("nextcloud_unavailable"));
    }
    logger.error({ errorName: (error as Error)?.name }, "Stripe ID write-back cycle failed.");
    return finish(result("error"));
  }
}

export interface StripeIdWritebackRunner {
  trigger(): void;
  stop(): Promise<void>;
}

/** Starts the loop, or returns null when the flag is off or the config invalid. Never throws. */
export function startStripeIdWriteback(
  logger: MirrorLogger,
  env: NodeJS.ProcessEnv = process.env
): StripeIdWritebackRunner | null {
  const config = loadStripeIdWritebackConfig(env);
  if (config.status === "disabled") return null;
  if (config.status === "invalid") {
    logger.error(
      { problems: config.problems },
      "Stripe ID write-back is enabled but its config is invalid; not started."
    );
    return null;
  }

  let running: Promise<unknown> | null = null;
  let again = false;
  let stopped = false;
  const run = () => {
    again = false;
    running = runStripeIdWritebackCycle({ logger, env })
      .catch((error: unknown) => {
        logger.error({ errorName: (error as Error)?.name }, "Stripe ID write-back cycle crashed.");
      })
      .finally(() => {
        running = null;
        if (again && !stopped) run();
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
  const timer = setInterval(trigger, config.settings.intervalMs);
  timer.unref();
  activeTrigger = trigger;
  trigger();
  logger.info(
    { intervalMs: config.settings.intervalMs, dryRun: config.settings.dryRun },
    "Stripe ID write-back started."
  );
  return {
    trigger,
    async stop() {
      stopped = true;
      if (activeTrigger === trigger) activeTrigger = null;
      clearInterval(timer);
      while (running) await running;
    },
  };
}
