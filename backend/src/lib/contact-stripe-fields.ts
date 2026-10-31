import crypto from "node:crypto";
import { isValidEmail } from "./billing-customer";
import {
  ACCOUNT_EMAIL_LABEL,
  ACCOUNT_PHONE_LABEL,
  BILLING_ADDRESS_LABEL,
  hasLabel,
  orgName,
  parseLines,
  unescapeVCardText,
  type VCardLine,
} from "./nextcloud-contacts";

// Maps a Nextcloud contact card to the Stripe Customer fields it is kept in sync with, using
// Stripe's own names: name, email, phone, address. A field the card does not give clearly
// (blank, several unlabelled entries, an unusable value) is left out, so it is never pushed
// and never clears the Stripe value.

const STRIPE_FIELDS = ["name", "email", "phone", "address"] as const;
export type StripeField = (typeof STRIPE_FIELDS)[number];

export interface StripeAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
}

export interface MappedFields {
  name?: string;
  email?: string;
  phone?: string;
  address?: StripeAddress;
}

/** Why a field was left out; codes only, never values. */
export type FieldNote =
  | "email_ambiguous"
  | "email_invalid"
  | "phone_ambiguous"
  | "address_ambiguous"
  | "country_unmappable";

export interface MappedCard {
  fields: MappedFields;
  notes: FieldNote[];
  /** The card's REV as epoch ms, or null; orders edits made to cards sharing a Customer. */
  rev: number | null;
}

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : undefined;
};

/**
 * The single value to use from a property's entries: the one carrying `label`, else the only
 * entry. Several labelled entries (that differ) or several unlabelled ones with no label
 * give "ambiguous". Entries with the same value count once.
 */
function pickEntry<T>(
  entries: { line: VCardLine; value: T; key: string }[],
  lines: VCardLine[],
  label: string
): { status: "none" } | { status: "ambiguous" } | { status: "ok"; value: T } {
  if (!entries.length) return { status: "none" };
  const labelled = entries.filter((e) => hasLabel(lines, e.line, label));
  const pool = labelled.length ? labelled : entries;
  const distinct = new Map(pool.map((e) => [e.key, e.value]));
  if (distinct.size === 1) return { status: "ok", value: [...distinct.values()][0] };
  return { status: "ambiguous" };
}

// ── Country ──────────────────────────────────────────────────────────────────

const COUNTRY_ALIASES: Record<string, string> = {
  usa: "US",
  "u s a": "US",
  "u s": "US",
  us: "US",
  "united states of america": "US",
  america: "US",
  uk: "GB",
  "u k": "GB",
  "great britain": "GB",
  britain: "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  gbr: "GB",
  can: "CA",
  mex: "MX",
  aus: "AU",
  deu: "DE",
  fra: "FR",
  esp: "ES",
  ita: "IT",
  nld: "NL",
  irl: "IE",
  nzl: "NZ",
  ind: "IN",
  jpn: "JP",
  chn: "CN",
  bra: "BR",
  "korea south": "KR",
  "south korea": "KR",
  russia: "RU",
  "czech republic": "CZ",
  vietnam: "VN",
  holland: "NL",
};

// The officially assigned ISO 3166-1 alpha-2 codes (Stripe accepts these and no others).
const ISO_3166_ALPHA2 =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(
    " "
  );

let namesToCodes: Map<string, string> | null = null;

const normalizeCountry = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function countryTable(): Map<string, string> {
  if (namesToCodes) return namesToCodes;
  const table = new Map<string, string>();
  const display = new Intl.DisplayNames(["en"], { type: "region" });
  for (const code of ISO_3166_ALPHA2) {
    let name: string | undefined;
    try {
      name = display.of(code);
    } catch {
      continue;
    }
    if (name && name !== code) table.set(normalizeCountry(name), code);
  }
  namesToCodes = table;
  return table;
}

/** A 2-letter ISO 3166-1 code for a country name or code, or undefined when unknown. */
export function countryCode(value: string): string | undefined {
  const key = normalizeCountry(value);
  if (!key) return undefined;
  const alias = COUNTRY_ALIASES[key];
  if (alias) return alias;
  const table = countryTable();
  if (/^[a-z]{2}$/.test(key)) {
    const upper = key.toUpperCase();
    return ISO_3166_ALPHA2.includes(upper) ? upper : undefined;
  }
  return table.get(key);
}

// ── Address ──────────────────────────────────────────────────────────────────

/** Splits an ADR value at unescaped semicolons into its seven components, unescaped. */
function adrComponents(value: string): string[] {
  const parts = value.split(/(?<!\\);/).map((p) => unescapeVCardText(p));
  while (parts.length < 7) parts.push("");
  return parts;
}

