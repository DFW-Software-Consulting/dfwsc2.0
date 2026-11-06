// In-memory stand-in for the Nextcloud APIs the New Lead automation calls (Forms v3,
// Tables v1, CardDAV, WebDAV). Install it with vi.stubGlobal("fetch", fake.fetch).

export const FAKE_NC_BASE = "https://cloud.test";
export const FAKE_NC_USER = "dfwsc-admin";
export const FAKE_FORM_ID = 12;
export const FAKE_TABLE_ID = 8;
export const FAKE_ADDRESSBOOK = "dfwsc-sales_shared_by_messyginger0804";
export const FAKE_LEADS_FOLDER = "DFWSC Sales/Leads";

export const salesLeadEnv = (overrides: Record<string, string | undefined> = {}) =>
  ({
    SALES_AUTOMATION_ENABLED: "true",
    NEXTCLOUD_BASE_URL: FAKE_NC_BASE,
    NEXTCLOUD_USERNAME: FAKE_NC_USER,
    NEXTCLOUD_APP_PASSWORD: "app-password-for-tests",
    SALES_LEAD_FORM_ID: String(FAKE_FORM_ID),
    SALES_PIPELINE_TABLE_ID: String(FAKE_TABLE_ID),
    SALES_ADDRESSBOOK_PATH: FAKE_ADDRESSBOOK,
    SALES_LEADS_FOLDER: FAKE_LEADS_FOLDER,
    ...overrides,
  }) as NodeJS.ProcessEnv;

export const QUESTION_IDS = {
  Company: 101,
  "Contact name": 102,
  Email: 103,
  Phone: 104,
  Source: 105,
  Temperature: 106,
  "Estimated value": 107,
  "Next follow-up": 108,
  Notes: 109,
} as const;

export type LeadAnswers = Partial<Record<keyof typeof QUESTION_IDS, string>>;

export const COLUMN_IDS = {
  Company: 1,
  "Contact Name": 2,
  "Contact Card": 3,
  Stage: 4,
  Temperature: 5,
  Source: 6,
  "Estimated Value": 7,
  "Next Follow-up": 8,
  "Last Contacted": 9,
  Owner: 10,
  "Notes / Files": 11,
  "Cerebo Project": 12,
  Summary: 13,
  "Lead Ref": 14,
} as const;

export function defaultColumns() {
  return [
    { id: 1, title: "Company", type: "text", subtype: "line" },
    { id: 2, title: "Contact Name", type: "text", subtype: "line" },
    { id: 3, title: "Contact Card", type: "text", subtype: "link" },
    {
      id: 4,
      title: "Stage",
      type: "selection",
      subtype: "",
      selectionOptions: [
        { id: 1, label: "New Lead" },
        { id: 2, label: "Qualified" },
      ],
    },
    {
      id: 5,
      title: "Temperature",
      type: "selection",
      subtype: "",
      selectionOptions: [
        { id: 1, label: "Hot" },
        { id: 2, label: "Warm" },
        { id: 3, label: "Cold" },
      ],
    },
    {
      id: 6,
      title: "Source",
      type: "selection",
      subtype: "",
      selectionOptions: [
        { id: 1, label: "Referral" },
        { id: 2, label: "Website" },
      ],
    },
    { id: 7, title: "Estimated Value", type: "number", subtype: "" },
    { id: 8, title: "Next Follow-up", type: "datetime", subtype: "date" },
    { id: 9, title: "Last Contacted", type: "datetime", subtype: "date" },
    { id: 10, title: "Owner", type: "usergroup", subtype: "" },
    { id: 11, title: "Notes / Files", type: "text", subtype: "link" },
    { id: 12, title: "Cerebo Project", type: "text", subtype: "link" },
    { id: 13, title: "Summary", type: "text", subtype: "long" },
    { id: 14, title: "Lead Ref", type: "text", subtype: "line" },
  ];
}

