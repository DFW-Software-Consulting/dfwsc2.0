// In-memory stand-in for the Nextcloud APIs the client onboarding calls: Forms v3,
// Tables v1, CardDAV, WebDAV, Collectives, Circles (Teams) and files_sharing. Column ids, option ids and the
// existing CP-001/CP-002 rows mirror the live instance (Tables 2.4, read
// 2026-10-31). Install it with vi.stubGlobal("fetch", fake.fetch).

export const ONB_NC_BASE = "https://cloud.test";
export const ONB_NC_USER = "dfwsc-admin";
export const ONB_FORM_ID = 2;
export const ONB_FORM_HASH = "9KaxpC5GXeGoWY44";
export const ONB_PROJECTS_TABLE = 6;
export const ONB_PIPELINE_TABLE = 8;
export const ONB_ADDRESSBOOK = "dfwsc-sales_shared_by_messyginger0804";
export const ONB_CLIENTS_FOLDER = "clients";
export const ONB_COLLECTIVE_ID = 1;
export const ONB_PROJECTS_PAGE_ID = 4562;
export const ONB_WEBHOOK_SECRET = "s3cret-for-tests-0123456789abcdefghij";
/** Team admins used by the per-project Teams tests; the second id has a space, like real ones can. */
/** What Collectives writes to a new collective's landing page. */
export const WELCOME_TEXT =
  "# Welcome \u{1F4CB} CP-003 Warehouse Portal\n\nAdd pages with the \u2795 button.\n\nPress `\u270F\uFE0F Edit` to change this page.\n";
export const ONB_TEAM_ADMINS = ["ops-lead", "Jane Doe"];

export const onboardingEnv = (overrides: Record<string, string | undefined> = {}) =>
  ({
    CLIENT_ONBOARDING_ENABLED: "true",
    NEXTCLOUD_BASE_URL: ONB_NC_BASE,
    NEXTCLOUD_USERNAME: ONB_NC_USER,
    NEXTCLOUD_APP_PASSWORD: "app-password-for-tests",
    CLIENT_ONBOARDING_FORM_ID: String(ONB_FORM_ID),
    CLIENT_ONBOARDING_PROJECTS_TABLE_ID: String(ONB_PROJECTS_TABLE),
    CLIENT_ONBOARDING_PIPELINE_TABLE_ID: String(ONB_PIPELINE_TABLE),
    CLIENT_ONBOARDING_ADDRESSBOOK_PATH: ONB_ADDRESSBOOK,
    CLIENT_ONBOARDING_CLIENTS_FOLDER: ONB_CLIENTS_FOLDER,
    CLIENT_ONBOARDING_COLLECTIVE_ID: String(ONB_COLLECTIVE_ID),
    CLIENT_ONBOARDING_WEBHOOK_SECRET: ONB_WEBHOOK_SECRET,
    ...overrides,
  }) as NodeJS.ProcessEnv;

/** Env with CLIENT_ONBOARDING_PROJECT_TEAMS on. */
export const onboardingTeamsEnv = (overrides: Record<string, string | undefined> = {}) =>
  onboardingEnv({
    CLIENT_ONBOARDING_PROJECT_TEAMS: "true",
    CLIENT_ONBOARDING_TEAM_ADMINS: ONB_TEAM_ADMINS.join(", "),
    ...overrides,
  });

export const INTAKE_QUESTIONS = {
  company: 201,
  contact_name: 202,
  email: 203,
  phone: 204,
  project_name: 205,
  start_date: 206,
  target_date: 207,
  summary: 208,
  lead_link: 209,
} as const;

/** Optional question, not on the default form; tests add it to fake.questions. */
export const BILLING_EMAIL_QUESTION = { id: 210, name: "billing_email", text: "Billing email" };
const ALL_QUESTION_IDS = { ...INTAKE_QUESTIONS, billing_email: BILLING_EMAIL_QUESTION.id };

export type IntakeAnswers = Partial<Record<keyof typeof ALL_QUESTION_IDS, string>>;

export const PROJECT_COLUMNS = {
  "Project Code": 26,
  "Project Name": 27,
  Status: 28,
  Owner: 29,
  "Start Date": 30,
  "Target Date": 31,
  "Project Folder": 32,
  "Project Page": 33,
  "Intake Submission": 34,
  Summary: 35,
} as const;

