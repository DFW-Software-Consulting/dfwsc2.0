import type { IntakeAnswer, IntakeQuestion } from "./client-onboarding-mapping";
import { encodePathSegments, type NextcloudConfig, nextcloudRequest } from "./nextcloud";
import {
  addressbookCollection,
  createContactDirectory,
  type StoredCard,
  updateCard,
} from "./nextcloud-contacts";
import type { TableColumn } from "./sales-lead-mapping";
import {
  NextcloudBadResponseError,
  ocsData,
  parseJson,
  positiveInt,
  SUBMISSION_PAGE_SIZE,
} from "./sales-lead-nextcloud";

// Thin wrappers around the Nextcloud APIs the client onboarding uses: Forms v3,
// Tables v1, CardDAV, WebDAV and Collectives (OCS v1.0). Every call goes through
// nextcloudRequest (shared breaker, timeout) with a fixed, PII-free label.

export interface ClientOnboardingTargets {
  formId: number;
  projectsTableId: number;
  pipelineTableId: number;
  /** Address book collection name as the service account sees it. */
  addressbookPath: string;
  /** Parent of the client folders, relative to the service account's files root. */
  clientsFolder: string[];
  collectiveId: number;
}

export interface IntakeForm {
  hash: string;
  questions: IntakeQuestion[];
}

export interface IntakeSubmission {
  id: number;
  userId: string | null;
  answers: IntakeAnswer[];
}

export interface TableRow {
  id: number;
  tableId: number | null;
  cells: Map<number, unknown>;
}

export interface Team {
  id: string;
  name: string;
  /** The service account's level in the team (8 admin, 9 owner); 0 when not a member. */
  initiatorLevel: number;
}

export interface TeamMember {
  /** Member id, used to change the level. */
  id: string;
  userId: string;
  /** 1 for a local user. */
  userType: number;
  level: number;
}

export interface CollectiveSummary {
  id: number;
  name: string;
  slug: string | null;
  circleId: string | null;
}

export interface FolderShare {
  id: number;
  shareType: number;
  shareWith: string;
}

export interface CollectivePage {
  id: number;
  parentId: number;
  title: string;
  slug: string | null;
  fileName: string;
  filePath: string;
  collectivePath: string | null;
}

const FORMS_BASE = "/ocs/v2.php/apps/forms/api/v3/forms";
const TABLES_BASE = "/index.php/apps/tables/api/1";
const COLLECTIVES_BASE = "/ocs/v2.php/apps/collectives/api/v1.0/collectives";
const CIRCLES_BASE = "/ocs/v2.php/apps/circles";
const SHARES_BASE = "/ocs/v2.php/apps/files_sharing/api/v1/shares";
/** files_sharing shareType for a Team (Circle). */
const SHARE_TYPE_TEAM = 7;
/** Read, update, create, delete; no reshare (16). */
export const TEAM_SHARE_PERMISSIONS = 15;
/** Circles member levels. */
export const TEAM_LEVEL_ADMIN = 8;
/** Circles member type for a local user. */
const TEAM_MEMBER_TYPE_USER = 1;
const ROW_PAGE_SIZE = 200;
const MAX_ROW_PAGES = 50;

const PROPFIND_FILEID =
  '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/></d:prop></d:propfind>';
function toPage(raw: unknown, label: string): CollectivePage {
  const p = (raw ?? {}) as Record<string, unknown>;
  return {
    id: positiveInt(p.id, label),
    parentId: typeof p.parentId === "number" ? p.parentId : 0,
    title: typeof p.title === "string" ? p.title : "",
    slug: typeof p.slug === "string" && p.slug ? p.slug : null,
    fileName: typeof p.fileName === "string" ? p.fileName : "",
    filePath: typeof p.filePath === "string" ? p.filePath : "",
    collectivePath:
      typeof p.collectivePath === "string" && p.collectivePath ? p.collectivePath : null,
  };
}

