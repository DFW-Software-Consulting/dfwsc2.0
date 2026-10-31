import { encodePathSegments, type NextcloudConfig, nextcloudRequest } from "./nextcloud";
import type { FormAnswer, FormQuestion, TableColumn } from "./sales-lead-mapping";

// Thin wrappers around the Nextcloud APIs the New Lead automation uses: Forms v3
// (OCS), Tables v1, CardDAV and WebDAV. Each call has a fixed label; nothing here
// logs. Paths are built from config and sanitized names only.

export interface SalesLeadTargets {
  formId: number;
  tableId: number;
  /** The address book's collection name as the service account sees it. */
  addressbookPath: string;
  /** Lead folder parent, relative to the service account's files root, as path segments. */
  leadsFolder: string[];
}

export interface FormSubmission {
  id: number;
  answers: FormAnswer[];
}

const FORMS_BASE = "/ocs/v2.php/apps/forms/api/v3/forms";
const TABLES_BASE = "/index.php/apps/tables/api/1";
export const SUBMISSION_PAGE_SIZE = 50;
const ROW_PAGE_SIZE = 200;
const MAX_ROW_PAGES = 50;

class NextcloudBadResponseError extends Error {
  constructor(readonly label: string) {
    super(`Nextcloud sent an unexpected response for ${label}`);
    this.name = "NextcloudBadResponseError";
  }
}

export function isBadResponseError(error: unknown): error is NextcloudBadResponseError {
  return error instanceof NextcloudBadResponseError;
}

function parseJson(body: string, label: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new NextcloudBadResponseError(label);
  }
}

function ocsData(body: string, label: string): unknown {
  const data = (parseJson(body, label) as { ocs?: { data?: unknown } } | null)?.ocs?.data;
  if (data === undefined) throw new NextcloudBadResponseError(label);
  return data;
}

function positiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new NextcloudBadResponseError(label);
  }
  return value;
}

export class SalesLeadNextcloud {
  constructor(
    private readonly nc: NextcloudConfig,
    private readonly targets: SalesLeadTargets
  ) {}

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

  async getQuestions(): Promise<FormQuestion[]> {
    const label = "forms.get_form";
    const res = await nextcloudRequest(this.nc, {
      method: "GET",
      label,
      path: `${FORMS_BASE}/${this.targets.formId}?format=json`,
    });
    const data = ocsData(res.body, label) as { questions?: { id?: unknown; text?: unknown }[] };
    if (!Array.isArray(data.questions)) throw new NextcloudBadResponseError(label);
    return data.questions.map((q) => ({
      id: positiveInt(q.id, label),
      text: typeof q.text === "string" ? q.text : "",
    }));
  }