interface RecordedRequest {
  method: string;
  /** Decoded path, without the query string. */
  path: string;
  body: string;
  headers: Record<string, string>;
}

interface Fault {
  match: (req: RecordedRequest) => boolean;
  /** Answer with this status instead of handling the request. */
  status?: number;
  /** Throw a timeout. With `afterApply`, the request takes effect first (lost response). */
  timeout?: boolean;
  afterApply?: boolean;
  times: number;
}

interface Row {
  id: number;
  data: Map<number, unknown>;
}

const FORMS = `/ocs/v2.php/apps/forms/api/v3/forms/${FAKE_FORM_ID}`;
const TABLES = "/index.php/apps/tables/api/1";
const BOOKS_HOME = `/remote.php/dav/addressbooks/users/${FAKE_NC_USER}/`;
const CARDS = `${BOOKS_HOME}${FAKE_ADDRESSBOOK}/`;
const FILES = `/remote.php/dav/files/${FAKE_NC_USER}/`;

export class FakeNextcloud {
  readonly requests: RecordedRequest[] = [];
  submissions = new Map<number, LeadAnswers>();
  questions: { id: number; text: string }[] = Object.entries(QUESTION_IDS).map(([text, id]) => ({
    id,
    text,
  }));
  columns: Record<string, unknown>[] = defaultColumns();
  rows: Row[] = [];
  cards = new Map<string, string>();
  /** Address books besides the configured one; a read-only one answers writes with 403. */
  otherBooks = new Map<
    string,
    { cards: Map<string, string>; readOnly: boolean; advertise: boolean }
  >();
  folders = new Map<string, number>([
    ["DFWSC Sales", 500],
    ["DFWSC Sales/Leads", 501],
  ]);
  /** Milliseconds every request waits, so concurrent cycles interleave. */
  latencyMs = 0;
  /** Row updates still to answer 200 without storing anything. */
  droppedRowUpdates = 0;
  private faults: Fault[] = [];
  private nextRowId = 1000;
  private nextFileId = 900;

  addSubmission(id: number, answers: LeadAnswers) {
    this.submissions.set(id, answers);
  }

  /** `advertise: false` hides the privilege set, so a read-only book only shows as a 403. */
  addBook(name: string, readOnly = false, advertise = true) {
    this.otherBooks.set(name, { cards: new Map(), readOnly, advertise });
  }

  fail(fault: Omit<Fault, "times"> & { times?: number }) {
    this.faults.push({ times: 1, ...fault });
  }