function toCollectiveSummary(raw: unknown, label: string): CollectiveSummary {
  const c = (raw ?? {}) as Record<string, unknown>;
  return {
    id: positiveInt(c.id, label),
    name: typeof c.name === "string" ? c.name : "",
    slug: typeof c.slug === "string" && c.slug ? c.slug : null,
    circleId: typeof c.circleId === "string" && c.circleId ? c.circleId : null,
  };
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") throw new NextcloudBadResponseError(label);
  return value;
}

function toTeam(raw: unknown, label: string): Team {
  const c = (raw ?? {}) as { id?: unknown; name?: unknown; initiator?: { level?: unknown } | null };
  return {
    id: nonEmptyString(c.id, label),
    name: typeof c.name === "string" ? c.name : "",
    initiatorLevel: typeof c.initiator?.level === "number" ? c.initiator.level : 0,
  };
}

function toTeamMember(raw: unknown, label: string): TeamMember {
  const m = (raw ?? {}) as Record<string, unknown>;
  return {
    id: nonEmptyString(m.id, label),
    userId: typeof m.userId === "string" ? m.userId : "",
    userType: typeof m.userType === "number" ? m.userType : 0,
    level: typeof m.level === "number" ? m.level : 0,
  };
}

function toFolderShare(raw: unknown, label: string): FolderShare {
  const s = (raw ?? {}) as Record<string, unknown>;
  // OCS sends share ids and types as strings or numbers depending on the version.
  const id = Number(s.id);
  if (!Number.isInteger(id) || id <= 0) throw new NextcloudBadResponseError(label);
  return {
    id,
    shareType: Number(s.share_type),
    shareWith: typeof s.share_with === "string" ? s.share_with : "",
  };
}

export class ClientOnboardingNextcloud {
  constructor(
    private readonly nc: NextcloudConfig,
    readonly targets: ClientOnboardingTargets
  ) {}

  /** The service account's user id (owner of the teams it creates). */
  get serviceUsername(): string {
    return this.nc.username;
  }

  // ── Forms ──────────────────────────────────────────────────────────────────

  /** One page of submission ids, newest first. */
  async listSubmissionIds(offset: number): Promise<number[]> {
    const label = "forms.list_submissions";
    const res = await nextcloudRequest(this.nc, {
      method: "GET",
      label,
      path: `${FORMS_BASE}/${this.targets.formId}/submissions?limit=${SUBMISSION_PAGE_SIZE}&offset=${offset}&format=json`,
    });
    const data = ocsData(res.body, label) as { submissions?: { id?: unknown }[] };
    if (!Array.isArray(data.submissions)) throw new NextcloudBadResponseError(label);
    return data.submissions.map((s) => positiveInt(s.id, label));
  }

  async getForm(): Promise<IntakeForm> {
    const label = "forms.get_form";
    const res = await nextcloudRequest(this.nc, {
      method: "GET",
      label,
      path: `${FORMS_BASE}/${this.targets.formId}?format=json`,
    });
    const data = ocsData(res.body, label) as {
      hash?: unknown;
      questions?: { id?: unknown; name?: unknown }[];
    };
    if (typeof data.hash !== "string" || !/^[A-Za-z0-9]+$/.test(data.hash)) {
      throw new NextcloudBadResponseError(label);
    }
    if (!Array.isArray(data.questions)) throw new NextcloudBadResponseError(label);
    return {
      hash: data.hash,
      questions: data.questions.map((q) => ({
        id: positiveInt(q.id, label),
        name: typeof q.name === "string" ? q.name : "",
      })),
    };
  }