  /** The submission, or null when it was deleted. */
  async getSubmission(submissionId: number): Promise<FormSubmission | null> {
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
      answers?: { questionId?: unknown; text?: unknown }[];
    };
    if (!Array.isArray(data.answers)) throw new NextcloudBadResponseError(label);
    return {
      id: positiveInt(data.id, label),
      answers: data.answers.map((a) => ({
        questionId: positiveInt(a.questionId, label),
        text: typeof a.text === "string" ? a.text : "",
      })),
    };
  }

  // ── Tables ─────────────────────────────────────────────────────────────────

  async getColumns(): Promise<TableColumn[]> {
    const label = "tables.columns";
    const res = await nextcloudRequest(this.nc, {
      method: "GET",
      label,
      path: `${TABLES_BASE}/tables/${this.targets.tableId}/columns`,
    });
    const columns = parseJson(res.body, label);
    if (!Array.isArray(columns)) throw new NextcloudBadResponseError(label);
    return columns as TableColumn[];
  }

  /** The id of the row whose `columnId` cell equals `value`, scanning every page. */
  async findRowId(columnId: number, value: string): Promise<number | null> {
    const label = "tables.list_rows";
    for (let page = 0; page < MAX_ROW_PAGES; page++) {
      const res = await nextcloudRequest(this.nc, {
        method: "GET",
        label,
        path: `${TABLES_BASE}/tables/${this.targets.tableId}/rows?limit=${ROW_PAGE_SIZE}&offset=${page * ROW_PAGE_SIZE}`,
      });
      const rows = parseJson(res.body, label) as
        | { id?: unknown; data?: { columnId?: unknown; value?: unknown }[] }[]
        | null;
      if (!Array.isArray(rows)) throw new NextcloudBadResponseError(label);
      for (const row of rows) {
        const cell = row.data?.find((c) => c.columnId === columnId);
        if (cell && String(cell.value ?? "").trim() === value) return positiveInt(row.id, label);
      }
      if (rows.length < ROW_PAGE_SIZE) return null;
    }
    // A table this large is not what this automation was built for; refuse rather than
    // risk a duplicate row.
    throw new NextcloudBadResponseError(label);
  }

  async createRow(data: Record<string, unknown>): Promise<number> {
    const label = "tables.create_row";
    const res = await nextcloudRequest(this.nc, {
      method: "POST",
      label,
      path: `${TABLES_BASE}/tables/${this.targets.tableId}/rows`,
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

  /** The row's stored cells, keyed by column id. */
  async getRowCells(rowId: number): Promise<Map<number, unknown>> {
    const label = "tables.get_row";
    const res = await nextcloudRequest(this.nc, {
      method: "GET",
      label,
      path: `${TABLES_BASE}/rows/${rowId}`,
    });
    const row = parseJson(res.body, label) as {
      data?: { columnId?: unknown; value?: unknown }[];
    } | null;
    if (!Array.isArray(row?.data)) throw new NextcloudBadResponseError(label);
    return new Map(
      row.data
        .filter((c) => typeof c.columnId === "number")
        .map((c) => [c.columnId as number, c.value])
    );
  }

  // ── CardDAV ────────────────────────────────────────────────────────────────

  /** Creates the contact once: an existing card with the same UID is left untouched. */
  async putContact(uid: string, vcard: string): Promise<void> {
    await nextcloudRequest(this.nc, {
      method: "PUT",
      label: "carddav.put_contact",
      path: `/remote.php/dav/addressbooks/users/${encodePathSegments([
        this.nc.username,
        this.targets.addressbookPath,
        `${uid}.vcf`,
      ])}`,
      headers: { "content-type": "text/vcard; charset=utf-8", "if-none-match": "*" },
      body: vcard,
      okStatuses: [412],
    });
  }

  // ── WebDAV ─────────────────────────────────────────────────────────────────

  private folderPath(name: string): string {
    return `/remote.php/dav/files/${encodePathSegments([
      this.nc.username,
      ...this.targets.leadsFolder,
      name,
    ])}`;
  }

  async folderExists(name: string): Promise<boolean> {
    const res = await nextcloudRequest(this.nc, {
      method: "PROPFIND",
      label: "webdav.exists",
      path: this.folderPath(name),
      headers: { depth: "0", "content-type": "application/xml" },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
      okStatuses: [404],
    });
    return res.status !== 404;
  }

  /** Creates the folder; an existing folder with that name is accepted. */
  async createFolder(name: string): Promise<void> {
    await nextcloudRequest(this.nc, {
      method: "MKCOL",
      label: "webdav.mkcol",
      path: this.folderPath(name),
      okStatuses: [405],
    });
  }

  async getFileId(name: string): Promise<number> {
    const label = "webdav.fileid";
    const res = await nextcloudRequest(this.nc, {
      method: "PROPFIND",
      label,
      path: this.folderPath(name),
      headers: { depth: "0", "content-type": "application/xml" },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/></d:prop></d:propfind>',
    });
    const match = /<(?:[\w-]+:)?fileid>\s*(\d+)\s*</.exec(res.body);
    if (!match) throw new NextcloudBadResponseError(label);
    return Number(match[1]);
  }

  // ── Links ──────────────────────────────────────────────────────────────────

  /** Opens the folder for any user who can see it (owner or sharee). */
  folderLink(fileId: number): string {
    return `${this.nc.baseUrl}/index.php/f/${fileId}`;
  }

  /**
   * Opens the contact in the Contacts app. The address book is addressed by its
   * owner-side URI, which is the sharee's collection name without "_shared_by_<owner>".
   */
  contactLink(uid: string): string {
    const ownerUri = this.targets.addressbookPath.replace(/_shared_by_.+$/, "");
    return `${this.nc.baseUrl}/index.php/apps/contacts/direct/contact/${encodeURIComponent(`${uid}~${ownerUri}`)}`;
  }
}
