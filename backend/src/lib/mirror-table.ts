import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db, pool } from "../db/client";
import { portalMirrorRows, portalMirrorState } from "../db/schema";
import { NextcloudCircuitOpenError, NextcloudHttpError, NextcloudRequestError } from "./nextcloud";
import type { PortalMirrorNextcloud } from "./portal-mirror-nextcloud";
import {
  type ColumnSpec,
  cellMatches,
  contentHash,
  type RenderedValues,
  toRowData,
} from "./portal-mirror-render";
import type { TableColumn } from "./sales-lead-mapping";

// What every read-only Nextcloud Table mirror shares (Portal Accounts in portal-mirror-sync.ts,
// Client Billing in billing-mirror-sync.ts): config parsing helpers, provisioning of the table, its
// columns and its read-only shares, the advisory-locked cycle and Nextcloud outage handling.

export type MirrorLogger = Pick<FastifyBaseLogger, "info" | "warn" | "error">;

export function intVar(
  raw: string | undefined,
  name: string,
  min: number,
  max: number,
  fallback: number,
  problems: string[]
): number {
  const text = raw?.trim();
  if (!text) return fallback;
  const parsed = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    problems.push(`${name} must be a whole number from ${min} to ${max}`);
    return fallback;
  }
  return parsed;
}

/** Comma separated Nextcloud group names; `fallback` when the variable is empty or unset. */
export function parseShareGroups(
  raw: string | undefined,
  name: string,
  fallback: string[],
  problems: string[]
): string[] {
  const text = raw?.trim();
  const groups = text
    ? text
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean)
    : fallback;
  if (!groups.length || groups.some((g) => g.length > 64)) {
    problems.push(`${name} must list Nextcloud group names, comma separated`);
  }
  return groups;
}

/** Misconfigured table (a hand-made one is missing columns). `detail` holds titles only. */
export class PortalMirrorConfigError extends Error {
  constructor(readonly detail: string) {
    super(`Portal mirror misconfigured: ${detail}`);
    this.name = "PortalMirrorConfigError";
  }
}

/** Nextcloud as a whole is unusable right now: end the cycle instead of failing every row. */
export function isOutage(error: unknown): boolean {
  return (
    error instanceof NextcloudCircuitOpenError ||
    error instanceof NextcloudRequestError ||
    (error instanceof NextcloudHttpError &&
      (error.status >= 500 || error.status === 429 || error.status === 401 || error.status === 403))
  );
}

export const isAuthError = (error: unknown) =>
  error instanceof NextcloudHttpError && (error.status === 401 || error.status === 403);

const isNotFound = (error: unknown) => error instanceof NextcloudHttpError && error.status === 404;

const RETRY_BASE_SECONDS = 60;
const RETRY_MAX_SECONDS = 60 * 60;
const retrySeconds = (attempts: number) =>
  Math.min(RETRY_BASE_SECONDS * 2 ** Math.min(attempts, 20), RETRY_MAX_SECONDS);

// ── Provisioning ─────────────────────────────────────────────────────────────