  /** The submission, or null when it was deleted. */
  async getSubmission(submissionId: number): Promise<IntakeSubmission | null> {
    const label = "forms.get_submission";
    const res = await nextcloudRequest(this.nc, {
      method: "GET",
      label,
      path: `${FORMS_BASE}/${this.targets.formId}/submissions/${submissionId}?format=json`,
      okStatuses: [404],
    });
    if (res.status === 404) return null;
    const data = ocsData(res.body, label) as {
      id?: unknown;
      userId?: unknown;
      answers?: { questionId?: unknown; text?: unknown }[];
    };
    if (!Array.isArray(data.answers)) throw new NextcloudBadResponseError(label);
    return {
      id: positiveInt(data.id, label),
      userId: typeof data.userId === "string" ? data.userId : null,
      answers: data.answers.map((a) => ({
        questionId: positiveInt(a.questionId, label),
        text: typeof a.text === "string" ? a.text : "",
      })),
    };
  }

  // ── Tables ─────────────────────────────────────────────────────────────────

  async getColumns(tableId: number): Promise<TableColumn[]> {
    const label = "tables.columns";
    const res = await nextcloudRequest(this.nc, {
      method: "GET",
      label,
      path: `${TABLES_BASE}/tables/${tableId}/columns`,
    });
    const columns = parseJson(res.body, label);
    if (!Array.isArray(columns)) throw new NextcloudBadResponseError(label);
    return columns as TableColumn[];
  }

  private toRow(raw: unknown, label: string): TableRow {
    const row = (raw ?? {}) as {
      id?: unknown;
      tableId?: unknown;
      data?: { columnId?: unknown; value?: unknown }[];
    };
    if (!Array.isArray(row.data)) throw new NextcloudBadResponseError(label);
    return {
      id: positiveInt(row.id, label),
      tableId: typeof row.tableId === "number" ? row.tableId : null,
      cells: new Map(
        row.data
          .filter((c) => typeof c.columnId === "number")
          .map((c) => [c.columnId as number, c.value])
      ),
    };
  }

  /** Every row of the table. Refuses a table too large to scan rather than miss a row. */
  async listRows(tableId: number): Promise<TableRow[]> {
    const label = "tables.list_rows";
    const rows: TableRow[] = [];
    for (let page = 0; page < MAX_ROW_PAGES; page++) {
      const res = await nextcloudRequest(this.nc, {
        method: "GET",
        label,
        path: `${TABLES_BASE}/tables/${tableId}/rows?limit=${ROW_PAGE_SIZE}&offset=${page * ROW_PAGE_SIZE}`,
      });
      const batch = parseJson(res.body, label);
      if (!Array.isArray(batch)) throw new NextcloudBadResponseError(label);
      rows.push(...batch.map((r) => this.toRow(r, label)));
      if (batch.length < ROW_PAGE_SIZE) return rows;
    }
    throw new NextcloudBadResponseError(label);
  }

  /** The row, or null when it does not exist (or is not visible to the service account). */
  async getRow(rowId: number): Promise<TableRow | null> {
    const label = "tables.get_row";
    const res = await nextcloudRequest(this.nc, {
      method: "GET",
      label,
      path: `${TABLES_BASE}/rows/${rowId}`,
      okStatuses: [404],
    });
    if (res.status === 404) return null;
    return this.toRow(parseJson(res.body, label), label);
  }

