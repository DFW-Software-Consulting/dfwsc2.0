// Pure mapping for the "DFWSC — Convert Won Lead to Client" onboarding: Forms
// answers to a client folder name, a contact card, a Client Projects row, a
// Collectives page and a Sales Pipeline match. No I/O here.
//
// Form questions are matched by their technical name (Forms "name"), table columns
// by exact title. A missing name or title stops the automation with one error log
// instead of writing into the wrong cells.

import {
  escapeVCardText,
  findOptionId,
  foldLine,
  parseDate,
  sanitizeFolderName,
  type TableColumn,
} from "./sales-lead-mapping";

const INTAKE_QUESTION_NAMES = {
  company: "company",
  contactName: "contact_name",
  email: "email",
  phone: "phone",
  projectName: "project_name",
  startDate: "start_date",
  targetDate: "target_date",
  summary: "summary",
  leadLink: "lead_link",
} as const;

const PROJECT_COLUMN_TITLES = {
  projectCode: "Project Code",
  projectName: "Project Name",
  status: "Status",
  owner: "Owner",
  startDate: "Start Date",
  targetDate: "Target Date",
  projectFolder: "Project Folder",
  projectPage: "Project Page",
  intakeSubmission: "Intake Submission",
  summary: "Summary",
} as const;

const PIPELINE_COLUMN_TITLES = {
  company: "Company",
  stage: "Stage",
  // Renamed from "Cerebo Project"; both titles are accepted (the first one is preferred).
  clientProject: ["Client Project", "Cerebo Project"],
} as const;

const INTAKE_STATUS = "Intake";
export const WON_STAGE = "Won";
// Live table 8 (Sales Pipeline) Stage option ids: 0 New Lead, 1 Contacted, 2 Qualified,
// 3 Proposal Sent, 4 Won, 5 Lost, 6 Nurture. Every stage except Won and Lost is open
// (as in the "Open Pipeline" view), so only those may be promoted to Won. Lost, an
// empty stage and any other id are left alone and flagged.
export const WON_STAGE_ID = 4;
export const PROMOTABLE_STAGE_IDS: ReadonlySet<number> = new Set([0, 1, 2, 3, 6]);

/** The option id in a Stage cell, or null when it is empty or not a number. */
export function stageOptionId(cell: unknown): number | null {
  if (typeof cell === "number") return Number.isInteger(cell) ? cell : null;
  if (typeof cell === "string" && /^\d+$/.test(cell.trim())) return Number(cell.trim());
  return null;
}
const SUBFOLDERS = ["Meetings", "Decisions", "Deliverables"] as const;
export const CLIENT_SUBFOLDERS: readonly string[] = SUBFOLDERS;

type IntakeField = keyof typeof INTAKE_QUESTION_NAMES;
type ProjectField = keyof typeof PROJECT_COLUMN_TITLES;
type PipelineField = keyof typeof PIPELINE_COLUMN_TITLES;

/** A misconfigured form, table or collective. `detail` holds names/titles only. */
export class OnboardingConfigError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string[] = []
  ) {
    super(detail.length ? `${code}: ${detail.join(", ")}` : code);
    this.name = "OnboardingConfigError";
  }
}

/** A submission that can never be processed as given. */
export class OnboardingInvalidError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OnboardingInvalidError";
  }
}

// ── Form ─────────────────────────────────────────────────────────────────────

export interface IntakeQuestion {
  id: number;
  /** Forms technical name. */
  name: string;
}

export interface IntakeAnswer {
  questionId: number;
  text: string;
}

export interface Intake {
  company: string;
  projectName: string;
  summary: string;
  contactName?: string;
  email?: string;
  phone?: string;
  startDate?: string;
  targetDate?: string;
  leadLink?: string;
}

export type IntakeQuestionMap = Record<IntakeField, number>;