async function storedTableId(stateKey: string): Promise<number | null> {
  const [row] = await db
    .select({ value: portalMirrorState.value })
    .from(portalMirrorState)
    .where(eq(portalMirrorState.key, stateKey));
  const id = row ? Number(row.value) : Number.NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function saveTableId(stateKey: string, id: number | null): Promise<void> {
  if (id === null) {
    await db.delete(portalMirrorState).where(eq(portalMirrorState.key, stateKey));
    return;
  }
  await db
    .insert(portalMirrorState)
    .values({ key: stateKey, value: String(id) })
    .onConflictDoUpdate({
      target: portalMirrorState.key,
      set: { value: String(id), updatedAt: new Date() },
    });
}

export interface Provisioned {
  tableId: number;
  columnIds: Map<string, number>;
  specs: ColumnSpec[];
}

export interface ProvisionCache {
  current: { signature: string; value: Provisioned } | null;
}

export interface TableSpec {
  title: string;
  emoji: string;
  /** Key in portal_mirror_state holding the id of the table this mirror provisioned. */
  stateKey: string;
  specs: ColumnSpec[];
  shareGroups: string[];
  baseUrl: string;
  /** Hand-made table (fallback): its columns must exist and it is not shared by the API. */
  overrideTableId: number | null;
}

/**
 * Finds or creates the table and its columns, and (API-created tables only) the read-only
 * shares. Runs every cycle with one GET of the columns, so a table or column deleted in
 * Nextcloud is noticed on the next cycle without a restart:
 *
 * - The table id is, in order: the override id, the id stored in portal_mirror_state, a title
 *   lookup. A renamed table keeps being used through its stored id.
 * - A stored table that answers 404 is forgotten and found or created again by title.
 * - Missing columns are re-created by title.
 * - `changed` is true when anything was re-created (rows or cells may be missing: reconcile).
 */
export async function provisionMirrorTable(
  nc: PortalMirrorNextcloud,
  table: TableSpec,
  cache: ProvisionCache,
  logger: MirrorLogger
): Promise<{ value: Provisioned; changed: boolean }> {
  const { specs, stateKey, overrideTableId: override } = table;
  const signature = JSON.stringify([table.baseUrl, table.shareGroups]);
  const cached = cache.current?.signature === signature ? cache.current.value : null;

  let tableId = override ?? cached?.tableId ?? (await storedTableId(stateKey));
  let columns: TableColumn[] | null = null;
  let changed = false;
  let sharesChecked = cached !== null;

  if (tableId !== null) {
    try {
      columns = await nc.getColumns(tableId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      if (override !== null) throw new PortalMirrorConfigError(`table ${override} was not found`);
      logger.warn({ tableId }, "Portal mirror: its table is gone; looking for or creating one.");
      await saveTableId(stateKey, null);
      tableId = null;
      sharesChecked = false;
    }
  }
  if (tableId === null) {
    const owned = (await nc.listTables())
      .filter(
        (t) =>
          t.title === table.title && (t.ownership === null || t.ownership === nc.serviceUsername)
      )
      .sort((a, b) => a.id - b.id);
    if (owned.length > 1) {
      logger.warn(
        { tableIds: owned.map((t) => t.id), using: owned[0].id },
        "Portal mirror: several tables have the mirror's title; using the lowest id."
      );
    }
    tableId = owned.length ? owned[0].id : await nc.createTable(table.title, table.emoji);
    await saveTableId(stateKey, tableId);
    columns = await nc.getColumns(tableId);
    changed = true;
    sharesChecked = false;
  } else if (override === null && cached === null && (await storedTableId(stateKey)) !== tableId) {
    await saveTableId(stateKey, tableId);
  }

  const byTitle = new Map((columns ?? []).map((c) => [c.title.trim(), c.id]));
  const missing = specs.filter((s) => !byTitle.has(s.title));
  if (missing.length) {
    if (override !== null) {
      throw new PortalMirrorConfigError(
        `table ${tableId} lacks columns: ${missing.map((m) => m.title).join(", ")}`
      );
    }
    // Columns are created in order, so the table reads left to right as specified.
    for (const spec of missing) byTitle.set(spec.title, await nc.createColumn(tableId, spec));
    changed = true;
  }

  if (override === null && !sharesChecked) {
    const shares = await nc.listShares(tableId);
    for (const group of table.shareGroups) {
      const existing = shares.find((s) => s.receiver === group && s.receiverType === "group");
      if (!existing) {
        await nc.shareReadOnly(tableId, group);
      } else if (existing.writable) {
        // Not corrected here: only logged, because the share update call is unverified.
        logger.warn({ group }, "Portal mirror: a share of its table grants more than read access.");
      }
    }
  }

  const value: Provisioned = {
    tableId,
    columnIds: new Map(specs.map((s) => [s.key, byTitle.get(s.title) as number])),
    specs,
  };
  cache.current = { signature, value };
  return { value, changed };
}

// ── Locked cycle ─────────────────────────────────────────────────────────────

/** A rejected app password (401/403) backs a mirror off, doubling from one interval to 30 min. */
const MAX_AUTH_BACKOFF_MS = 30 * 60 * 1000;

export class AuthBackoff {
  failures = 0;
  until = 0;
  reset() {
    this.failures = 0;
    this.until = 0;
  }
  succeeded() {
    this.failures = 0;
  }
  failed(intervalMs: number) {
    this.failures += 1;
    this.until = Date.now() + Math.min(intervalMs * 2 ** (this.failures - 1), MAX_AUTH_BACKOFF_MS);
  }
}

/**
 * Runs `work` while holding a session advisory lock; returns `busyValue` when another process
 * holds it. `work` gets the database clock, taken before any read. A connection that may still
 * hold the lock is destroyed, never pooled.
 */
export async function withMirrorLock<T>(
  lockName: string,
  logger: MirrorLogger,
  busyValue: T,
  work: (started: Date) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  let destroyClient = false;
  try {
    const lock = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS ok",
      [lockName]
    );
    if (!lock.rows[0]?.ok) return busyValue;
    try {
      const started = await client.query<{ now: Date }>("SELECT now() AS now");
      return await work(started.rows[0].now);
    } finally {
      try {
        const unlock = await client.query<{ ok: boolean }>(
          "SELECT pg_advisory_unlock(hashtext($1)) AS ok",
          [lockName]
        );
        destroyClient = !unlock.rows[0]?.ok;
      } catch {
        destroyClient = true;
      }
      if (destroyClient) {
        logger.error({}, "Portal mirror could not release its cycle lock; connection discarded.");
      }
    }
  } finally {
    client.release(destroyClient);
  }
}

// ── Row mapping (portal_mirror_rows) ─────────────────────────────────────────

export type MirrorKind = "account" | "billing";
const m = portalMirrorRows;

export type MirrorMappingRow = typeof portalMirrorRows.$inferSelect;

async function saveMirrorMapping(
  kind: MirrorKind,
  sourceId: string,
  patch: {
    ncRowId: number | null;
    contentHash: string | null;
    syncedAt: Date | null;
  }
) {
  const set = {
    ...patch,
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    updatedAt: new Date(),
  };
  await db
    .insert(m)
    .values({ kind, sourceId, ...set })
    .onConflictDoUpdate({ target: [m.kind, m.sourceId], set });
}

export async function recordMirrorFailure(
  kind: MirrorKind,
  sourceId: string,
  attempts: number,
  error: unknown
) {
  const name = (error as Error)?.name ?? "Error";
  const status = error instanceof NextcloudHttpError ? `:${error.status}` : "";
  const next = new Date(Date.now() + retrySeconds(attempts) * 1000);
  await db
    .insert(m)
    .values({
      kind,
      sourceId,
      attempts: attempts + 1,
      nextAttemptAt: next,
      lastError: `${name}${status}`.slice(0, 200),
    })
    .onConflictDoUpdate({
      target: [m.kind, m.sourceId],
      set: {
        attempts: attempts + 1,
        nextAttemptAt: next,
        lastError: `${name}${status}`.slice(0, 200),
        updatedAt: new Date(),
      },
    });
}

/**
 * Writes one rendered row to Nextcloud unless it already holds this content hash. A 404 on update
 * means the row was deleted in Nextcloud: it is created again. Throws on any Nextcloud failure.
 */
export async function pushMirrorRow(
  nc: PortalMirrorNextcloud,
  prov: Provisioned,
  kind: MirrorKind,
  sourceId: string,
  values: RenderedValues,
  mapping: MirrorMappingRow | null,
  cycleStart: Date
): Promise<"created" | "updated" | "unchanged"> {
  const hash = contentHash(values);
  const ncRowId = mapping?.ncRowId ?? null;
  if (ncRowId !== null && mapping?.contentHash === hash) {
    await saveMirrorMapping(kind, sourceId, { ncRowId, contentHash: hash, syncedAt: cycleStart });
    return "unchanged";
  }
  const data = toRowData(prov.specs, prov.columnIds, values);
  let savedId = ncRowId;
  let outcome: "created" | "updated" = "created";
  if (savedId !== null) {
    try {
      await nc.updateRow(savedId, data);
      outcome = "updated";
    } catch (error) {
      if (!(error instanceof NextcloudHttpError && error.status === 404)) throw error;
      savedId = null;
    }
  }
  if (savedId === null) savedId = await nc.createRow(prov.tableId, data);
  await saveMirrorMapping(kind, sourceId, {
    ncRowId: savedId,
    contentHash: hash,
    syncedAt: cycleStart,
  });
  return outcome;
}

/**
 * Compares the Nextcloud table with `expected` (source id to rendered values; the table's key
 * column holds the source id) and repairs drift. Rows missing or edited in Nextcloud lose their
 * hash (the normal loop rewrites them); rows with no source, or duplicates, are deleted.
 */
export async function reconcileMirrorRows(
  nc: PortalMirrorNextcloud,
  prov: Provisioned,
  kind: MirrorKind,
  keyKey: string,
  expected: Map<string, RenderedValues>,
  cycleStart: Date
): Promise<void> {
  const keyColumn = prov.columnIds.get(keyKey) as number;
  const ncRows = await nc.listRows(prov.tableId);
  const mapping = new Map(
    (await db.select().from(m).where(eq(m.kind, kind))).map((r) => [r.sourceId, r])
  );
  const save = (sourceId: string, patch: Parameters<typeof saveMirrorMapping>[2]) =>
    saveMirrorMapping(kind, sourceId, patch);

  const byKey = new Map<string, typeof ncRows>();
  for (const row of ncRows) {
    const key = String(row.cells.get(keyColumn) ?? "");
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }

  for (const [key, rows] of byKey) {
    if (!expected.has(key)) {
      for (const row of rows) await nc.deleteRow(row.id);
      continue;
    }
    const mapped = mapping.get(key)?.ncRowId;
    const keeper =
      rows.find((r) => r.id === mapped) ?? rows.reduce((a, b) => (a.id < b.id ? a : b));
    for (const row of rows) if (row !== keeper) await nc.deleteRow(row.id);
  }

  for (const [key, values] of expected) {
    const keeper =
      (byKey.get(key) ?? []).find((r) => r.id === mapping.get(key)?.ncRowId) ??
      (byKey.get(key) ?? []).reduce<(typeof ncRows)[number] | null>(
        (a, b) => (a && a.id < b.id ? a : b),
        null
      );
    if (!keeper) {
      await save(key, { ncRowId: null, contentHash: null, syncedAt: null });
      continue;
    }
    const drifted = prov.specs.some(
      (spec) =>
        !cellMatches(
          spec,
          keeper.cells.get(prov.columnIds.get(spec.key) as number),
          values[spec.key]
        )
    );
    if (drifted) {
      await save(key, { ncRowId: keeper.id, contentHash: null, syncedAt: null });
    } else if (mapping.get(key)?.ncRowId !== keeper.id || !mapping.get(key)?.contentHash) {
      await save(key, {
        ncRowId: keeper.id,
        contentHash: contentHash(values),
        syncedAt: cycleStart,
      });
    }
  }
}

/** Source ids of one kind that have a mapping row but are no longer expected. */
export async function staleMirrorRows(
  kind: MirrorKind,
  expected: Map<string, unknown>
): Promise<MirrorMappingRow[]> {
  return (await db.select().from(m).where(eq(m.kind, kind))).filter(
    (r) => !expected.has(r.sourceId)
  );
}