export const PIPELINE_COLUMNS = {
  Company: 46,
  "Contact Name": 47,
  Stage: 49,
  "Cerebo Project": 57,
  "Lead Ref": 59,
} as const;

export function projectColumns() {
  return [
    { id: 26, title: "Project Code", type: "text", subtype: "line" },
    { id: 27, title: "Project Name", type: "text", subtype: "line" },
    {
      id: 28,
      title: "Status",
      type: "selection",
      subtype: "",
      selectionOptions: ["Intake", "Active", "Blocked", "Complete", "Archived"].map(
        (label, id) => ({ id, label })
      ),
    },
    { id: 29, title: "Owner", type: "usergroup", subtype: "" },
    { id: 30, title: "Start Date", type: "datetime", subtype: "date" },
    { id: 31, title: "Target Date", type: "datetime", subtype: "date" },
    { id: 32, title: "Project Folder", type: "text", subtype: "link" },
    { id: 33, title: "Project Page", type: "text", subtype: "link" },
    { id: 34, title: "Intake Submission", type: "text", subtype: "link" },
    { id: 35, title: "Summary", type: "text", subtype: "rich" },
  ];
}

export function pipelineColumns() {
  return [
    { id: 59, title: "Lead Ref", type: "text", subtype: "line" },
    { id: 46, title: "Company", type: "text", subtype: "line" },
    { id: 47, title: "Contact Name", type: "text", subtype: "line" },
    {
      id: 49,
      title: "Stage",
      type: "selection",
      subtype: "",
      selectionOptions: [
        "New Lead",
        "Contacted",
        "Qualified",
        "Proposal Sent",
        "Won",
        "Lost",
        "Nurture",
      ].map((label, id) => ({ id, label })),
    },
    { id: 57, title: "Cerebo Project", type: "text", subtype: "link" },
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
  status?: number;
  timeout?: boolean;
  /** With `timeout`: the request takes effect first (a lost response). */
  afterApply?: boolean;
  times: number;
}

interface Row {
  id: number;
  tableId: number;
  data: Map<number, unknown>;
}

interface Card {
  data: string;
  etag: number;
}

interface Page {
  id: number;
  parentId: number;
  title: string;
  fileName: string;
  filePath: string;
}

export interface FakeTeam {
  id: string;
  name: string;
  /** The service account's level (9 owner, 8 admin, 1 member). */
  initiatorLevel: number;
  members: { id: string; userId: string; level: number; status?: string }[];
}

interface FakeWiki {
  id: number;
  name: string;
  circleId: string;
  path: string;
  pages: Page[];
}

export interface FakeShare {
  id: number;
  path: string;
  shareType: number;
  shareWith: string;
  permissions: number;
}

interface Submission {
  userId: string;
  answers: IntakeAnswers;
}

const FORMS = `/ocs/v2.php/apps/forms/api/v3/forms/${ONB_FORM_ID}`;
const TABLES = "/index.php/apps/tables/api/1";
const BOOKS_HOME = `/remote.php/dav/addressbooks/users/${ONB_NC_USER}/`;
const FILES = `/remote.php/dav/files/${ONB_NC_USER}/`;
const COLLECTIVES = "/ocs/v2.php/apps/collectives/api/v1.0/collectives";
const CIRCLES = "/ocs/v2.php/apps/circles/circles";
const SHARES = "/ocs/v2.php/apps/files_sharing/api/v1/shares";
/** Where the collective is mounted in the service account's files. */
export const ONB_COLLECTIVE_PATH = ".Collectives/Cerebo Pilot";

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#13;");
}

