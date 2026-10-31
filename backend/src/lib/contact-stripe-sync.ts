import crypto from "node:crypto";
import { and, eq, inArray, isNotNull, like, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import Stripe from "stripe";
import { db, pool } from "../db/client";
import {
  billingCustomers,
  clientOnboardingSubmissions,
  contactStripeSyncBooks,
  contactStripeSyncCards,
} from "../db/schema";
import {
  CONTACT_STRIPE_SYNC_DEFAULT_INTERVAL_MS,
  CONTACT_STRIPE_SYNC_MIN_INTERVAL_MS,
} from "./constants";
import {
  changedFields,
  combinedHash,
  fieldHashes,
  type MappedFields,
  mapCardToStripe,
} from "./contact-stripe-fields";
import {
  getNextcloudConfig,
  NextcloudCircuitOpenError,
  type NextcloudConfig,
  NextcloudHttpError,
  NextcloudRequestError,
} from "./nextcloud";
import {
  listAddressbooks,
  type StoredCard,
  SyncTokenRejectedError,
  syncAddressbook,
  vCardUid,
} from "./nextcloud-contacts";
import { stripe } from "./stripe";

// Pushes edits made to a client's Nextcloud contact card to the client's billing Stripe
// Customer (the platform account; `stripeAccount` is never passed). Off unless
// CONTACT_STRIPE_SYNC=true. Nextcloud wins: nothing is ever written back to Nextcloud.
//
// Scope: only the onboarding client cards (UID dfwsc-client-*, created by
// lib/client-onboarding-sync.ts in CLIENT_ONBOARDING_ADDRESSBOOK_PATH) whose submission is
// linked to a billing Customer (billing_customers by client code, else the submission's own
// billing_customer_id). Other cards, books and unlinked cards are ignored.
//
// Polling, nothing runs on Nextcloud: a CardDAV sync-collection REPORT with a stored
// sync-token per address book returns only the cards changed since the last cycle. A token
// the server refuses (or none stored, or a link with no recorded card yet) means a full scan
// with an ETag compare, and the token is reset.
//
// The first time a linked card is seen, its mapped-field hashes and ETag are recorded
// WITHOUT pushing: a Customer made by hand in the Stripe dashboard is never overwritten
// until someone edits the card. Only later changes push, and only the fields that changed.
// A field that is blank on the card never clears the Stripe field.
//
// Logs carry ids, field names, statuses and error codes only: never names, emails, phone
// numbers, addresses or DAV paths.

type Logger = Pick<FastifyBaseLogger, "info" | "warn" | "error">;

const CLIENT_CARD_UID_PREFIX = "dfwsc-client-";

interface ContactStripeSyncSettings {
  nextcloud: NextcloudConfig;
  addressbook: string;
  intervalMs: number;
}

type ConfigResult =
  | { status: "disabled" }
  | { status: "invalid"; problems: string[] }
  | { status: "ready"; settings: ContactStripeSyncSettings };

function loadConfig(env: NodeJS.ProcessEnv): ConfigResult {
  if (env.CONTACT_STRIPE_SYNC?.trim() !== "true") return { status: "disabled" };
  const problems: string[] = [];
  const nc = getNextcloudConfig(env);
  if (!nc.ok) {
    problems.push(
      nc.reason === "not_configured"
        ? "NEXTCLOUD_BASE_URL, NEXTCLOUD_USERNAME and NEXTCLOUD_APP_PASSWORD are required"
        : "NEXTCLOUD_BASE_URL must be a valid https:// URL"
    );
  }
  const addressbook = env.CLIENT_ONBOARDING_ADDRESSBOOK_PATH?.trim() ?? "";
  if (!addressbook || addressbook.includes("/") || /^\.+$/.test(addressbook)) {
    problems.push("CLIENT_ONBOARDING_ADDRESSBOOK_PATH must be one address book collection name");
  }
  let intervalMs = CONTACT_STRIPE_SYNC_DEFAULT_INTERVAL_MS;
  const rawInterval = env.CONTACT_STRIPE_SYNC_INTERVAL_MS?.trim();
  if (rawInterval) {
    const parsed = /^\d+$/.test(rawInterval) ? Number(rawInterval) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < CONTACT_STRIPE_SYNC_MIN_INTERVAL_MS) {
      problems.push(
        `CONTACT_STRIPE_SYNC_INTERVAL_MS must be at least ${CONTACT_STRIPE_SYNC_MIN_INTERVAL_MS}`
      );
    } else {
      intervalMs = parsed;
    }
  }
  if (!nc.ok || problems.length) return { status: "invalid", problems };
  return { status: "ready", settings: { nextcloud: nc.config, addressbook, intervalMs } };
}