function mapAddress(value: string, notes: FieldNote[]): StripeAddress | undefined {
  const [pobox, ext, street, locality, region, code, country] = adrComponents(value).map((p) =>
    clean(p.replace(/\s*\n\s*/g, ", "))
  );
  const address: StripeAddress = {};
  if (street) address.line1 = street;
  const line2 = [ext, pobox].filter(Boolean).join(", ");
  if (line2) address.line2 = line2;
  if (locality) address.city = locality;
  if (region) address.state = region;
  if (code) address.postal_code = code;
  if (country) {
    const iso = countryCode(country);
    if (iso) address.country = iso;
    else notes.push("country_unmappable");
  }
  return Object.keys(address).length ? address : undefined;
}

// ── Card ─────────────────────────────────────────────────────────────────────

function parseRev(lines: VCardLine[]): number | null {
  const value = lines.find((l) => l.name === "REV")?.value.trim();
  if (!value) return null;
  // 20261031T120000Z, 2026-10-31T12:00:00Z, 20261031
  const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:T(\d{2}):?(\d{2}):?(\d{2}))?/.exec(value);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  return Number.isNaN(ms) ? null : ms;
}

/** The Stripe fields a card maps to. See the module comment for the rules. */
export function mapCardToStripe(card: string): MappedCard {
  const lines = parseLines(card).filter((l) => l.name !== "END");
  const notes: FieldNote[] = [];
  const fields: MappedFields = {};

  const org = clean(orgName(lines));
  const fnLine = lines.find((l) => l.name === "FN");
  const fn = fnLine ? clean(unescapeVCardText(fnLine.value)) : undefined;
  const name = org ?? fn;
  if (name) fields.name = name;

  const emails = lines
    .filter((l) => l.name === "EMAIL")
    .map((line) => ({ line, value: clean(unescapeVCardText(line.value)) }))
    .filter((e): e is { line: VCardLine; value: string } => e.value !== undefined)
    .map((e) => ({ ...e, key: e.value.toLowerCase() }));
  const email = pickEntry(emails, lines, ACCOUNT_EMAIL_LABEL);
  if (email.status === "ambiguous") notes.push("email_ambiguous");
  else if (email.status === "ok") {
    if (isValidEmail(email.value)) fields.email = email.value;
    else notes.push("email_invalid");
  }

  const phones = lines
    .filter((l) => l.name === "TEL")
    .map((line) => ({ line, value: clean(unescapeVCardText(line.value)) }))
    .filter((e): e is { line: VCardLine; value: string } => e.value !== undefined)
    .map((e) => ({ ...e, key: e.value.replace(/\D/g, "") || e.value }));
  const phone = pickEntry(phones, lines, ACCOUNT_PHONE_LABEL);
  if (phone.status === "ambiguous") notes.push("phone_ambiguous");
  else if (phone.status === "ok") fields.phone = phone.value;

  const addresses = lines
    .filter((l) => l.name === "ADR")
    .filter((line) => line.value.replace(/[;\s]/g, "") !== "")
    .map((line) => ({ line, value: line.value, key: line.value.trim() }));
  const adr = pickEntry(addresses, lines, BILLING_ADDRESS_LABEL);
  if (adr.status === "ambiguous") notes.push("address_ambiguous");
  else if (adr.status === "ok") {
    const address = mapAddress(adr.value, notes);
    if (address) fields.address = address;
  }

  return { fields, notes, rev: parseRev(lines) };
}

// ── Hashes ───────────────────────────────────────────────────────────────────

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

/** Per-field hashes (null for a field the card does not give). Holds no contact details. */
export function fieldHashes(fields: MappedFields): Record<StripeField, string | null> {
  const hash = (value: unknown) => (value === undefined ? null : sha256(JSON.stringify(value)));
  return {
    name: hash(fields.name),
    email: hash(fields.email),
    phone: hash(fields.phone),
    address: hash(
      fields.address === undefined
        ? undefined
        : Object.fromEntries(Object.entries(fields.address).sort(([a], [b]) => a.localeCompare(b)))
    ),
  };
}

export function combinedHash(hashes: Record<string, string | null>): string {
  return sha256(JSON.stringify(STRIPE_FIELDS.map((f) => hashes[f] ?? null)));
}

/**
 * The fields to push: those the card gives now whose hash differs from the recorded one.
 * A field that went blank is not here (a blank never clears a Stripe value).
 */
export function changedFields(
  fields: MappedFields,
  current: Record<StripeField, string | null>,
  recorded: Record<string, string | null> | null
): MappedFields {
  const changed: MappedFields = {};
  for (const field of STRIPE_FIELDS) {
    if (fields[field] === undefined) continue;
    if (current[field] !== (recorded?.[field] ?? null)) {
      (changed as Record<string, unknown>)[field] = fields[field];
    }
  }
  return changed;
}