export class FakeOnboardingNextcloud {
  readonly requests: RecordedRequest[] = [];
  submissions = new Map<number, Submission>();
  questions: { id: number; name: string; text: string }[] = Object.entries(INTAKE_QUESTIONS).map(
    ([name, id]) => ({ id, name, text: name })
  );
  columns: Record<number, Record<string, unknown>[]> = {
    [ONB_PROJECTS_TABLE]: projectColumns(),
    [ONB_PIPELINE_TABLE]: pipelineColumns(),
  };
  rows: Row[] = [
    {
      id: 27,
      tableId: ONB_PROJECTS_TABLE,
      data: new Map<number, unknown>([
        [26, "CP-001"],
        [27, "Pilot Workspace Validation"],
        [28, 1],
      ]),
    },
    {
      id: 28,
      tableId: ONB_PROJECTS_TABLE,
      data: new Map<number, unknown>([
        [26, "CP-002"],
        [27, "Internal Knowledge Cleanup"],
        [28, 0],
      ]),
    },
  ];
  cards = new Map<string, Card>();
  /** Address books besides the configured one (own or shared with the account). */
  otherBooks = new Map<
    string,
    { cards: Map<string, Card>; readOnly: boolean; advertise: boolean }
  >();
  folders = new Map<string, number>([[ONB_CLIENTS_FOLDER, 700]]);
  files = new Map<string, string>();
  collectiveSlug: string | null = "Cerebo-Pilot";
  /** Page JSON leaves out collectivePath when false (collective not mounted). */
  collectiveMounted = true;
  pages: Page[] = [
    { id: 4558, parentId: 0, title: "Landing page", fileName: "Readme.md", filePath: "" },
    { id: 4562, parentId: 4558, title: "Projects", fileName: "Readme.md", filePath: "Projects" },
    {
      id: 4565,
      parentId: 4562,
      title: "CP-001 — Pilot Workspace Validation",
      fileName: "CP-001 — Pilot Workspace Validation.md",
      filePath: "Projects",
    },
  ];
  /** Teams (Circles). Created ones are owned by the service account. */
  teams: FakeTeam[] = [];
  /** Collectives other than the Client Projects one. */
  wikis: FakeWiki[] = [];
  shares: FakeShare[] = [];
  /** Content of a new collective's landing page (the real one may carry a welcome text). */
  wikiLandingSeed = WELCOME_TEXT;
  /** Collectives builds the collective on a brand-new team instead of reusing the existing one. */
  wikiIgnoresTeam = false;
  /** Answer share creation with 403 (no reshare rights on the path). */
  shareForbidden = false;
  latencyMs = 0;
  /** Row updates still to answer 200 without storing anything. */
  droppedRowUpdates = 0;
  private faults: Fault[] = [];
  private nextRowId = 1000;
  private nextFileId = 900;
  private nextPageId = 5000;
  private nextTeamId = 1;
  private nextMemberId = 1;
  private nextShareId = 50;
  private nextWikiId = 10;
  private nextEtag = 1;
  /** Runs once, right before a page-file PUT is evaluated (to simulate a race). */
  beforePut: ((rel: string) => void) | null = null;
  /** Content of a newly created page file; null creates no file (GET answers 404). */
  seedPageFile: string | null = "";
  /** How GETs of page files present their ETag. */
  etagMode: "strong" | "weak" | "none" = "strong";
  private fileVersions = new Map<string, number>();

  private etagHeaders(rel: string): Record<string, string> {
    if (this.etagMode === "none") return {};
    const tag = `"f${this.fileVersion(rel)}"`;
    return { etag: this.etagMode === "weak" ? `W/${tag}` : tag };
  }

  private fileVersion(rel: string): number {
    return this.fileVersions.get(rel) ?? 0;
  }

  /** A person edits a page file: new content and a new ETag. */
  editFile(rel: string, content: string) {
    this.files.set(rel, content);
    this.fileVersions.set(rel, this.fileVersion(rel) + 1);
  }

  addSubmission(id: number, answers: IntakeAnswers, userId = "messyginger0804") {
    this.submissions.set(id, { userId, answers });
  }

  addLead(id: number, company: string, extra: Record<number, unknown> = {}) {
    this.rows.push({
      id,
      tableId: ONB_PIPELINE_TABLE,
      data: new Map<number, unknown>([
        [46, company],
        [49, 0],
        ...Object.entries(extra).map(([k, v]) => [Number(k), v] as [number, unknown]),
      ]),
    });
  }

  addCard(name: string, data: string) {
    this.cards.set(name, { data, etag: this.nextEtag++ });
  }

  /** Another address book the account can see; a read-only one refuses writes with 403. */
  /** `advertise: false` hides the privilege set, so a read-only book only shows as a 403. */
  addBook(name: string, readOnly = false, advertise = true) {
    this.otherBooks.set(name, { cards: new Map(), readOnly, advertise });
  }