  count(method: string, pathPrefix: string): number {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(pathPrefix)).length;
  }

  get rowCreates() {
    return this.requests.filter((r) => r.method === "POST" && r.path.endsWith("/rows"));
  }

  get rowUpdates() {
    return this.requests.filter((r) => r.method === "PUT" && r.path.startsWith(`${TABLES}/rows/`));
  }

  get cardPuts() {
    return this.requests.filter((r) => r.method === "PUT" && r.path.startsWith(CARDS));
  }

  get mkcols() {
    return this.requests.filter((r) => r.method === "MKCOL");
  }

  rowCell(rowId: number, columnId: number): unknown {
    return this.rows.find((r) => r.id === rowId)?.data.get(columnId);
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const req: RecordedRequest = {
      method: init.method ?? "GET",
      path: decodeURIComponent(url.pathname),
      body: typeof init.body === "string" ? init.body : "",
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ])
      ),
    };
    this.requests.push(req);
    if (this.latencyMs) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));

    const fault = this.faults.find((f) => f.times > 0 && f.match(req));
    if (fault) {
      fault.times--;
      if (fault.timeout) {
        if (fault.afterApply) this.handle(req, url);
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return new Response("", { status: fault.status ?? 500 });
    }
    return this.handle(req, url);
  };

  private json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  private ocs(data: unknown) {
    return this.json({ ocs: { meta: { status: "ok" }, data } });
  }

  private isJsonLink(columnId: string, value: unknown): boolean {
    const column = this.columns.find((c) => c.id === Number(columnId));
    return column?.subtype === "link" && typeof value === "string" && value.trim().startsWith("{");
  }

  private storedValue(columnId: string, value: unknown): unknown {
    const column = this.columns.find((c) => c.id === Number(columnId));
    const link = typeof value === "string" ? /^(.*) \((\S+)\)$/.exec(value) : null;
    if (column?.subtype !== "link" || !link) return value;
    return JSON.stringify({ title: link[1], value: link[2], providerId: "url" }).replace(
      /\//g,
      "\\/"
    );
  }

  private submissionData(id: number) {
    const answers = Object.entries(this.submissions.get(id) ?? {}).map(([title, text], i) => ({
      id: id * 100 + i,
      submissionId: id,
      questionId: QUESTION_IDS[title as keyof typeof QUESTION_IDS],
      text,
    }));
    return { id, formId: FAKE_FORM_ID, userId: "messyginger0804", timestamp: id, answers };
  }

  private handle(req: RecordedRequest, url: URL): Response {
    const { method, path } = req;
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const offset = Number(url.searchParams.get("offset") ?? 0);

    if (method === "GET" && path === `${FORMS}/submissions`) {
      const ids = [...this.submissions.keys()].sort((a, b) => b - a).slice(offset, offset + limit);
      return this.ocs({
        submissions: ids.map((id) => this.submissionData(id)),
        questions: this.questions,
      });
    }
    const single = new RegExp(`^${FORMS}/submissions/(\\d+)$`).exec(path);
    if (method === "GET" && single) {
      const id = Number(single[1]);
      if (!this.submissions.has(id)) return this.json({ ocs: { meta: {}, data: [] } }, 404);
      return this.ocs(this.submissionData(id));
    }
    if (method === "GET" && path === FORMS) {
      return this.ocs({ id: FAKE_FORM_ID, questions: this.questions });
    }

    if (method === "GET" && path === `${TABLES}/tables/${FAKE_TABLE_ID}/columns`) {
      return this.json(this.columns);
    }
    if (method === "GET" && path === `${TABLES}/tables/${FAKE_TABLE_ID}/rows`) {
      return this.json(
        this.rows.slice(offset, offset + limit).map((r) => ({
          id: r.id,
          tableId: FAKE_TABLE_ID,
          data: [...r.data].map(([columnId, value]) => ({ columnId, value })),
        }))
      );
    }
    if (method === "POST" && path === `${TABLES}/tables/${FAKE_TABLE_ID}/rows`) {
      const { data } = JSON.parse(req.body) as { data: Record<string, unknown> };
      const row: Row = {
        id: this.nextRowId++,
        data: new Map(Object.entries(data).map(([k, v]) => [Number(k), v])),
      };
      this.rows.push(row);
      return this.json({ id: row.id, tableId: FAKE_TABLE_ID });
    }
    const rowUpdate = new RegExp(`^${TABLES}/rows/(\\d+)$`).exec(path);
    if (method === "GET" && rowUpdate) {
      const row = this.rows.find((r) => r.id === Number(rowUpdate[1]));
      if (!row) return this.json({ message: "not found" }, 404);
      return this.json({
        id: row.id,
        tableId: FAKE_TABLE_ID,
        // Like Tables, empty cells may be left out.
        data: [...row.data]
          .filter(([, value]) => value !== null && value !== undefined && value !== "")
          .map(([columnId, value]) => ({ columnId, value })),
      });
    }
    if (method === "PUT" && rowUpdate) {
      const row = this.rows.find((r) => r.id === Number(rowUpdate[1]));
      if (!row) return this.json({ message: "not found" }, 404);
      const { data } = JSON.parse(req.body) as { data: Record<string, unknown> };
      // Like Tables 2.4: a JSON {title,value,providerId} link value gets a 200 and
      // nothing in the update is stored. "Title (url)" is stored converted to that
      // JSON form, with slashes escaped as PHP's json_encode does.
      if (
        this.droppedRowUpdates > 0 ||
        Object.entries(data).some(([k, v]) => this.isJsonLink(k, v))
      ) {
        this.droppedRowUpdates = Math.max(this.droppedRowUpdates - 1, 0);
        return this.json({ id: row.id });
      }
      for (const [k, v] of Object.entries(data)) row.data.set(Number(k), this.storedValue(k, v));
      return this.json({ id: row.id });
    }

    if (method === "PROPFIND" && path === BOOKS_HOME) {
      const book = (name: string) => {
        const other = this.otherBooks.get(name);
        const privileges =
          other && !other.advertise
            ? ""
            : `<d:current-user-privilege-set><d:privilege><d:read/></d:privilege>${other?.readOnly ? "" : "<d:privilege><d:write-content/></d:privilege>"}</d:current-user-privilege-set>`;
        return `<d:response><d:href>${BOOKS_HOME}${encodeURIComponent(name)}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>${privileges}</d:prop></d:propstat></d:response>`;
      };
      return new Response(
        `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:response><d:href>${BOOKS_HOME}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>${[FAKE_ADDRESSBOOK, ...this.otherBooks.keys(), "z-server-generated--system"].map(book).join("")}</d:multistatus>`,
        { status: 207 }
      );
    }
    if (path.startsWith(BOOKS_HOME)) {
      const bookName = path.slice(BOOKS_HOME.length).split("/")[0];
      const book =
        bookName === FAKE_ADDRESSBOOK
          ? { cards: this.cards, readOnly: false, advertise: true }
          : bookName === "z-server-generated--system"
            ? { cards: new Map<string, string>(), readOnly: true, advertise: true }
            : this.otherBooks.get(bookName);
      if (!book) return new Response("", { status: 404 });
      const prefix = `${BOOKS_HOME}${bookName}/`;
      if (method === "REPORT" && path === prefix) {
        const responses = [...book.cards].map(
          ([name, data], i) =>
            `<d:response><d:href>${BOOKS_HOME}${encodeURIComponent(bookName)}/${encodeURIComponent(name)}</d:href><d:propstat><d:prop><d:getetag>&quot;e${i}&quot;</d:getetag><card:address-data>${data.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</card:address-data></d:prop></d:propstat></d:response>`
        );
        return new Response(
          `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">${responses.join("")}</d:multistatus>`,
          { status: 207 }
        );
      }
      if (method === "PUT" && (book.readOnly || bookName !== FAKE_ADDRESSBOOK)) {
        if (book.readOnly) return new Response("", { status: 403 });
        book.cards.set(path.slice(prefix.length), req.body);
        return new Response(null, { status: 204 });
      }
    }

    if (method === "PUT" && path.startsWith(CARDS)) {
      const name = path.slice(CARDS.length);
      if (this.cards.has(name) && req.headers["if-none-match"] === "*") {
        return new Response("", { status: 412 });
      }
      this.cards.set(name, req.body);
      return new Response("", { status: 201 });
    }

    if (path.startsWith(FILES)) {
      const folder = path.slice(FILES.length).replace(/\/+$/, "");
      if (method === "PROPFIND") {
        const fileId = this.folders.get(folder);
        if (fileId === undefined) return new Response("", { status: 404 });
        return new Response(
          `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response><d:propstat><d:prop><oc:fileid>${fileId}</oc:fileid></d:prop></d:propstat></d:response></d:multistatus>`,
          { status: 207 }
        );
      }
      if (method === "MKCOL") {
        if (this.folders.has(folder)) return new Response("", { status: 405 });
        const parent = folder.split("/").slice(0, -1).join("/");
        if (!this.folders.has(parent)) return new Response("", { status: 409 });
        this.folders.set(folder, this.nextFileId++);
        return new Response("", { status: 201 });
      }
    }

    return new Response("", { status: 501 });
  }
}
