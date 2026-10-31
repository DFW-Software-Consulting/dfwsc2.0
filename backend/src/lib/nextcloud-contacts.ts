import {
  encodePathSegments,
  NextcloudCircuitOpenError,
  type NextcloudConfig,
  NextcloudHttpError,
  nextcloudRequest,
} from "./nextcloud";
import { escapeVCardText, foldLine } from "./sales-lead-mapping";

// Contact lookup shared by the Nextcloud automations that write contact cards
// (lib/sales-lead-sync.ts and lib/client-onboarding-sync.ts): find the existing card
// for a person across EVERY address book the service account can see, so a card that
// lives in another book (e.g. a Stripe-synced one) is merged, not duplicated.

/** The fields a contact card is matched and merged on. */
export interface ContactPerson {
  company: string;
  contactName?: string;
  email?: string;
  phone?: string;
}

export interface StoredCard {
  /** Collection name of the address book the card lives in. */
  addressbook: string;
  /** Path of the card below the base URL, as the server sent it (percent-encoded). */
  href: string;
  etag: string | null;
  data: string;
  /** The account has no write privilege on this book; a write would be refused. */
  readOnly: boolean;
}

/** A card changed between our read and our write (If-Match failed); retried. */
export class ContactChangedError extends Error {
  constructor() {
    super("The contact card changed while it was being updated");
    this.name = "ContactChangedError";
  }
}

// Statuses that are worth another attempt, as elsewhere in the Nextcloud syncs.
const RETRYABLE_HTTP_STATUSES = new Set([401, 408, 423, 425, 429]);
// A shared book that cannot be read (revoked share, gone) is skipped, not fatal.
const UNREADABLE_BOOK_STATUSES = new Set([403, 404, 410]);

/**
 * Looking for an existing contact across address books failed, and the book was not
 * one that can simply be skipped. Never ignored: creating a card anyway could
 * duplicate one in the book that could not be read. `retryable` is false only for a
 * non-transient HTTP refusal; `status` and `addressbook` say where it happened.
 */
export class AddressbookDiscoveryError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;
  constructor(
    readonly cause?: unknown,
    readonly addressbook: string | null = null
  ) {
    super("The address books could not be searched for an existing contact");
    this.name = "AddressbookDiscoveryError";
    this.status = cause instanceof NextcloudHttpError ? cause.status : null;
    this.retryable =
      !(cause instanceof NextcloudHttpError) ||
      cause.status >= 500 ||
      RETRYABLE_HTTP_STATUSES.has(cause.status);
  }
}

/** Address books the server generates itself (not user data, not writable). */
const SYSTEM_ADDRESSBOOK = /^z-server-generated/i;

const ADDRESSBOOK_HOME_PROPFIND =
  '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:current-user-privilege-set/></d:prop></d:propfind>';
// Every card has an FN, so this lists the whole address book with its data.
const ADDRESSBOOK_QUERY =
  '<?xml version="1.0"?><c:addressbook-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><c:address-data/></d:prop><c:filter><c:prop-filter name="FN"/></c:filter></c:addressbook-query>';