  addCardTo(book: string, name: string, data: string) {
    this.otherBooks.get(book)?.cards.set(name, { data, etag: this.nextEtag++ });
  }

  fail(fault: Omit<Fault, "times"> & { times?: number }) {
    this.faults.push({ times: 1, ...fault });
  }

  row(id: number): Row | undefined {
    return this.rows.find((r) => r.id === id);
  }

  projectRows(): Row[] {
    return this.rows.filter((r) => r.tableId === ONB_PROJECTS_TABLE);
  }

  rowCell(rowId: number, columnId: number): unknown {
    return this.row(rowId)?.data.get(columnId);
  }

  /** URL stored in a link cell, or undefined. */
  linkUrl(rowId: number, columnId: number): string | undefined {
    const raw = this.rowCell(rowId, columnId);
    return typeof raw === "string" ? (JSON.parse(raw) as { value: string }).value : undefined;
  }

  writes(): RecordedRequest[] {
    return this.requests.filter((r) => !["GET", "PROPFIND", "REPORT"].includes(r.method));
  }

  count(method: string, pathPart: string): number {
    return this.requests.filter((r) => r.method === method && r.path.includes(pathPart)).length;
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

  private isLinkColumn(tableId: number, columnId: number): boolean {
    return this.columns[tableId]?.some((c) => c.id === columnId && c.subtype === "link") ?? false;
  }

  private storedValue(tableId: number, columnId: number, value: unknown): unknown {
    const link = typeof value === "string" ? /^(.*) \((\S+)\)$/.exec(value) : null;
    if (!this.isLinkColumn(tableId, columnId) || !link) return value;
    return JSON.stringify({ title: link[1], value: link[2], providerId: "url" }).replace(
      /\//g,
      "\\/"
    );
  }

  private submissionData(id: number) {
    const sub = this.submissions.get(id) as Submission;
    const answers = Object.entries(sub.answers).map(([name, text], i) => ({
      id: id * 100 + i,
      submissionId: id,
      questionId: ALL_QUESTION_IDS[name as keyof typeof ALL_QUESTION_IDS],
      text,
    }));
    return { id, formId: ONB_FORM_ID, userId: sub.userId, timestamp: id, answers };
  }

  private pageJson(p: Page, collectivePath = ONB_COLLECTIVE_PATH) {
    return {
      ...p,
      slug: p.title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
      collectivePath: this.collectiveMounted ? collectivePath : null,
    };
  }

  team(name: string): FakeTeam | undefined {
    return this.teams.find((t) => t.name === name);
  }

  /** A team already there (someone made it by hand), owned by the service account unless `level` says otherwise. */
  addTeam(name: string, initiatorLevel = 9): FakeTeam {
    const team: FakeTeam = {
      id: `team${String(this.nextTeamId++).padStart(4, "0")}`,
      name,
      initiatorLevel,
      members:
        initiatorLevel >= 8
          ? [{ id: `m${this.nextMemberId++}`, userId: ONB_NC_USER, level: 9 }]
          : [],
    };
    this.teams.push(team);
    return team;
  }

  wiki(name: string): FakeWiki | undefined {
    return this.wikis.find((w) => w.name === name);
  }

  /** Path of a wiki's landing page file, as used in `files`. */
  wikiLandingFile(name: string): string {
    return `.Collectives/${name}/Readme.md`;
  }

  private teamJson(t: FakeTeam) {
    return { id: t.id, name: t.name, initiator: { level: t.initiatorLevel } };
  }

  private memberJson(m: FakeTeam["members"][number]) {
    return {
      id: m.id,
      userId: m.userId,
      userType: 1,
      level: m.level,
      status: m.status ?? "Member",
    };
  }

  private shareJson(sh: FakeShare) {
    return {
      id: String(sh.id),
      share_type: sh.shareType,
      share_with: sh.shareWith,
      path: sh.path,
      permissions: sh.permissions,
    };
  }

  private handleTeams(req: RecordedRequest): Response | null {
    const { method, path } = req;
    if (path === CIRCLES && method === "GET") {
      return this.ocs(this.teams.filter((t) => t.initiatorLevel > 0).map((t) => this.teamJson(t)));
    }
    if (path === CIRCLES && method === "POST") {
      const { name } = JSON.parse(req.body) as { name: string };
      if (this.teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
        return this.json({ ocs: { meta: { status: "failure" }, data: [] } }, 400);
      }
      return this.ocs(this.teamJson(this.addTeam(name)));
    }
    const members = new RegExp(`^${CIRCLES}/([^/]+)/members$`).exec(path);
    if (members) {
      const team = this.teams.find((t) => t.id === members[1]);
      if (!team) return this.json({}, 404);
      if (method === "GET") return this.ocs(team.members.map((m) => this.memberJson(m)));
      if (method === "POST") {
        const { userId } = JSON.parse(req.body) as { userId: string };
        const added = { id: `m${this.nextMemberId++}`, userId, level: 1 };
        team.members.push(added);
        return this.ocs(this.memberJson(added));
      }
    }
    const level = new RegExp(`^${CIRCLES}/([^/]+)/members/([^/]+)/level$`).exec(path);
    if (level && method === "PUT") {
      const member = this.teams
        .find((t) => t.id === level[1])
        ?.members.find((m) => m.id === level[2]);
      if (!member) return this.json({}, 404);
      member.level = (JSON.parse(req.body) as { level: number }).level;
      return this.ocs(this.memberJson(member));
    }
    return null;
  }

  private handleShares(req: RecordedRequest, url: URL): Response | null {
    if (req.path !== SHARES) return null;
    if (req.method === "GET") {
      const wanted = url.searchParams.get("path");
      return this.ocs(this.shares.filter((s) => s.path === wanted).map((s) => this.shareJson(s)));
    }
    if (req.method === "POST") {
      if (this.shareForbidden) return this.json({ ocs: { meta: {}, data: [] } }, 403);
      const body = JSON.parse(req.body) as {
        path: string;
        shareType: number;
        shareWith: string;
        permissions: number;
      };
      if (!this.folders.has(body.path.replace(/^\//, ""))) {
        return this.json({ ocs: { meta: {}, data: [] } }, 404);
      }
      const share: FakeShare = { id: this.nextShareId++, ...body };
      this.shares.push(share);
      return this.ocs(this.shareJson(share));
    }
    return null;
  }

  private createWiki(name: string): Response {
    // Like Collectives: a team of that name is reused when the caller is its admin.
    let team = this.wikiIgnoresTeam ? undefined : this.team(name);
    if (team && team.initiatorLevel < 8) {
      return this.json({ ocs: { meta: {}, data: [] } }, 400);
    }
    team ??= this.addTeam(this.wikiIgnoresTeam ? `${name} (new)` : name);
    if (this.wikis.some((w) => w.circleId === team.id)) {
      return this.json({ ocs: { meta: {}, data: [] } }, 400);
    }
    const id = this.nextWikiId++;
    const landing: Page = {
      id: this.nextPageId++,
      parentId: 0,
      title: name,
      fileName: "Readme.md",
      filePath: "",
    };
    const wiki: FakeWiki = {
      id,
      name,
      circleId: team.id,
      path: `.Collectives/${name}`,
      pages: [landing],
    };
    this.wikis.push(wiki);
    this.files.set(this.wikiLandingFile(name), this.wikiLandingSeed);
    return this.ocs({
      collective: { id, name, slug: name.replace(/[^A-Za-z0-9]+/g, "-"), circleId: team.id },
      info: "",
    });
  }

  private rowJson(r: Row) {
    return {
      id: r.id,
      tableId: r.tableId,
      data: [...r.data]
        .filter(([, value]) => value !== null && value !== undefined && value !== "")
        .map(([columnId, value]) => ({ columnId, value })),
    };
  }

  private handle(req: RecordedRequest, url: URL): Response {
    const { method, path } = req;
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const offset = Number(url.searchParams.get("offset") ?? 0);

    // Forms
    if (method === "GET" && path === `${FORMS}/submissions`) {
      const ids = [...this.submissions.keys()].sort((a, b) => b - a).slice(offset, offset + limit);
      return this.ocs({ submissions: ids.map((id) => this.submissionData(id)) });
    }
    const single = new RegExp(`^${FORMS}/submissions/(\\d+)$`).exec(path);
    if (method === "GET" && single) {
      const id = Number(single[1]);
      if (!this.submissions.has(id)) return this.json({ ocs: { meta: {}, data: [] } }, 404);
      return this.ocs(this.submissionData(id));
    }
    if (method === "GET" && path === FORMS) {
      return this.ocs({ id: ONB_FORM_ID, hash: ONB_FORM_HASH, questions: this.questions });
    }

    // Tables
    const columns = new RegExp(`^${TABLES}/tables/(\\d+)/columns$`).exec(path);
    if (method === "GET" && columns) {
      const cols = this.columns[Number(columns[1])];
      return cols ? this.json(cols) : this.json({ message: "not found" }, 404);
    }
    const tableRows = new RegExp(`^${TABLES}/tables/(\\d+)/rows$`).exec(path);
    if (tableRows) {
      const tableId = Number(tableRows[1]);
      if (method === "GET") {
        return this.json(
          this.rows
            .filter((r) => r.tableId === tableId)
            .slice(offset, offset + limit)
            .map((r) => this.rowJson(r))
        );
      }
      if (method === "POST") {
        const { data } = JSON.parse(req.body) as { data: Record<string, unknown> };
        const row: Row = {
          id: this.nextRowId++,
          tableId,
          data: new Map(Object.entries(data).map(([k, v]) => [Number(k), v])),
        };
        this.rows.push(row);
        return this.json({ id: row.id, tableId });
      }
    }
    const oneRow = new RegExp(`^${TABLES}/rows/(\\d+)$`).exec(path);
    if (oneRow) {
      const row = this.row(Number(oneRow[1]));
      if (!row) return this.json({ message: "not found" }, 404);
      if (method === "GET") return this.json(this.rowJson(row));
      if (method === "PUT") {
        const { data } = JSON.parse(req.body) as { data: Record<string, unknown> };
        // Like Tables 2.4: a JSON link value gets a 200 and nothing is stored.
        const jsonLink = Object.entries(data).some(
          ([k, v]) =>
            this.isLinkColumn(row.tableId, Number(k)) &&
            typeof v === "string" &&
            v.trim().startsWith("{")
        );
        if (this.droppedRowUpdates > 0 || jsonLink) {
          this.droppedRowUpdates = Math.max(this.droppedRowUpdates - 1, 0);
          return this.json({ id: row.id });
        }
        for (const [k, v] of Object.entries(data)) {
          row.data.set(Number(k), this.storedValue(row.tableId, Number(k), v));
        }
        return this.json({ id: row.id });
      }
    }

    // CardDAV
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
        `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:response><d:href>${BOOKS_HOME}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>${[ONB_ADDRESSBOOK, ...this.otherBooks.keys(), "z-server-generated--system"].map(book).join("")}</d:multistatus>`,
        { status: 207 }
      );
    }
    if (path.startsWith(BOOKS_HOME)) {
      const bookName = path.slice(BOOKS_HOME.length).split("/")[0];
      const other = this.otherBooks.get(bookName);
      const book =
        bookName === ONB_ADDRESSBOOK
          ? { cards: this.cards, readOnly: false, advertise: true }
          : bookName === "z-server-generated--system"
            ? { cards: new Map<string, Card>(), readOnly: true, advertise: true }
            : other;
      if (!book) return new Response("", { status: 404 });
      const collection = `${BOOKS_HOME}${encodeURIComponent(bookName)}/`;
      if (method === "REPORT" && path === `${BOOKS_HOME}${bookName}/`) {
        const responses = [...book.cards].map(
          ([name, card]) =>
            `<d:response><d:href>${collection}${encodeURIComponent(name)}</d:href><d:propstat><d:prop><d:getetag>&quot;${card.etag}&quot;</d:getetag><card:address-data>${xmlEscape(card.data)}</card:address-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
        );
        return new Response(
          `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">${responses.join("")}</d:multistatus>`,
          { status: 207 }
        );
      }
      if (method === "PUT") {
        if (book.readOnly) return new Response("", { status: 403 });
        const name = path.slice(`${BOOKS_HOME}${bookName}/`.length);
        const existing = book.cards.get(name);
        if (existing && req.headers["if-none-match"] === "*")
          return new Response("", { status: 412 });
        const ifMatch = req.headers["if-match"];
        if (ifMatch && (!existing || ifMatch !== `"${existing.etag}"`)) {
          return new Response("", { status: 412 });
        }
        book.cards.set(name, { data: req.body, etag: this.nextEtag++ });
        return new Response(null, { status: existing ? 204 : 201 });
      }
    }

    // WebDAV
    if (path.startsWith(FILES)) {
      const rel = path.slice(FILES.length).replace(/\/+$/, "");
      if (method === "PROPFIND") {
        const fileId = this.folders.get(rel);
        if (fileId === undefined) return new Response("", { status: 404 });
        return new Response(
          `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response><d:propstat><d:prop><oc:fileid>${fileId}</oc:fileid></d:prop></d:propstat></d:response></d:multistatus>`,
          { status: 207 }
        );
      }
      if (method === "MKCOL") {
        if (this.folders.has(rel)) return new Response("", { status: 405 });
        const parent = rel.split("/").slice(0, -1).join("/");
        if (!this.folders.has(parent)) return new Response("", { status: 409 });
        this.folders.set(rel, this.nextFileId++);
        return new Response("", { status: 201 });
      }
      if (method === "GET") {
        const body = this.files.get(rel);
        if (body === undefined) return new Response("", { status: 404 });
        return new Response(body, {
          status: 200,
          headers: this.etagHeaders(rel),
        });
      }
      if (method === "PUT") {
        const hook = this.beforePut;
        this.beforePut = null;
        hook?.(rel);
        const ifMatch = req.headers["if-match"];
        if (ifMatch && ifMatch !== `"f${this.fileVersion(rel)}"`) {
          return new Response("", { status: 412 });
        }
        this.files.set(rel, req.body);
        this.fileVersions.set(rel, this.fileVersion(rel) + 1);
        return new Response(null, { status: 204 });
      }
    }

    // Teams and shares
    const teamAnswer = this.handleTeams(req);
    if (teamAnswer) return teamAnswer;
    const shareAnswer = this.handleShares(req, url);
    if (shareAnswer) return shareAnswer;

    // Collectives
    if (method === "GET" && path === COLLECTIVES) {
      return this.ocs({
        collectives: [
          { id: ONB_COLLECTIVE_ID, name: "Cerebo Pilot", slug: this.collectiveSlug },
          ...this.wikis.map((w) => ({
            id: w.id,
            name: w.name,
            slug: w.name.replace(/[^A-Za-z0-9]+/g, "-"),
            circleId: w.circleId,
          })),
        ],
      });
    }
    if (method === "POST" && path === COLLECTIVES) {
      return this.createWiki((JSON.parse(req.body) as { name: string }).name);
    }
    const wikiPages = new RegExp(`^${COLLECTIVES}/(\\d+)/pages$`).exec(path);
    if (method === "GET" && wikiPages && Number(wikiPages[1]) !== ONB_COLLECTIVE_ID) {
      const wiki = this.wikis.find((w) => w.id === Number(wikiPages[1]));
      return wiki
        ? this.ocs({ pages: wiki.pages.map((p) => this.pageJson(p, wiki.path)) })
        : this.json({}, 404);
    }
    if (method === "GET" && path === `${COLLECTIVES}/${ONB_COLLECTIVE_ID}/pages`) {
      return this.ocs({ pages: this.pages.map((p) => this.pageJson(p)) });
    }
    const page = new RegExp(`^${COLLECTIVES}/${ONB_COLLECTIVE_ID}/pages/(\\d+)$`).exec(path);
    if (page && method === "GET") {
      const found = this.pages.find((p) => p.id === Number(page[1]));
      return found ? this.ocs({ page: this.pageJson(found) }) : this.json({}, 404);
    }
    if (page && method === "POST") {
      const parent = this.pages.find((p) => p.id === Number(page[1]));
      if (!parent) return this.json({}, 404);
      const { title } = JSON.parse(req.body) as { title: string };
      const created: Page = {
        id: this.nextPageId++,
        parentId: parent.id,
        title,
        fileName: `${title}.md`,
        filePath: parent.filePath,
      };
      this.pages.push(created);
      if (this.seedPageFile !== null) {
        this.files.set(
          `${ONB_COLLECTIVE_PATH}/${created.filePath}/${created.fileName}`,
          this.seedPageFile
        );
      }
      return this.ocs({ page: this.pageJson(created) });
    }

    return new Response("", { status: 501 });
  }
}
