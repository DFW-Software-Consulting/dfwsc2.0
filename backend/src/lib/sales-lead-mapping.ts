// Pure mapping for the "DFWSC — New Lead" automation: Forms answers to a Sales
// Pipeline row, a vCard and a lead folder name. No I/O here.
//
// Questions and columns are matched by their exact titles, never by id, so a
// question or column deleted and recreated in Nextcloud keeps working. A title
// that is missing is a configuration error that stops the automation loudly
// rather than writing a lead into the wrong cells.

export const LEAD_QUESTION_TITLES = {
  company: "Company",
  contactName: "Contact name",
  email: "Email",
  phone: "Phone",
  source: "Source",
  temperature: "Temperature",
  estimatedValue: "Estimated value",
  nextFollowUp: "Next follow-up",
  notes: "Notes",
} as const;

const PIPELINE_COLUMN_TITLES = {
  company: "Company",
  contactName: "Contact Name",
  contactCard: "Contact Card",
  stage: "Stage",
  temperature: "Temperature",
  source: "Source",
  estimatedValue: "Estimated Value",
  nextFollowUp: "Next Follow-up",
  notesFiles: "Notes / Files",
  summary: "Summary",
  leadRef: "Lead Ref",
} as const;

// Owner (a user column) is deliberately left empty: the submitter is whoever filled
// in the form, which is not necessarily the lead's owner, and a wrong owner is worse
// than a blank one the operator fills in.

const NEW_LEAD_STAGE = "New Lead";

type LeadField = keyof typeof LEAD_QUESTION_TITLES;
type PipelineField = keyof typeof PIPELINE_COLUMN_TITLES;

/** A misconfigured form or table. `detail` contains titles only, never answer data. */
export class SalesLeadConfigError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string[] = []
  ) {
    super(detail.length ? `${code}: ${detail.join(", ")}` : code);
    this.name = "SalesLeadConfigError";
  }
}

/** A submission that can never be processed as given (e.g. no company). */
export class SalesLeadInvalidError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SalesLeadInvalidError";
  }
}

export interface FormQuestion {
  id: number;
  text: string;
}

export interface FormAnswer {
  questionId: number;
  text: string;
}

export interface Lead {
  company: string;
  contactName?: string;
  email?: string;
  phone?: string;
  source?: string;
  temperature?: string;
  estimatedValue?: string;
  nextFollowUp?: string;
  notes?: string;
}

export type QuestionMap = Record<LeadField, number>;

export function resolveQuestions(questions: FormQuestion[]): QuestionMap {
  const byTitle = new Map(questions.map((q) => [q.text.trim(), q.id]));
  const missing: string[] = [];
  const map = {} as QuestionMap;
  for (const [field, title] of Object.entries(LEAD_QUESTION_TITLES) as [LeadField, string][]) {
    const id = byTitle.get(title);
    if (id === undefined) missing.push(title);
    else map[field] = id;
  }
  if (missing.length) throw new SalesLeadConfigError("form_questions_missing", missing);
  return map;
}

export function extractLead(answers: FormAnswer[], questions: QuestionMap): Lead {
  const textFor = (field: LeadField): string | undefined => {
    const parts = answers
      .filter((a) => a.questionId === questions[field])
      .map((a) => a.text.trim())
      .filter(Boolean);
    return parts.length ? parts.join(", ") : undefined;
  };
  const company = textFor("company");
  if (!company) throw new SalesLeadInvalidError("missing_company");
  const lead: Lead = { company };
  for (const field of Object.keys(LEAD_QUESTION_TITLES) as LeadField[]) {
    if (field === "company") continue;
    const value = textFor(field);
    if (value !== undefined) lead[field] = value;
  }
  return lead;
}

export function hasPerson(lead: Lead): boolean {
  return Boolean(lead.contactName || lead.email || lead.phone);
}

// ── Tables ───────────────────────────────────────────────────────────────────

export interface TableColumn {
  id: number;
  title: string;
  type: string;
  subtype?: string | null;
  selectionOptions?: { id: number; label: string }[] | string | null;
}

export type ColumnMap = Record<PipelineField, TableColumn>;

export function resolveColumns(columns: TableColumn[]): ColumnMap {
  const byTitle = new Map(columns.map((c) => [c.title.trim(), c]));
  const missing: string[] = [];
  const map = {} as ColumnMap;
  for (const [field, title] of Object.entries(PIPELINE_COLUMN_TITLES) as [
    PipelineField,
    string,
  ][]) {
    const column = byTitle.get(title);
    if (!column) missing.push(title);
    else map[field] = column;
  }
  if (missing.length) throw new SalesLeadConfigError("table_columns_missing", missing);
  if (findOptionId(map.stage, NEW_LEAD_STAGE) === undefined) {
    throw new SalesLeadConfigError("stage_option_missing", [NEW_LEAD_STAGE]);
  }
  return map;
}