// ── Links ────────────────────────────────────────────────────────────────────

interface Link {
  contactUid: string;
  clientCode: string;
  customerId: string;
}

/**
 * The onboarding cards linked to a billing Customer. billing_customers (by client code) is
 * authoritative, so links made later by the backfill script count too; the submission's own
 * billing_customer_id is the fallback when it is marked linked.
 */
async function loadLinks(): Promise<Map<string, Link>> {
  const s = clientOnboardingSubmissions;
  const rows = await db
    .select({
      contactUid: s.contactUid,
      clientCode: s.projectCode,
      linked: billingCustomers.stripeCustomerId,
      billingStatus: s.billingStatus,
      billingCustomerId: s.billingCustomerId,
    })
    .from(s)
    .leftJoin(billingCustomers, eq(billingCustomers.clientCode, s.projectCode))
    .where(
      and(
        like(s.contactUid, `${CLIENT_CARD_UID_PREFIX}%`),
        eq(s.contactStatus, "created"),
        isNotNull(s.projectCode)
      )
    );
  const links = new Map<string, Link>();
  for (const row of rows) {
    const customerId =
      row.linked ?? (row.billingStatus === "linked" ? row.billingCustomerId : null);
    if (row.contactUid && row.clientCode && customerId) {
      links.set(row.contactUid, {
        contactUid: row.contactUid,
        clientCode: row.clientCode,
        customerId,
      });
    }
  }
  return links;
}

// ── Stripe ───────────────────────────────────────────────────────────────────

function classifyStripeError(error: unknown): { code: string; retryable: boolean; auth: boolean } {
  if (error instanceof Stripe.errors.StripeError) {
    const status = error.statusCode;
    const retryable =
      error instanceof Stripe.errors.StripeConnectionError ||
      error instanceof Stripe.errors.StripeRateLimitError ||
      error instanceof Stripe.errors.StripeAPIError ||
      (typeof status === "number" &&
        (status >= 500 || status === 429 || status === 409 || status === 401 || status === 403));
    return {
      code: `stripe.customer_update:${status ?? error.type ?? "error"}`,
      retryable,
      auth: status === 401 || status === 403,
    };
  }
  return { code: "stripe.customer_update:internal_error", retryable: true, auth: false };
}

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

/**
 * Keyed on the Customer, the card's ETag and the pushed fields: a retry of one edit repeats
 * the key, while changing a value and changing it back (new ETag) is a new request that
 * Stripe's 24h idempotency cache will not swallow.
 */
function idempotencyKey(customerId: string, etag: string | null, changed: MappedFields): string {
  const digest = sha256(`${customerId}\n${etag ?? ""}\n${JSON.stringify(fieldHashes(changed))}`);
  return `contact-sync-${digest}`;
}

// ── Cycle ────────────────────────────────────────────────────────────────────

export interface ContactStripeSyncResult {
  status:
    | "disabled"
    | "invalid_config"
    | "nextcloud_unavailable"
    | "read_only"
    | "busy"
    | "backoff"
    | "error"
    | "ok";
  fullScan: boolean;
  baselined: number;
  pushed: number;
  failed: number;
}