export function resolveIntakeQuestions(questions: IntakeQuestion[]): IntakeQuestionMap {
  const byName = new Map(questions.map((q) => [q.name.trim(), q.id]));
  const missing: string[] = [];
  const map = {} as IntakeQuestionMap;
  for (const [field, name] of Object.entries(INTAKE_QUESTION_NAMES) as [IntakeField, string][]) {
    const id = byName.get(name);
    if (id === undefined) missing.push(name);
    else map[field] = id;
  }
  if (missing.length) throw new OnboardingConfigError("form_questions_missing", missing);
  return map;
}

export function extractIntake(answers: IntakeAnswer[], questions: IntakeQuestionMap): Intake {
  const textFor = (field: IntakeField): string | undefined => {
    const parts = answers
      .filter((a) => a.questionId === questions[field])
      .map((a) => a.text.trim())
      .filter(Boolean);
    return parts.length ? parts.join(", ") : undefined;
  };
  const company = textFor("company");
  if (!company) throw new OnboardingInvalidError("missing_company");
  const projectName = textFor("projectName");
  if (!projectName) throw new OnboardingInvalidError("missing_project_name");
  const summary = textFor("summary");
  if (!summary) throw new OnboardingInvalidError("missing_summary");
  const intake: Intake = { company, projectName, summary };
  for (const field of [
    "contactName",
    "email",
    "phone",
    "startDate",
    "targetDate",
    "leadLink",
  ] as const) {
    const value = textFor(field);
    if (value !== undefined) intake[field] = value;
  }
  return intake;
}

/** Forms stores anonymous submitters as "anon-user-<hash>": not a Nextcloud user. */
export function isNextcloudUser(userId: string | null | undefined): userId is string {
  return typeof userId === "string" && userId.trim() !== "" && !userId.startsWith("anon-user-");
}

// ── Names ────────────────────────────────────────────────────────────────────

/** Case-insensitive, whitespace-collapsed, NFC form used for "exact" name matches. */
export function normalizeName(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

export function clientFolderName(company: string, submissionId: number): string {
  return sanitizeFolderName(company, submissionId, "Client");
}

// ── Project codes ────────────────────────────────────────────────────────────

export function formatProjectCode(n: number): string {
  return `CP-${String(n).padStart(3, "0")}`;
}

/** 7 for "CP-007"; undefined for anything else. */
export function parseProjectNumber(code: unknown): number | undefined {
  if (typeof code !== "string") return undefined;
  const match = /^CP-(\d{1,9})$/.exec(code.trim());
  return match ? Number(match[1]) : undefined;
}

// ── Tables ───────────────────────────────────────────────────────────────────

export type ProjectColumnMap = Record<ProjectField, TableColumn>;
export type PipelineColumnMap = Record<PipelineField, TableColumn>;

function resolveByTitle<F extends string>(
  columns: TableColumn[],
  titles: Record<F, string | readonly string[]>,
  code: string
): Record<F, TableColumn> {
  const byTitle = new Map(columns.map((c) => [c.title.trim(), c]));
  const missing: string[] = [];
  const map = {} as Record<F, TableColumn>;
  for (const [field, accepted] of Object.entries(titles) as [F, string | readonly string[]][]) {
    const candidates = typeof accepted === "string" ? [accepted] : accepted;
    const column = candidates.map((t) => byTitle.get(t)).find((c) => c !== undefined);
    if (!column) missing.push(candidates[0]);
    else map[field] = column;
  }
  if (missing.length) throw new OnboardingConfigError(code, missing);
  return map;
}

export function resolveProjectColumns(columns: TableColumn[]): ProjectColumnMap {
  const map = resolveByTitle(columns, PROJECT_COLUMN_TITLES, "project_columns_missing");
  if (findOptionId(map.status, INTAKE_STATUS) === undefined) {
    throw new OnboardingConfigError("status_option_missing", [INTAKE_STATUS]);
  }
  return map;
}

export function resolvePipelineColumns(columns: TableColumn[]): PipelineColumnMap {
  const map = resolveByTitle(columns, PIPELINE_COLUMN_TITLES, "pipeline_columns_missing");
  if (findOptionId(map.stage, WON_STAGE) === undefined) {
    throw new OnboardingConfigError("stage_option_missing", [WON_STAGE]);
  }
  return map;
}

export function selectionValue(column: TableColumn, label: string): number | number[] {
  const id = findOptionId(column, label) as number;
  return column.subtype === "multi" ? [id] : id;
}

/** Projects row as first created. Links are written afterwards and read back. */
export function buildProjectRowData(
  intake: Intake,
  columns: ProjectColumnMap,
  projectCode: string,
  ownerUserId: string | null
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    [columns.projectCode.id]: projectCode,
    [columns.projectName.id]: intake.projectName,
    [columns.status.id]: selectionValue(columns.status, INTAKE_STATUS),
    [columns.summary.id]: intake.summary,
  };
  if (ownerUserId) data[columns.owner.id] = [{ id: ownerUserId, type: 0 }];
  const start = intake.startDate ? parseDate(intake.startDate) : undefined;
  if (start) data[columns.startDate.id] = start;
  const target = intake.targetDate ? parseDate(intake.targetDate) : undefined;
  if (target) data[columns.targetDate.id] = target;
  return data;
}