  async createRow(tableId: number, data: Record<string, unknown>): Promise<number> {
    const label = "tables.create_row";
    const res = await nextcloudRequest(this.nc, {
      method: "POST",
      label,
      path: `${TABLES_BASE}/tables/${tableId}/rows`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data }),
    });
    return positiveInt((parseJson(res.body, label) as { id?: unknown } | null)?.id, label);
  }

  async updateRow(rowId: number, data: Record<string, unknown>): Promise<void> {
    await nextcloudRequest(this.nc, {
      method: "PUT",
      label: "tables.update_row",
      path: `${TABLES_BASE}/rows/${rowId}`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data }),
    });
  }

  // ── CardDAV ────────────────────────────────────────────────────────────────

  /** The configured address book (where new cards are created). */
  private get addressbookCollection(): string {
    return addressbookCollection(this.nc, this.targets.addressbookPath);
  }

  /** Existing cards for this person across every visible address book. */
  /** A per-cycle view of every visible address book; see ContactDirectory. */
  contactDirectory(onSkippedBook?: (addressbook: string, status: number) => void) {
    return createContactDirectory(this.nc, this.targets.addressbookPath, onSkippedBook);
  }

  updateCard(card: StoredCard, vcard: string): Promise<void> {
    return updateCard(this.nc, card, vcard);
  }

  /** Creates the card once; "exists" when a card with this UID is already there. */
  async createCard(uid: string, vcard: string): Promise<"created" | "exists"> {
    const res = await nextcloudRequest(this.nc, {
      method: "PUT",
      label: "carddav.create_contact",
      path: `${this.addressbookCollection}${encodeURIComponent(`${uid}.vcf`)}`,
      headers: { "content-type": "text/vcard; charset=utf-8", "if-none-match": "*" },
      body: vcard,
      okStatuses: [412],
    });
    return res.status === 412 ? "exists" : "created";
  }

  // ── WebDAV ─────────────────────────────────────────────────────────────────

  private filesPath(segments: string[]): string {
    return `/remote.php/dav/files/${encodePathSegments([this.nc.username, ...segments])}`;
  }

  /** Creates a folder below the clients folder; an existing one is accepted. */
  async ensureClientFolder(segments: string[]): Promise<void> {
    await nextcloudRequest(this.nc, {
      method: "MKCOL",
      label: "webdav.mkcol",
      path: this.filesPath([...this.targets.clientsFolder, ...segments]),
      okStatuses: [405],
    });
  }

  async getClientFolderId(segments: string[]): Promise<number> {
    const label = "webdav.fileid";
    const res = await nextcloudRequest(this.nc, {
      method: "PROPFIND",
      label,
      path: this.filesPath([...this.targets.clientsFolder, ...segments]),
      headers: { depth: "0", "content-type": "application/xml" },
      body: PROPFIND_FILEID,
    });
    const match = /<(?:[\w-]+:)?fileid>\s*(\d+)\s*</.exec(res.body);
    if (!match) throw new NextcloudBadResponseError(label);
    return Number(match[1]);
  }

  /** Reads a text file at a path relative to the service account's files root; null when missing. */
  async getFile(segments: string[]): Promise<{ body: string; etag: string | null } | null> {
    const res = await nextcloudRequest(this.nc, {
      method: "GET",
      label: "webdav.get_page",
      path: this.filesPath(segments),
      okStatuses: [404],
    });
    if (res.status === 404) return null;
    return { body: res.body, etag: res.etag };
  }

  /**
   * Writes a text file at a path relative to the service account's files root.
   * With `ifMatch` the write only happens while the file still has that ETag;
   * false means it changed meanwhile (412) and nothing was written.
   */
  async putFile(segments: string[], content: string, ifMatch?: string | null): Promise<boolean> {
    const headers: Record<string, string> = { "content-type": "text/markdown; charset=utf-8" };
    // Cloudflare weakens ETags (W/"x") when it compresses; the opaque tag is unchanged.
    if (ifMatch) headers["if-match"] = ifMatch.replace(/^W\//, "");
    const res = await nextcloudRequest(this.nc, {
      method: "PUT",
      label: "webdav.put_page",
      path: this.filesPath(segments),
      headers,
      body: content,
      okStatuses: [412],
    });
    return res.status !== 412;
  }

  // ── Collectives ────────────────────────────────────────────────────────────

  /** The collective's URL slug (e.g. "Cerebo-Pilot", which can differ from the name) and name; null when not visible. */
  async getCollective(): Promise<{ name: string; slug: string | null } | null> {
    const label = "collectives.list";
    const res = await nextcloudRequest(this.nc, {
      method: "GET",
      label,
      path: `${COLLECTIVES_BASE}?format=json`,
    });
    const data = ocsData(res.body, label) as {
      collectives?: { id?: unknown; name?: unknown; slug?: unknown }[];
    };
    if (!Array.isArray(data.collectives)) throw new NextcloudBadResponseError(label);
    const found = data.collectives.find((c) => c.id === this.targets.collectiveId);
    if (!found) return null;
    return {
      name: typeof found.name === "string" ? found.name : "",
      slug: typeof found.slug === "string" && found.slug ? found.slug : null,
    };
  }

  /** Pages of the Client Projects collective, or of `collectiveId` when given. */
  async listPages(collectiveId: number = this.targets.collectiveId): Promise<CollectivePage[]> {
    const label = "collectives.pages";
    const res = await nextcloudRequest(this.nc, {
      method: "GET",
      label,
      path: `${COLLECTIVES_BASE}/${collectiveId}/pages?format=json`,
    });
    const data = ocsData(res.body, label) as { pages?: unknown[] };
    if (!Array.isArray(data.pages)) throw new NextcloudBadResponseError(label);
    return data.pages.map((p) => toPage(p, label));
  }

  async getPage(pageId: number): Promise<CollectivePage> {
    const label = "collectives.get_page";
    const res = await nextcloudRequest(this.nc, {
      method: "GET",
      label,
      path: `${COLLECTIVES_BASE}/${this.targets.collectiveId}/pages/${pageId}?format=json`,
    });
    return toPage((ocsData(res.body, label) as { page?: unknown }).page, label);
  }

  async createPage(parentId: number, title: string): Promise<CollectivePage> {
    const label = "collectives.create_page";
    const res = await nextcloudRequest(this.nc, {
      method: "POST",
      label,
      path: `${COLLECTIVES_BASE}/${this.targets.collectiveId}/pages/${parentId}?format=json`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    return toPage((ocsData(res.body, label) as { page?: unknown }).page, label);
  }

  /** Every collective the service account can see. */
  async listCollectives(): Promise<CollectiveSummary[]> {
    const label = "collectives.list";
    const res = await nextcloudRequest(this.nc, {
      method: "GET",
      label,
      path: `${COLLECTIVES_BASE}?format=json`,
    });
    const data = ocsData(res.body, label) as { collectives?: unknown[] };
    if (!Array.isArray(data.collectives)) throw new NextcloudBadResponseError(label);
    return data.collectives.map((raw) => toCollectiveSummary(raw, label));
  }

  /**
   * Creates a collective. When a team of that name exists and the service account is its
   * admin, Collectives builds the collective on that team instead of making a new one.
   */
  async createCollective(name: string, emoji: string): Promise<CollectiveSummary> {
    const label = "collectives.create";
    const res = await nextcloudRequest(this.nc, {
      method: "POST",
      label,
      path: `${COLLECTIVES_BASE}?format=json`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, emoji }),
    });
    return toCollectiveSummary(
      (ocsData(res.body, label) as { collective?: unknown }).collective,
      label
    );
  }

  // ── Teams (Circles) ─────────────────────────────────────────────────────────

  /** Teams the service account belongs to. */
  async listTeams(): Promise<Team[]> {
    const label = "circles.list";
    const res = await nextcloudRequest(this.nc, {
      method: "GET",
      label,
      path: `${CIRCLES_BASE}/circles?format=json`,
    });
    const data = ocsData(res.body, label);
    if (!Array.isArray(data)) throw new NextcloudBadResponseError(label);
    return data.map((raw) => toTeam(raw, label));
  }

  /** Creates a team owned by the service account, without an extra team folder. */
  async createTeam(name: string): Promise<Team> {
    const label = "circles.create";
    const res = await nextcloudRequest(this.nc, {
      method: "POST",
      label,
      path: `${CIRCLES_BASE}/circles?format=json`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, personal: false, local: false, createTeamFolder: false }),
    });
    return toTeam(ocsData(res.body, label), label);
  }

  async listTeamMembers(teamId: string): Promise<TeamMember[]> {
    const label = "circles.members";
    const res = await nextcloudRequest(this.nc, {
      method: "GET",
      label,
      path: `${CIRCLES_BASE}/circles/${encodeURIComponent(teamId)}/members?format=json`,
    });
    const data = ocsData(res.body, label);
    if (!Array.isArray(data)) throw new NextcloudBadResponseError(label);
    return data.map((raw) => toTeamMember(raw, label));
  }

  async addTeamUser(teamId: string, userId: string): Promise<TeamMember> {
    const label = "circles.add_member";
    const res = await nextcloudRequest(this.nc, {
      method: "POST",
      label,
      path: `${CIRCLES_BASE}/circles/${encodeURIComponent(teamId)}/members?format=json`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, type: TEAM_MEMBER_TYPE_USER }),
    });
    return toTeamMember(ocsData(res.body, label), label);
  }

  async setTeamMemberLevel(teamId: string, memberId: string, level: number): Promise<void> {
    await nextcloudRequest(this.nc, {
      method: "PUT",
      label: "circles.set_level",
      path: `${CIRCLES_BASE}/circles/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}/level?format=json`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level }),
    });
  }

  // ── Shares ──────────────────────────────────────────────────────────────────

  /** Path of a client folder as the service account's file tree shows it (leading "/"). */
  clientFolderSharePath(segments: string[]): string {
    return `/${[...this.targets.clientsFolder, ...segments].join("/")}`;
  }

  /** Shares the service account made of `path`. */
  async listSharesOfPath(path: string): Promise<FolderShare[]> {
    const label = "files_sharing.list";
    const res = await nextcloudRequest(this.nc, {
      method: "GET",
      label,
      path: `${SHARES_BASE}?path=${encodeURIComponent(path)}&format=json`,
    });
    const data = ocsData(res.body, label);
    if (!Array.isArray(data)) throw new NextcloudBadResponseError(label);
    return data.map((raw) => toFolderShare(raw, label));
  }

  /** Shares `path` with a team: read, update, create, delete, no reshare. */
  async shareWithTeam(path: string, teamId: string): Promise<FolderShare> {
    const label = "files_sharing.create";
    const res = await nextcloudRequest(this.nc, {
      method: "POST",
      label,
      path: `${SHARES_BASE}?format=json`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path,
        shareType: SHARE_TYPE_TEAM,
        shareWith: teamId,
        permissions: TEAM_SHARE_PERMISSIONS,
      }),
    });
    return toFolderShare(ocsData(res.body, label), label);
  }

  /** Whether a share is the type-7 share with this team. */
  isTeamShare(share: FolderShare, teamId: string): boolean {
    return share.shareType === SHARE_TYPE_TEAM && share.shareWith === teamId;
  }

  teamLink(teamId: string): string {
    return `${this.nc.baseUrl}/index.php/apps/contacts/circle/${encodeURIComponent(teamId)}`;
  }

  collectiveLink(slug: string, collectiveId: number): string {
    return `${this.nc.baseUrl}/index.php/apps/collectives/${encodeURIComponent(`${slug}-${collectiveId}`)}`;
  }

  // ── Links ──────────────────────────────────────────────────────────────────

  folderLink(fileId: number): string {
    return `${this.nc.baseUrl}/index.php/f/${fileId}`;
  }

  rowLink(tableId: number, rowId: number): string {
    return `${this.nc.baseUrl}/index.php/apps/tables/#/table/${tableId}/row/${rowId}`;
  }

  intakeResultsLink(formHash: string): string {
    return `${this.nc.baseUrl}/index.php/apps/forms/${formHash}/results`;
  }

  pageLink(collectiveSlug: string, page: { id: number; slug: string }): string {
    return `${this.nc.baseUrl}/index.php/apps/collectives/${encodeURIComponent(
      `${collectiveSlug}-${this.targets.collectiveId}`
    )}/${encodeURIComponent(`${page.slug}-${page.id}`)}`;
  }
}