function selectionOptions(column: TableColumn): { id: number; label: string }[] {
  const raw = column.selectionOptions;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as { id: number; label: string }[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function findOptionId(column: TableColumn, label: string): number | undefined {
  const wanted = label.trim().toLowerCase();
  return selectionOptions(column).find((o) => o.label.trim().toLowerCase() === wanted)?.id;
}

/** "$12,500.50" → 12500.5; undefined when the text holds no single number. */
export function parseEstimatedValue(text: string): number | undefined {
  const cleaned = text.replace(/[$,\s]/g, "").replace(/usd$/i, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return undefined;
  return Number(cleaned);
}

/** Forms date answers are "YYYY-MM-DD"; a full ISO timestamp is cut to its date. */
export function parseDate(text: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text.trim());
  if (!match) return undefined;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1) return undefined;
  if (date.getUTCDate() !== Number(d) || Number(y) < 1) return undefined;
  return `${y}-${m}-${d}`;
}

function cellValue(column: TableColumn, text: string): unknown {
  switch (column.type) {
    case "selection": {
      const id = findOptionId(column, text);
      if (id === undefined) return undefined;
      return column.subtype === "multi" ? [id] : id;
    }
    case "number":
      return parseEstimatedValue(text);
    case "datetime":
      return parseDate(text);
    default:
      return text;
  }
}

export function leadRef(formId: number, submissionId: number): string {
  return `${formId}:${submissionId}`;
}

export interface RowData {
  data: Record<string, unknown>;
  /** Pipeline fields whose answer could not be stored (unknown option, unparseable value). */
  dropped: string[];
}

export function buildRowData(lead: Lead, columns: ColumnMap, ref: string): RowData {
  const data: Record<string, unknown> = {
    [columns.company.id]: lead.company,
    [columns.stage.id]: cellValue(columns.stage, NEW_LEAD_STAGE),
    [columns.leadRef.id]: ref,
  };
  const dropped: string[] = [];
  const optional: [PipelineField, string | undefined][] = [
    ["contactName", lead.contactName],
    ["source", lead.source],
    ["temperature", lead.temperature],
    ["estimatedValue", lead.estimatedValue],
    ["nextFollowUp", lead.nextFollowUp],
    ["summary", lead.notes],
  ];
  for (const [field, text] of optional) {
    if (text === undefined) continue;
    const value = cellValue(columns[field], text);
    if (value === undefined) dropped.push(field);
    else data[columns[field].id] = value;
  }
  return { data, dropped };
}

/**
 * Value for a Tables text-link cell. Tables 2.4 persists "Title (url)"; the JSON
 * {title, value, providerId} form is answered with 200 but not stored.
 */
export function linkValue(title: string, url: string): string {
  return `${title} (${url})`;
}

/**
 * URL held by a stored Tables link cell, or null when the cell is empty. Tables
 * stores "Title (url)" as a JSON string {title, value, providerId} (slashes
 * escaped); any other string is returned as is.
 */
export function linkCellUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { value?: unknown }).value === "string"
    ) {
      return (parsed as { value: string }).value;
    }
  } catch {
    // Not JSON: fall back to the raw string.
  }
  return value;
}

// ── vCard ────────────────────────────────────────────────────────────────────

export function contactUid(formId: number, submissionId: number): string {
  return `dfwsc-lead-${formId}-${submissionId}`;
}

function escapeVCardText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

// RFC 6350 §3.2: lines longer than 75 octets are folded with CRLF + one space,
// never splitting a multi-byte UTF-8 character.
function foldLine(line: string): string {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char);
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n ");
}

export function buildVCard(lead: Lead, uid: string, now: Date = new Date()): string {
  const name = lead.contactName ?? lead.email ?? lead.phone ?? lead.company;
  const parts = (lead.contactName ?? "").trim().split(/\s+/).filter(Boolean);
  const family = parts.length > 1 ? (parts.pop() as string) : "";
  const given = parts.join(" ");
  const rev = `${now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "")}`;
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "PRODID:-//DFW Software Consulting//Sales Lead Automation//EN",
    `UID:${uid}`,
    `FN:${escapeVCardText(name)}`,
    `N:${escapeVCardText(family)};${escapeVCardText(given)};;;`,
    `ORG:${escapeVCardText(lead.company)}`,
  ];
  if (lead.email) lines.push(`EMAIL;TYPE=WORK:${escapeVCardText(lead.email)}`);
  if (lead.phone) lines.push(`TEL;TYPE=WORK:${escapeVCardText(lead.phone)}`);
  lines.push("CATEGORIES:Lead", `REV:${rev}`, "END:VCARD");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

// ── Folder ───────────────────────────────────────────────────────────────────

const MAX_FOLDER_NAME_LENGTH = 100;

/**
 * A single safe path segment from the company name: no path separators, the
 * characters Windows and Nextcloud clients reject, control characters or a leading
 * dot. Falls back to "Lead <submissionId>" when nothing usable is left.
 */
export function sanitizeFolderName(company: string, submissionId: number): string {
  const cleaned = company
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  const truncated = Array.from(cleaned)
    .slice(0, MAX_FOLDER_NAME_LENGTH)
    .join("")
    .replace(/[.\s]+$/, "");
  if (!truncated) return `Lead ${submissionId}`;
  return truncated;
}

/** "Acme", "Acme (2)", "Acme (3)", ... */
export function folderNameCandidate(base: string, attempt: number): string {
  return attempt <= 1 ? base : `${base} (${attempt})`;
}