const result = (
  status: ContactStripeSyncResult["status"],
  extra: Partial<ContactStripeSyncResult> = {}
): ContactStripeSyncResult => ({
  status,
  fullScan: false,
  baselined: 0,
  pushed: 0,
  failed: 0,
  ...extra,
});

let lastLoggedProblem: string | null = null;

// A persistent 401/403 (rotated or restricted key) backs the whole sync off exponentially, from
// one interval up to 30 minutes, until a push succeeds. In memory: a restart starts over.
const MAX_AUTH_BACKOFF_MS = 30 * 60 * 1000;
const authBackoff = { failures: 0, until: 0 };

// One cycle at a time across API instances (deploy overlap, restarts): a session-level
// advisory lock held on a dedicated pooled connection for the whole cycle. It is released when
// the cycle ends or, if the process dies, when its connection closes.
const CYCLE_LOCK_NAME = "contact_stripe_sync_cycle";

function logProblemOnce(logger: Logger, key: string, fields: Record<string, unknown>, msg: string) {
  if (lastLoggedProblem === key) return;
  lastLoggedProblem = key;
  logger.error(fields, msg);
}

export function resetContactStripeSyncStateForTests() {
  lastLoggedProblem = null;
  authBackoff.failures = 0;
  authBackoff.until = 0;
}

const notResetSince = (cycleStart: Date) =>
  sql`(${contactStripeSyncCards.baselineResetAt} is null or ${contactStripeSyncCards.baselineResetAt} <= ${cycleStart})`;

/**
 * Forgets a card's recorded state so its next sighting is a baseline, not an edit. For writes
 * the automation makes itself (the onboarding contact step adding to a card): they are not a
 * person's edit and must not be pushed to the Customer.
 */
export async function resetCardBaseline(contactUid: string): Promise<void> {
  await db
    .update(contactStripeSyncCards)
    .set({
      baselineAt: null,
      etag: null,
      lastHash: null,
      fieldHashes: null,
      baselineResetAt: sql`now()`,
    })
    .where(eq(contactStripeSyncCards.contactUid, contactUid));
}

type CardState = typeof contactStripeSyncCards.$inferSelect;

interface Candidate {
  link: Link;
  card: StoredCard;
  state: CardState;
  fields: MappedFields;
  changed: MappedFields;
  hashes: ReturnType<typeof fieldHashes>;
  hash: string;
  rev: number;
}

export async function runContactStripeSyncCycle(options: {
  logger: Logger;
  env?: NodeJS.ProcessEnv;
}): Promise<ContactStripeSyncResult> {
  const { logger, env = process.env } = options;
  const config = loadConfig(env);
  if (config.status === "disabled") return result("disabled");
  if (config.status === "invalid") {
    logProblemOnce(
      logger,
      `invalid:${config.problems.join("|")}`,
      { problems: config.problems },
      "Contact to Stripe sync is enabled but its config is invalid; skipped."
    );
    return result("invalid_config");
  }
  if (Date.now() < authBackoff.until) return result("backoff");
  try {
    const client = await pool.connect();
    let outcome: ContactStripeSyncResult;
    try {
      const lock = await client.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS ok",
        [CYCLE_LOCK_NAME]
      );
      if (!lock.rows[0]?.ok) return result("busy");
      try {
        // Database clock, taken before any read: see resetCardBaseline / notResetSince.
        const started = await client.query<{ now: Date }>("SELECT now() AS now");
        outcome = await syncOnce(config.settings, logger, started.rows[0].now);
      } finally {
        await client
          .query("SELECT pg_advisory_unlock(hashtext($1))", [CYCLE_LOCK_NAME])
          .catch(() => {});
      }
    } finally {
      client.release();
    }
    if (outcome.status === "ok") lastLoggedProblem = null;
    return outcome;
  } catch (error) {
    if (
      error instanceof NextcloudCircuitOpenError ||
      error instanceof NextcloudRequestError ||
      (error instanceof NextcloudHttpError && (error.status >= 500 || error.status === 429))
    ) {
      logger.warn(
        { errorName: (error as Error).name },
        "Contact to Stripe sync: Nextcloud unavailable."
      );
      return result("nextcloud_unavailable");
    }
    logger.error(
      {
        errorName: (error as Error)?.name,
        status: error instanceof NextcloudHttpError ? error.status : undefined,
      },
      "Contact to Stripe sync cycle failed."
    );
    return result("error");
  }
}

