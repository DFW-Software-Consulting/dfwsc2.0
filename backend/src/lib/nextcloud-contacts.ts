import { encodePathSegments, type NextcloudConfig, nextcloudRequest } from "./nextcloud";
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
}

/** A card changed between our read and our write (If-Match failed); retried. */
export class ContactChangedError extends Error {
  constructor() {
    super("The contact card changed while it was being updated");
    this.name = "ContactChangedError";
  }
}

/** Looking for an existing contact across address books failed; retried, never skipped. */
export class AddressbookDiscoveryError extends Error {
  constructor() {
    super("The address books could not be searched for an existing contact");
    this.name = "AddressbookDiscoveryError";
  }
}

/** Address books the server generates itself (not user data, not writable). */
const SYSTEM_ADDRESSBOOK = /^z-server-generated/i;

const ADDRESSBOOK_HOME_PROPFIND =
  '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';
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

/**
 * Every address book the service account can see: its own and those shared with it
 * (PROPFIND Depth:1 on the home). Server-generated system books are left out. The
 * configured book is always included, so a listing that omits it still searches it.
 */
async function listAddressbooks(
  nc: NextcloudConfig,
  configuredAddressbook: string
): Promise<string[]> {
  const home = addressbookHome(nc);
  const res = await nextcloudRequest(nc, {
    method: "PROPFIND",
    label: "carddav.list_addressbooks",
    path: home,
    headers: { depth: "1", "content-type": "application/xml; charset=utf-8" },
    body: ADDRESSBOOK_HOME_PROPFIND,
  });
  const names = new Set<string>([configuredAddressbook]);
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
    if (!SYSTEM_ADDRESSBOOK.test(name)) names.add(name);
  }
  return [...names];
}

async function listCards(nc: NextcloudConfig, addressbook: string): Promise<StoredCard[]> {
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
    cards.push({ addressbook, href, etag: xmlElement(block, "getetag")?.trim() || null, data });
  }
  return cards;
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

/**
 * The card(s) that could be this person, from every address book the account can see.
 * A card carrying `ownUid` (the one this very submission created on an earlier
 * attempt) is returned alone as `own`, so a retry never goes ambiguous against its
 * own card. Any failure to list a book becomes AddressbookDiscoveryError: skipping a
 * book would let the caller create a duplicate of a card that lives there.
 */
export async function findContactCards(
  nc: NextcloudConfig,
  configuredAddressbook: string,
  person: ContactPerson,
  ownUid: string
): Promise<{ own: StoredCard | null; matches: StoredCard[] }> {
  const matches: StoredCard[] = [];
  try {
    for (const addressbook of await listAddressbooks(nc, configuredAddressbook)) {
      for (const card of await listCards(nc, addressbook)) {
        if (vCardUid(card.data) === ownUid) return { own: card, matches: [] };
        if (vCardMatches(card.data, person)) matches.push(card);
      }
    }
  } catch {
    throw new AddressbookDiscoveryError();
  }
  return { own: null, matches };
}

// ── vCard ────────────────────────────────────────────────────────────────────

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

interface VCardLine {
  /** Property name without group, upper-case ("EMAIL"). */
  name: string;
  raw: string;
  value: string;
}

function unescapeVCardText(value: string): string {
  return value.replace(/\\([\\,;nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

function parseLines(card: string): VCardLine[] {
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
function orgName(lines: VCardLine[]): string | undefined {
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
 */
export function mergeContactVCard(
  card: string,
  person: ContactPerson,
  now: Date = new Date()
): string | null {
  let lines = parseLines(card).filter((l) => l.name !== "END");
  let changed = false;
  const insert = (raw: string) => {
    lines.push({ name: "", raw, value: "" });
    changed = true;
  };

  if (orgName(lines) !== person.company) {
    lines = lines.filter((l) => l.name !== "ORG");
    insert(`ORG:${escapeVCardText(person.company)}`);
  }
  if (person.contactName && textValues(lines, "FN")[0] !== person.contactName) {
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
  if (person.phone && digits(person.phone)) {
    if (!textValues(lines, "TEL").some((t) => digits(t) === digits(person.phone as string))) {
      insert(`TEL;TYPE=WORK:${escapeVCardText(person.phone)}`);
    }
  }
  if (!changed) return null;
  lines = lines.filter((l) => l.name !== "REV");
  return serialize([...lines.map((l) => l.raw), `REV:${revStamp(now)}`, "END:VCARD"]);
}