function decodeXmlText(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlElement(block: string, localName: string): string | null {
  const match = new RegExp(
    `<(?:[\\w-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${localName}>`
  ).exec(block);
  return match ? decodeXmlText(match[1]) : null;
}

// ── CardDAV ──────────────────────────────────────────────────────────────────

function addressbookHome(nc: NextcloudConfig): string {
  return `/remote.php/dav/addressbooks/users/${encodePathSegments([nc.username])}/`;
}

export function addressbookCollection(nc: NextcloudConfig, addressbook: string): string {
  return `${addressbookHome(nc)}${encodePathSegments([addressbook])}/`;
}

export interface AddressbookInfo {
  name: string;
  readOnly: boolean;
}

/**
 * Every address book the service account can see: its own and those shared with it
 * (PROPFIND Depth:1 on the home). Server-generated system books are left out. The
 * configured book is always included, so a listing that omits it still searches it.
 * A book whose privilege set lacks write access is marked read-only.
 */
export async function listAddressbooks(
  nc: NextcloudConfig,
  configuredAddressbook: string
): Promise<AddressbookInfo[]> {
  const home = addressbookHome(nc);
  const res = await nextcloudRequest(nc, {
    method: "PROPFIND",
    label: "carddav.list_addressbooks",
    path: home,
    headers: { depth: "1", "content-type": "application/xml; charset=utf-8" },
    body: ADDRESSBOOK_HOME_PROPFIND,
  });
  const books = new Map<string, AddressbookInfo>([
    [configuredAddressbook, { name: configuredAddressbook, readOnly: false }],
  ]);
  const responses = res.body.match(
    /<(?:[\w-]+:)?response\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?response>/g
  );
  for (const block of responses ?? []) {
    const href = xmlElement(block, "href")?.trim();
    const resourceType = xmlElement(block, "resourcetype");
    if (!href || resourceType === null || !/<(?:[\w-]+:)?addressbook\b/.test(resourceType)) {
      continue;
    }
    if (!href.startsWith(home) || href.includes("/../")) {
      throw new AddressbookDiscoveryError();
    }
    const segment = href.slice(home.length).replace(/\/+$/, "");
    if (!segment || segment.includes("/")) continue;
    let name: string;
    try {
      name = decodeURIComponent(segment);
    } catch {
      throw new AddressbookDiscoveryError();
    }
    if (SYSTEM_ADDRESSBOOK.test(name)) continue;
    // No privilege information at all means unknown: try the write and handle a 403.
    const privileges = xmlElement(block, "current-user-privilege-set");
    const readOnly =
      privileges !== null && !/<(?:[\w-]+:)?(?:write|write-content|all)\s*\/>/.test(privileges);
    books.set(name, { name, readOnly });
  }
  return [...books.values()];
}

async function listCards(
  nc: NextcloudConfig,
  addressbook: string,
  readOnly: boolean
): Promise<StoredCard[]> {
  const collection = addressbookCollection(nc, addressbook);
  const res = await nextcloudRequest(nc, {
    method: "REPORT",
    label: "carddav.list",
    path: collection,
    headers: { depth: "1", "content-type": "application/xml; charset=utf-8" },
    body: ADDRESSBOOK_QUERY,
  });
  const cards: StoredCard[] = [];
  const responses = res.body.match(
    /<(?:[\w-]+:)?response\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?response>/g
  );
  for (const block of responses ?? []) {
    const href = xmlElement(block, "href")?.trim();
    const data = xmlElement(block, "address-data");
    if (!href || !data) continue;
    // Only cards inside this address book can ever be written back.
    if (!href.startsWith(collection) || href.includes("/../")) {
      throw new AddressbookDiscoveryError();
    }
    cards.push({
      addressbook,
      href,
      etag: xmlElement(block, "getetag")?.trim() || null,
      data,
      readOnly,
    });
  }
  return cards;
}

// ── CardDAV sync (RFC 6578) ──────────────────────────────────────────────────

/** The server no longer knows the stored sync-token; a full scan is needed. */
export class SyncTokenRejectedError extends Error {
  constructor() {
    super("The CardDAV sync-token was rejected");
    this.name = "SyncTokenRejectedError";
  }
}

// RFC 6578 answers an unusable token with 403 (DAV:valid-sync-token); servers also use 400,
// 409, 410 and 412 for a token they have dropped.
const SYNC_TOKEN_REJECTED_STATUSES = new Set([400, 403, 409, 410, 412]);

export interface AddressbookDelta {
  /** The token to store for the next call; null when the server sent none. */
  token: string | null;
  /** Cards added or changed since the token (every card, when no token was given). */
  cards: StoredCard[];
  /** Hrefs of cards removed since the token. */
  removed: string[];
}

function syncCollectionBody(token: string | null): string {
  return `<?xml version="1.0"?><d:sync-collection xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:sync-token>${token ? xmlEscape(token) : ""}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/><c:address-data/></d:prop></d:sync-collection>`;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Cards changed since `token` (all cards when it is null) in one address book, with the
 * new token. A token the server refuses throws SyncTokenRejectedError so the caller can
 * fall back to a full scan.
 */
export async function syncAddressbook(
  nc: NextcloudConfig,
  addressbook: string,
  token: string | null,
  readOnly: boolean
): Promise<AddressbookDelta> {
  const collection = addressbookCollection(nc, addressbook);
  let res: Awaited<ReturnType<typeof nextcloudRequest>>;
  try {
    res = await nextcloudRequest(nc, {
      method: "REPORT",
      label: "carddav.sync",
      path: collection,
      headers: { depth: "0", "content-type": "application/xml; charset=utf-8" },
      body: syncCollectionBody(token),
    });
  } catch (error) {
    if (
      token !== null &&
      error instanceof NextcloudHttpError &&
      SYNC_TOKEN_REJECTED_STATUSES.has(error.status)
    ) {
      throw new SyncTokenRejectedError();
    }
    throw error;
  }
  const cards: StoredCard[] = [];
  const removed: string[] = [];
  const responses = res.body.match(
    /<(?:[\w-]+:)?response\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?response>/g
  );
  for (const block of responses ?? []) {
    const href = xmlElement(block, "href")?.trim();
    if (!href) continue;
    if (!href.startsWith(collection) || href.includes("/../")) {
      // The collection's own entry (e.g. a truncation marker) is not a card.
      if (href.replace(/\/+$/, "") === collection.replace(/\/+$/, "")) continue;
      throw new AddressbookDiscoveryError();
    }
    const withoutProps = block.replace(
      /<(?:[\w-]+:)?propstat\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?propstat>/g,
      ""
    );
    if (/\b404\b/.test(xmlElement(withoutProps, "status") ?? "")) {
      removed.push(href);
      continue;
    }
    const data = xmlElement(block, "address-data");
    if (!data) continue;
    cards.push({
      addressbook,
      href,
      etag: xmlElement(block, "getetag")?.trim() || null,
      data,
      readOnly,
    });
  }
  const newToken = xmlElement(
    res.body.replace(/<(?:[\w-]+:)?response\b[\s\S]*?<\/(?:[\w-]+:)?response>/g, ""),
    "sync-token"
  )?.trim();
  return { token: newToken || null, cards, removed };
}

/** Overwrites a card only if it is unchanged since it was read. */
export async function updateCard(
  nc: NextcloudConfig,
  card: StoredCard,
  vcard: string
): Promise<void> {
  const headers: Record<string, string> = { "content-type": "text/vcard; charset=utf-8" };
  if (card.etag) headers["if-match"] = card.etag;
  const res = await nextcloudRequest(nc, {
    method: "PUT",
    label: "carddav.update_contact",
    path: card.href,
    headers,
    body: vcard,
    okStatuses: [412],
  });
  if (res.status === 412) throw new ContactChangedError();
}

export interface ContactDirectory {
  /** Forget a book's cached cards; call after writing to it. */
  invalidate(addressbook: string): void;
  /**
   * The card(s) that could be this person, from every address book the account can
   * see. A card carrying `ownUid` (the one this very submission created on an earlier
   * attempt) is returned alone as `own`, so a retry never goes ambiguous against its
   * own card. A book that answers 403/404/410 is skipped (and reported through
   * `onSkippedBook`); any other failure becomes AddressbookDiscoveryError, because
   * skipping a book would let the caller duplicate a card that lives there. An open
   * circuit breaker passes through unchanged so the cycle is skipped, not an attempt used.
   */
  find(
    person: ContactPerson,
    ownUid: string
  ): Promise<{ own: StoredCard | null; matches: StoredCard[] }>;
}

/**
 * Per-cycle view of the address books, so a cycle with many submissions lists each
 * book once instead of once per submission. Call `invalidate` for a book after
 * writing to it so the next lookup sees the new or changed card (and its new ETag).
 * Failures are never cached.
 */
export function createContactDirectory(
  nc: NextcloudConfig,
  configuredAddressbook: string,
  onSkippedBook: (addressbook: string, status: number) => void = () => {}
): ContactDirectory {
  let books: AddressbookInfo[] | null = null;
  const cards = new Map<string, StoredCard[]>();

  async function cardsOf(book: AddressbookInfo): Promise<StoredCard[]> {
    const cached = cards.get(book.name);
    if (cached) return cached;
    let listed: StoredCard[];
    try {
      listed = await listCards(nc, book.name, book.readOnly);
    } catch (error) {
      if (
        error instanceof NextcloudHttpError &&
        UNREADABLE_BOOK_STATUSES.has(error.status) &&
        book.name !== configuredAddressbook
      ) {
        onSkippedBook(book.name, error.status);
        listed = [];
      } else {
        throw error;
      }
    }
    cards.set(book.name, listed);
    return listed;
  }

  return {
    invalidate(addressbook) {
      cards.delete(addressbook);
    },
    async find(person, ownUid) {
      const matches: StoredCard[] = [];
      let current: string | null = null;
      try {
        books ??= await listAddressbooks(nc, configuredAddressbook);
        for (const book of books) {
          current = book.name;
          for (const card of await cardsOf(book)) {
            if (vCardUid(card.data) === ownUid) return { own: card, matches: [] };
            if (vCardMatches(card.data, person)) matches.push(card);
          }
        }
      } catch (error) {
        if (error instanceof NextcloudCircuitOpenError) throw error;
        if (error instanceof AddressbookDiscoveryError) throw error;
        throw new AddressbookDiscoveryError(error, current);
      }
      return { own: null, matches };
    },
  };
}

// ── vCard ────────────────────────────────────────────────────────────────────

// ── Labelled entries ─────────────────────────────────────────────────────────
// The billing sync reads these labels from a client's card; users add them in Nextcloud
// Contacts with "Add label > Custom". Contacts stores a custom label as an Apple-style group:
//   item1.EMAIL:billing@example.com
//   item1.X-ABLabel:Account email
// A TYPE parameter holding the same text is read too.
export const ACCOUNT_EMAIL_LABEL = "Account email";
export const ACCOUNT_PHONE_LABEL = "Account phone";
export const BILLING_ADDRESS_LABEL = "Billing address";

const normalizeLabel = (value: string) =>
  value
    .replace(/^_\$!<(.*)>!\$_$/, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");

/** The "group" of a line: the prefix before the dot in "item1.EMAIL", or null. */
function lineGroup(raw: string): string | null {
  const colon = raw.indexOf(":");
  const head = (colon === -1 ? raw : raw.slice(0, colon)).split(";")[0];
  const dot = head.lastIndexOf(".");
  return dot === -1 ? null : head.slice(0, dot).toLowerCase();
}

/** TYPE parameter values (and bare vCard 2.1 parameters) of a line, unquoted. */
function lineTypes(raw: string): string[] {
  const colon = raw.indexOf(":");
  const params = (colon === -1 ? raw : raw.slice(0, colon)).split(";").slice(1);
  const out: string[] = [];
  for (const param of params) {
    const eq = param.indexOf("=");
    const key = eq === -1 ? "TYPE" : param.slice(0, eq).toUpperCase();
    if (key !== "TYPE") continue;
    const value = eq === -1 ? param : param.slice(eq + 1);
    for (const part of value.split(",")) out.push(part.replace(/^"|"$/g, ""));
  }
  return out;
}

/** Whether a property line carries `label` (case-insensitive) as TYPE or via X-ABLabel. */
export function hasLabel(lines: VCardLine[], line: VCardLine, label: string): boolean {
  const wanted = normalizeLabel(label);
  if (lineTypes(line.raw).some((t) => normalizeLabel(t) === wanted)) return true;
  const group = lineGroup(line.raw);
  if (group === null) return false;
  return lines.some(
    (l) =>
      l.name === "X-ABLABEL" &&
      lineGroup(l.raw) === group &&
      normalizeLabel(unescapeVCardText(l.value)) === wanted
  );
}

/** The next unused item group ("item1", "item2", ...) on a card. */
function nextGroup(lines: VCardLine[]): string {
  const used = new Set(lines.map((l) => lineGroup(l.raw)).filter((g): g is string => g !== null));
  let n = 1;
  while (used.has(`item${n}`)) n++;
  return `item${n}`;
}

/** The two lines of an EMAIL entry labelled "Account email". */
export function accountEmailLines(email: string, group: string): string[] {
  return [`${group}.EMAIL:${escapeVCardText(email)}`, `${group}.X-ABLabel:${ACCOUNT_EMAIL_LABEL}`];
}

/** Case-insensitive, whitespace-collapsed, NFC form used for "exact" name matches. */
export function normalizeName(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

export function revStamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

export function serialize(lines: string[]): string {
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

export function nameParts(contactName: string): { family: string; given: string } {
  const parts = contactName.trim().split(/\s+/).filter(Boolean);
  const family = parts.length > 1 ? (parts.pop() as string) : "";
  return { family, given: parts.join(" ") };
}

export interface VCardLine {
  /** Property name without group, upper-case ("EMAIL"). */
  name: string;
  raw: string;
  value: string;
}

export function unescapeVCardText(value: string): string {
  return value.replace(/\\([\\,;nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

export function parseLines(card: string): VCardLine[] {
  return card
    .replace(/\r?\n[ \t]/g, "")
    .split(/\r?\n/)
    .filter((raw) => raw !== "")
    .map((raw) => {
      const colon = raw.indexOf(":");
      const head = colon === -1 ? raw : raw.slice(0, colon);
      const name = (head.split(";")[0].split(".").pop() ?? "").toUpperCase();
      return { name, raw, value: colon === -1 ? "" : raw.slice(colon + 1) };
    });
}

function textValues(lines: VCardLine[], name: string): string[] {
  return lines.filter((l) => l.name === name).map((l) => unescapeVCardText(l.value));
}

const digits = (value: string) => value.replace(/\D/g, "");

/** The organization name: ORG's first component, split before unescaping. */
export function orgName(lines: VCardLine[]): string | undefined {
  const line = lines.find((l) => l.name === "ORG");
  return line ? unescapeVCardText(line.value.split(/(?<!\\);/)[0]) : undefined;
}

export function vCardUid(card: string): string | null {
  return textValues(parseLines(card), "UID")[0]?.trim() || null;
}

/**
 * Whether an existing card is this client contact: by email when one was given,
 * otherwise by company (ORG) and, when given, the contact's name (FN).
 */
export function vCardMatches(card: string, person: ContactPerson): boolean {
  const lines = parseLines(card);
  if (person.email) {
    const wanted = person.email.trim().toLowerCase();
    return textValues(lines, "EMAIL").some((e) => e.trim().toLowerCase() === wanted);
  }
  const org = orgName(lines);
  if (org === undefined || normalizeName(org) !== normalizeName(person.company)) {
    return false;
  }
  if (!person.contactName) return true;
  const fn = textValues(lines, "FN")[0];
  return fn !== undefined && normalizeName(fn) === normalizeName(person.contactName);
}

/**
 * The card with ORG set to the company and the given name, email and phone added
 * where missing. Nothing is removed. Null when nothing would change, so a retry
 * makes no write.
 *
 * With `additive` (a card that is not ours) nothing existing is replaced: ORG and
 * FN/N are only set when the card has none, new email/phone values are appended, and
 * `category` is added to CATEGORIES.
 */
export function mergeContactVCard(
  card: string,
  person: ContactPerson,
  now: Date = new Date(),
  options: { additive?: boolean; category?: string; accountEmail?: string } = {}
): string | null {
  let lines = parseLines(card).filter((l) => l.name !== "END");
  let changed = false;
  const insert = (raw: string) => {
    lines.push({ name: "", raw, value: "" });
    changed = true;
  };

  const additive = options.additive === true;
  if (additive ? orgName(lines) === undefined : orgName(lines) !== person.company) {
    lines = lines.filter((l) => l.name !== "ORG");
    insert(`ORG:${escapeVCardText(person.company)}`);
  }
  if (
    person.contactName &&
    (additive
      ? textValues(lines, "FN")[0] === undefined
      : textValues(lines, "FN")[0] !== person.contactName)
  ) {
    const { family, given } = nameParts(person.contactName);
    lines = lines.filter((l) => l.name !== "FN" && l.name !== "N");
    insert(`FN:${escapeVCardText(person.contactName)}`);
    insert(`N:${escapeVCardText(family)};${escapeVCardText(given)};;;`);
  }
  if (person.email) {
    const wanted = person.email.trim().toLowerCase();
    if (!textValues(lines, "EMAIL").some((e) => e.trim().toLowerCase() === wanted)) {
      insert(`EMAIL;TYPE=WORK:${escapeVCardText(person.email)}`);
    }
  }
  if (options.accountEmail) {
    // The email the billing Customer is kept in sync with. A card that already has an entry
    // labelled "Account email" is left as it is: whoever set it wins.
    const hasAccountEmail = lines.some(
      (l) => l.name === "EMAIL" && hasLabel(lines, l, ACCOUNT_EMAIL_LABEL)
    );
    if (!hasAccountEmail) {
      for (const raw of accountEmailLines(options.accountEmail, nextGroup(lines))) insert(raw);
    }
  }
  if (person.phone && digits(person.phone)) {
    if (!textValues(lines, "TEL").some((t) => digits(t) === digits(person.phone as string))) {
      insert(`TEL;TYPE=WORK:${escapeVCardText(person.phone)}`);
    }
  }
  if (additive && options.category) {
    const wanted = options.category;
    const existing = lines.find((l) => l.name === "CATEGORIES");
    if (!existing) {
      insert(`CATEGORIES:${escapeVCardText(wanted)}`);
    } else if (
      !existing.value.split(",").some((c) => c.trim().toLowerCase() === wanted.toLowerCase())
    ) {
      existing.raw = `${existing.raw},${escapeVCardText(wanted)}`;
      existing.value = `${existing.value},${escapeVCardText(wanted)}`;
      changed = true;
    }
  }
  if (!changed) return null;
  lines = lines.filter((l) => l.name !== "REV");
  return serialize([...lines.map((l) => l.raw), `REV:${revStamp(now)}`, "END:VCARD"]);
}