async function syncOnce(
  settings: ContactStripeSyncSettings,
  logger: Logger,
  cycleStart: Date
): Promise<ContactStripeSyncResult> {
  const { nextcloud: nc, addressbook } = settings;
  const links = await loadLinks();
  if (!links.size) return result("ok");

  const book = (await listAddressbooks(nc, addressbook)).find((b) => b.name === addressbook);
  if (book?.readOnly) {
    logProblemOnce(
      logger,
      "read_only",
      { addressbook },
      "The onboarding address book is read-only for the service account; contact sync skipped."
    );
    return result("read_only");
  }

  const stateRows = await db
    .select()
    .from(contactStripeSyncCards)
    .where(inArray(contactStripeSyncCards.contactUid, [...links.keys()]));
  const states = new Map(stateRows.map((r) => [r.contactUid, r]));
  const [bookRow] = await db
    .select()
    .from(contactStripeSyncBooks)
    .where(eq(contactStripeSyncBooks.addressbook, addressbook));

  // A link with no recorded card (or a Customer that changed) must be baselined from the
  // card itself, which a delta that does not list the card cannot do.
  const needsBaseline = [...links.values()].some((link) => {
    const state = states.get(link.contactUid);
    return !state || state.stripeCustomerId !== link.customerId;
  });
  let fullScan = !bookRow?.syncToken || needsBaseline;
  let delta: Awaited<ReturnType<typeof syncAddressbook>> | null = null;
  if (!fullScan) {
    try {
      delta = await syncAddressbook(nc, addressbook, bookRow.syncToken, false);
    } catch (error) {
      if (!(error instanceof SyncTokenRejectedError)) throw error;
      logger.warn({ addressbook }, "CardDAV sync-token rejected; running a full scan.");
      fullScan = true;
    }
  }
  if (!delta) delta = await syncAddressbook(nc, addressbook, null, false);

  const outcome = result("ok", { fullScan });
  const candidates: Candidate[] = [];
  const found = new Set<string>();

  for (const card of delta.cards) {
    const uid = vCardUid(card.data);
    const link = uid ? links.get(uid) : undefined;
    if (!uid || !link || found.has(uid)) continue;
    found.add(uid);
    const state = states.get(uid);
    const mapped = mapCardToStripe(card.data);
    const hashes = fieldHashes(mapped.fields);
    const hash = combinedHash(hashes);

    if (!state || state.baselineAt === null || state.stripeCustomerId !== link.customerId) {
      await saveState(
        link,
        card,
        {
          lastHash: hash,
          fieldHashes: hashes,
          baselineAt: new Date(),
          lastError: null,
          lastErrorHash: null,
        },
        cycleStart
      );
      outcome.baselined++;
      logger.info(
        { contactUid: uid, stripeCustomerId: link.customerId },
        "Contact card baselined; nothing pushed."
      );
      continue;
    }
    if (card.etag !== null && state.etag === card.etag) continue;
    for (const note of mapped.notes) {
      logger.warn(
        { contactUid: uid, note },
        "A contact card field was left out of the Stripe sync."
      );
    }
    if (hash === state.lastHash || state.lastErrorHash === hash) {
      // Nothing mapped changed, or this exact content already failed for good.
      await saveState(link, card, {}, cycleStart);
      continue;
    }
    const changed = changedFields(mapped.fields, hashes, state.fieldHashes);
    if (!Object.keys(changed).length) {
      // Only blanked or removed fields: recorded, nothing to push.
      await saveState(
        link,
        card,
        {
          lastHash: hash,
          fieldHashes: hashes,
          lastError: null,
          lastErrorHash: null,
        },
        cycleStart
      );
      continue;
    }
    candidates.push({
      link,
      card,
      state,
      fields: mapped.fields,
      changed,
      hashes,
      hash,
      rev: mapped.rev ?? 0,
    });
  }

  if (fullScan) {
    // Links whose card is not in the book get a placeholder, so a missing card does not
    // force a full scan every cycle; the card is baselined if it ever shows up.
    for (const link of links.values()) {
      if (found.has(link.contactUid)) continue;
      await db
        .insert(contactStripeSyncCards)
        .values({
          contactUid: link.contactUid,
          clientCode: link.clientCode,
          stripeCustomerId: link.customerId,
        })
        .onConflictDoUpdate({
          target: contactStripeSyncCards.contactUid,
          set: {
            clientCode: link.clientCode,
            stripeCustomerId: link.customerId,
            baselineAt: null,
            etag: null,
            href: null,
            lastHash: null,
            fieldHashes: null,
          },
        });
    }
  }
  if (delta.removed.length) {
    await db
      .update(contactStripeSyncCards)
      .set({ baselineAt: null, etag: null, href: null, lastHash: null, fieldHashes: null })
      .where(inArray(contactStripeSyncCards.href, delta.removed));
  }

  const retryNeeded = await pushCandidates(
    candidates,
    logger,
    outcome,
    settings.intervalMs,
    cycleStart
  );

  // A retryable failure keeps the old token, so the same delta comes back next cycle; the
  // cards that were handled are skipped by their recorded ETag.
  if (!retryNeeded) {
    await db
      .insert(contactStripeSyncBooks)
      .values({ addressbook, syncToken: delta.token, syncedAt: new Date() })
      .onConflictDoUpdate({
        target: contactStripeSyncBooks.addressbook,
        set: { syncToken: delta.token, syncedAt: new Date() },
      });
  }
  if (outcome.baselined || outcome.pushed || outcome.failed) {
    logger.info(
      { fullScan, baselined: outcome.baselined, pushed: outcome.pushed, failed: outcome.failed },
      "Contact to Stripe sync cycle done."
    );
  }
  return outcome;
}

