import crypto from "node:crypto";
import { stripeCustomerUrl } from "./billing-mirror-render";
import {
  nextGroup,
  parseLines,
  revStamp,
  serialize,
  unescapeVCardText,
  type VCardLine,
} from "./nextcloud-contacts";

// Pure parts of the Stripe ID write-back (lib/stripe-id-writeback-sync.ts): the desired state
// derived from billing_customers and the client onboarding submissions, and the vCard merge that
// puts a Stripe Customer link onto a contact card. No I/O.

/** Title of the Client Projects column that holds the raw Customer id. */
export const STRIPE_ID_COLUMN_TITLE = "Stripe Customer ID";
/** Label of the URL entry on a contact card (Contacts' custom label, stored as X-ABLABEL). */
const STRIPE_CARD_LABEL = "Stripe customer";

// A URL entry is ours when it points at a Stripe Dashboard Customer page, whatever its group,
// label case or live/test mode.
const OUR_URL = /dashboard\.stripe\.com\/(?:test\/)?customers\/(cus_[A-Za-z0-9]+)/i;

const CUSTOMER_ID = /^cus_[A-Za-z0-9]+$/;

const sha256 = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

const projectRowHash = (customerId: string) => sha256(`project_row:${customerId}`);
const contactCardHash = (customerIds: string[]) =>
  sha256(`contact_card:${[...new Set(customerIds)].sort().join(",")}`);

/** The Customer id of one of our URL entries, or null for any other line. */
function ourCustomerId(line: VCardLine): string | null {
  if (line.name !== "URL") return null;
  return OUR_URL.exec(unescapeVCardText(line.value))?.[1] ?? null;
}

function groupOf(raw: string): string | null {
  const head = (raw.indexOf(":") === -1 ? raw : raw.slice(0, raw.indexOf(":"))).split(";")[0];
  const dot = head.lastIndexOf(".");
  return dot === -1 ? null : head.slice(0, dot).toLowerCase();
}

/**
 * The card with exactly one Stripe customer URL entry per id in `customerIds`: missing ones are
 * added (group form `NEXTCLOUDn.URL` + `NEXTCLOUDn.X-ABLABEL`), entries for an id no longer
 * wanted are removed together with their label, and duplicates collapse to the first. An entry
 * that already carries a wanted id is kept as it is, so a relabel or a test-mode URL is never
 * rewritten. Every other line is preserved. Null when nothing would change, so an already
 * correct card is never written (and its ETag never moves).
 */
export function mergeStripeIdIntoVCard(
  card: string,
  customerIds: string[],
  now: Date = new Date()
): string | null {
  const wanted = [...new Set(customerIds)].sort();
  let lines = parseLines(card).filter((l) => l.name !== "END");
  let changed = false;

  const seen = new Set<string>();
  const dropGroups = new Set<string>();
  lines = lines.filter((line) => {
    const id = ourCustomerId(line);
    if (id === null) return true;
    if (wanted.includes(id) && !seen.has(id)) {
      seen.add(id);
      return true;
    }
    changed = true;
    const group = groupOf(line.raw);
    if (group !== null) dropGroups.add(group);
    return false;
  });
  // The label of a removed entry goes with it, unless something else still uses the group.
  for (const group of dropGroups) {
    const members = lines.filter((l) => groupOf(l.raw) === group);
    if (members.every((l) => l.name === "X-ABLABEL")) {
      lines = lines.filter((l) => groupOf(l.raw) !== group);
    }
  }

  for (const id of wanted) {
    if (seen.has(id)) continue;
    const group = nextGroup(lines);
    for (const raw of [
      `${group}.URL:${stripeCustomerUrl(id)}`,
      `${group}.X-ABLABEL:${STRIPE_CARD_LABEL}`,
    ]) {
      lines.push({ name: raw.includes(".URL:") ? "URL" : "X-ABLABEL", raw, value: "" });
    }
    changed = true;
  }
  if (!changed) return null;
  const rest = lines.filter((l) => l.name !== "REV");
  return serialize([...rest.map((l) => l.raw), `REV:${revStamp(now)}`, "END:VCARD"]);
}

// ── Desired state ────────────────────────────────────────────────────────────

export interface BillingLinkRow {
  clientCode: string;
  stripeCustomerId: string;
  /** billing_customers.email, lowercased. */
  email: string;
}

export interface SubmissionRef {
  projectCode: string | null;
  tableRowId: number | null;
  contactUid: string | null;
  contactStatus: string | null;
}

export interface DesiredRow {
  clientCode: string;
  customerId: string;
  /** Client Projects row id the onboarding created, when there is one. */
  tableRowId: number | null;
  hash: string;
}

export interface DesiredCard {
  /** The contact UID, or `client:<code>` when the card is found by email instead. */
  key: string;
  customerIds: string[];
  uid: string | null;
  /** Fallback lookup, only used when `uid` is null. */
  email: string | null;
  codes: string[];
  hash: string;
}

export interface DesiredState {
  rows: Map<string, DesiredRow>;
  cards: Map<string, DesiredCard>;
}

const CARD_STATUSES = new Set(["created", "updated"]);

/**
 * What every linked client should carry. billing_customers is the source of truth: one row per
 * client code, one Customer id each (several codes may share one id). A code gets its card by the
 * submission's contact UID; with none (a client linked by the backfill script, no form
 * submission) it falls back to its billing email. A card reached by several codes carries every
 * distinct id.
 */
export function buildDesiredState(
  links: BillingLinkRow[],
  submissions: SubmissionRef[],
  onInvalidId?: (clientCode: string) => void
): DesiredState {
  const byCode = new Map<string, SubmissionRef[]>();
  for (const s of submissions) {
    if (s.projectCode) byCode.set(s.projectCode, [...(byCode.get(s.projectCode) ?? []), s]);
  }
  const rows = new Map<string, DesiredRow>();
  const cards = new Map<string, DesiredCard>();
  for (const link of [...links].sort((a, b) => a.clientCode.localeCompare(b.clientCode))) {
    // The id ends up in a vCard line and a table cell: only a plain Customer id gets through.
    if (!CUSTOMER_ID.test(link.stripeCustomerId)) {
      onInvalidId?.(link.clientCode);
      continue;
    }
    const subs = byCode.get(link.clientCode) ?? [];
    rows.set(link.clientCode, {
      clientCode: link.clientCode,
      customerId: link.stripeCustomerId,
      tableRowId: subs.find((s) => s.tableRowId !== null)?.tableRowId ?? null,
      hash: projectRowHash(link.stripeCustomerId),
    });
    const uid =
      subs.find((s) => s.contactUid && s.contactStatus && CARD_STATUSES.has(s.contactStatus))
        ?.contactUid ?? null;
    const key = uid ?? `client:${link.clientCode}`;
    const existing = cards.get(key);
    const customerIds = [
      ...new Set([...(existing?.customerIds ?? []), link.stripeCustomerId]),
    ].sort();
    cards.set(key, {
      key,
      customerIds,
      uid,
      email: link.email.trim().toLowerCase() || null,
      codes: [...(existing?.codes ?? []), link.clientCode],
      hash: contactCardHash(customerIds),
    });
  }
  return { rows, cards };
}