// ── Lead link ────────────────────────────────────────────────────────────────

export type LeadReference =
  | { kind: "row"; tableId: number | null; rowId: number }
  | { kind: "name"; name: string };

/**
 * A Tables row link (".../apps/tables/#/table/8/row/12" or ".../#/view/3/row/12")
 * or, failing that, a company name. Anything else that looks like a URL is
 * returned as a name and will not match a Company, so it is flagged, not guessed.
 */
export function parseLeadReference(leadLink: string | undefined, company: string): LeadReference {
  const text = leadLink?.trim();
  if (!text) return { kind: "name", name: company };
  const match = /#\/(?:table\/(\d+)|view\/\d+)\/row\/(\d+)(?:[/?#]|$)/.exec(text);
  if (match) {
    return {
      kind: "row",
      tableId: match[1] === undefined ? null : Number(match[1]),
      rowId: Number(match[2]),
    };
  }
  return { kind: "name", name: text };
}

// ── vCard ────────────────────────────────────────────────────────────────────

export function clientContactUid(formId: number, submissionId: number): string {
  return `dfwsc-client-${formId}-${submissionId}`;
}

function revStamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function serialize(lines: string[]): string {
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

function nameParts(contactName: string): { family: string; given: string } {
  const parts = contactName.trim().split(/\s+/).filter(Boolean);
  const family = parts.length > 1 ? (parts.pop() as string) : "";
  return { family, given: parts.join(" ") };
}

/** A new card with only the fields the submission gave; ORG is always the company. */
export function buildClientVCard(intake: Intake, uid: string, now: Date = new Date()): string {
  const fn = intake.contactName ?? intake.company;
  const { family, given } = nameParts(intake.contactName ?? "");
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "PRODID:-//DFW Software Consulting//Client Onboarding//EN",
    `UID:${uid}`,
    `FN:${escapeVCardText(fn)}`,
    `N:${escapeVCardText(family)};${escapeVCardText(given)};;;`,
    `ORG:${escapeVCardText(intake.company)}`,
  ];
  if (intake.email) lines.push(`EMAIL;TYPE=WORK:${escapeVCardText(intake.email)}`);
  if (intake.phone) lines.push(`TEL;TYPE=WORK:${escapeVCardText(intake.phone)}`);
  lines.push("CATEGORIES:Client", `REV:${revStamp(now)}`, "END:VCARD");
  return serialize(lines);
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
export function vCardMatches(card: string, intake: Intake): boolean {
  const lines = parseLines(card);
  if (intake.email) {
    const wanted = intake.email.trim().toLowerCase();
    return textValues(lines, "EMAIL").some((e) => e.trim().toLowerCase() === wanted);
  }
  const org = orgName(lines);
  if (org === undefined || normalizeName(org) !== normalizeName(intake.company)) {
    return false;
  }
  if (!intake.contactName) return true;
  const fn = textValues(lines, "FN")[0];
  return fn !== undefined && normalizeName(fn) === normalizeName(intake.contactName);
}

/**
 * The card with ORG set to the company and the given name, email and phone added
 * where missing. Nothing is removed. Null when nothing would change, so a retry
 * makes no write.
 */
export function mergeClientVCard(
  card: string,
  intake: Intake,
  now: Date = new Date()
): string | null {
  let lines = parseLines(card).filter((l) => l.name !== "END");
  let changed = false;
  const insert = (raw: string) => {
    lines.push({ name: "", raw, value: "" });
    changed = true;
  };

  if (orgName(lines) !== intake.company) {
    lines = lines.filter((l) => l.name !== "ORG");
    insert(`ORG:${escapeVCardText(intake.company)}`);
  }
  if (intake.contactName && textValues(lines, "FN")[0] !== intake.contactName) {
    const { family, given } = nameParts(intake.contactName);
    lines = lines.filter((l) => l.name !== "FN" && l.name !== "N");
    insert(`FN:${escapeVCardText(intake.contactName)}`);
    insert(`N:${escapeVCardText(family)};${escapeVCardText(given)};;;`);
  }
  if (intake.email) {
    const wanted = intake.email.trim().toLowerCase();
    if (!textValues(lines, "EMAIL").some((e) => e.trim().toLowerCase() === wanted)) {
      insert(`EMAIL;TYPE=WORK:${escapeVCardText(intake.email)}`);
    }
  }
  if (intake.phone && digits(intake.phone)) {
    if (!textValues(lines, "TEL").some((t) => digits(t) === digits(intake.phone as string))) {
      insert(`TEL;TYPE=WORK:${escapeVCardText(intake.phone)}`);
    }
  }
  if (!changed) return null;
  lines = lines.filter((l) => l.name !== "REV");
  return serialize([...lines.map((l) => l.raw), `REV:${revStamp(now)}`, "END:VCARD"]);
}

// ── Collectives ──────────────────────────────────────────────────────────────

/** "CP-003 — Warehouse Portal"; the name is made safe for a file name. */
export function projectPageTitle(code: string, projectName: string, submissionId: number): string {
  return `${code} — ${sanitizeFolderName(projectName, submissionId, "Project")}`;
}

/** URL slug like Collectives': ASCII letters and digits, other runs become "-". */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function markdownText(value: string): string {
  return value.replace(/\s+/g, " ").replace(/([\\`*_[\]<>#])/g, "\\$1");
}

function tableCell(value: string): string {
  return markdownText(value).replace(/\|/g, "\\|").trim();
}

/**
 * Page body: the team's Project Brief template (Client Projects/Templates/Project-Brief.md)
 * filled with what the form knows, plus our links as extra rows. Owner, Success
 * criteria and Constraints stay blank for the team. No contact details.
 */
export function projectBriefContent(input: {
  projectCode: string;
  summary: string;
  /** Target date as YYYY-MM-DD; omitted or empty leaves the cell blank. */
  targetDate?: string;
  rowUrl: string;
  folderUrl: string;
  intakeTitle: string;
  intakeUrl: string;
}): string {
  return [
    "# Project Brief",
    "",
    "> This is the DFWSC client-projects workspace; real client data is allowed. Do not store credentials, Stripe data, or production secrets.",
    "",
    "| Field | Value |",
    "|---|---|",
    `| Project code | ${tableCell(input.projectCode)} |`,
    `| Purpose | ${tableCell(input.summary)} |`,
    "| Owner | |",
    `| Target date | ${input.targetDate ?? ""} |`,
    "| Success criteria | |",
    "| Constraints | |",
    `| Project row | [Project row](${input.rowUrl}) |`,
    `| Client folder | [Client folder](${input.folderUrl}) |`,
    `| Intake results | [${markdownText(input.intakeTitle)}](${input.intakeUrl}) |`,
    "",
  ].join("\n");
}