async function saveState(
  link: Link,
  card: StoredCard,
  extra: Partial<typeof contactStripeSyncCards.$inferInsert>,
  cycleStart: Date
) {
  const values = {
    contactUid: link.contactUid,
    clientCode: link.clientCode,
    stripeCustomerId: link.customerId,
    href: card.href,
    etag: card.etag,
    ...extra,
  };
  await db
    .insert(contactStripeSyncCards)
    .values(values)
    .onConflictDoUpdate({
      target: contactStripeSyncCards.contactUid,
      set: {
        clientCode: values.clientCode,
        stripeCustomerId: values.stripeCustomerId,
        href: values.href,
        etag: values.etag,
        ...extra,
      },
      // The automation rewrote this card after the cycle started (resetCardBaseline): what the
      // cycle read is stale, so it must not overwrite the row. The next cycle baselines it.
      setWhere: notResetSince(cycleStart),
    });
}

/** Pushes the changes, one Customer at a time. Returns whether a retryable failure happened. */
async function pushCandidates(
  candidates: Candidate[],
  logger: Logger,
  outcome: ContactStripeSyncResult,
  intervalMs: number,
  cycleStart: Date
): Promise<boolean> {
  const byCustomer = new Map<string, Candidate[]>();
  for (const c of candidates) {
    byCustomer.set(c.link.customerId, [...(byCustomer.get(c.link.customerId) ?? []), c]);
  }
  let retryNeeded = false;
  for (const [customerId, group] of byCustomer) {
    // Cards sharing a Customer: the last edit (by REV) is applied last and wins.
    group.sort((a, b) => a.rev - b.rev || a.link.contactUid.localeCompare(b.link.contactUid));
    if (group.length > 1) {
      logger.info(
        { stripeCustomerId: customerId, cards: group.map((g) => g.link.contactUid) },
        "Several cards of one Customer changed in the same cycle; applied in REV order."
      );
    }
    for (const c of group) {
      const params: Stripe.CustomerUpdateParams = { ...c.changed };
      try {
        await stripe.customers.update(customerId, params, {
          idempotencyKey: idempotencyKey(customerId, c.card.etag, c.changed),
        });
      } catch (error) {
        const { code, retryable, auth } = classifyStripeError(error);
        outcome.failed++;
        logger.warn(
          {
            contactUid: c.link.contactUid,
            stripeCustomerId: customerId,
            fields: Object.keys(c.changed),
            code,
            retryable,
          },
          "Could not push the contact card to the Stripe Customer."
        );
        if (auth) {
          authBackoff.failures++;
          authBackoff.until =
            Date.now() +
            Math.min(MAX_AUTH_BACKOFF_MS, intervalMs * 2 ** (authBackoff.failures - 1));
        }
        if (retryable) {
          await saveErrorOnly(c, code, cycleStart);
          retryNeeded = true;
          break; // later cards of this Customer wait, to keep the REV order
        }
        await saveState(c.link, c.card, { lastError: code, lastErrorHash: c.hash }, cycleStart);
        continue;
      }
      authBackoff.failures = 0;
      authBackoff.until = 0;
      await saveState(
        c.link,
        c.card,
        {
          lastHash: c.hash,
          fieldHashes: c.hashes,
          lastPushedAt: new Date(),
          lastError: null,
          lastErrorHash: null,
        },
        cycleStart
      );
      outcome.pushed++;
      logger.info(
        {
          contactUid: c.link.contactUid,
          stripeCustomerId: customerId,
          fields: Object.keys(c.changed),
        },
        "Contact card pushed to the Stripe Customer."
      );
    }
  }
  return retryNeeded;
}

/** Notes a retryable failure without moving the recorded ETag, so the card is retried. */
async function saveErrorOnly(c: Candidate, code: string, cycleStart: Date) {
  await db
    .update(contactStripeSyncCards)
    .set({ lastError: code })
    .where(
      and(eq(contactStripeSyncCards.contactUid, c.link.contactUid), notResetSince(cycleStart))
    );
}

// ── Runner ───────────────────────────────────────────────────────────────────

export interface ContactStripeSyncRunner {
  /** Asks for a cycle now. One runs at a time; a request during a cycle queues one more. */
  trigger(): void;
  /** Stops the timer and waits for a running cycle to finish. */
  stop(): Promise<void>;
}

/**
 * Starts the poller when CONTACT_STRIPE_SYNC=true and the config is valid; otherwise returns
 * null (logging why when the config is invalid). Never throws: the API must start regardless.
 */
export function startContactStripeSync(
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env
): ContactStripeSyncRunner | null {
  const config = loadConfig(env);
  if (config.status === "disabled") return null;
  if (config.status === "invalid") {
    logger.error(
      { problems: config.problems },
      "Contact to Stripe sync is enabled but its config is invalid; not started."
    );
    return null;
  }

  let running: Promise<unknown> | null = null;
  let again = false;
  let stopped = false;
  const run = () => {
    running = runContactStripeSyncCycle({ logger, env })
      .catch((error: unknown) => {
        logger.error(
          { errorName: (error as Error)?.name },
          "Contact to Stripe sync cycle crashed."
        );
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
  const timer = setInterval(trigger, config.settings.intervalMs);
  timer.unref();
  trigger();
  logger.info(
    { addressbook: config.settings.addressbook, intervalMs: config.settings.intervalMs },
    "Contact to Stripe sync started."
  );
  return {
    trigger,
    async stop() {
      stopped = true;
      clearInterval(timer);
      while (running) await running;
    },
  };
}
