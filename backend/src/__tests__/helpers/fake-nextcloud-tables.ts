// In-memory Nextcloud Tables v1 for the portal mirror tests (shapes verified live against
// Tables 2.4.0). Install with vi.stubGlobal("fetch", vi.fn(fake.fetch)).

export const MIRROR_NC_USER = "dfwsc-admin";
export const MIRROR_NC_URL = "https://nc.test";
const BASE = "/index.php/apps/tables/api/1";

interface FakeColumn {
  id: number;
  title: string;
  type: string;
  subtype?: string;
  numberPrefix?: string;
  numberDecimals?: number;
}
interface FakeTable {
  id: number;
  title: string;
  ownership: string;
}
export interface FakeShareRecord {
  nodeId: number;
  nodeType: string;
  receiver: string;
  receiverType: string;
  permissionRead: boolean;
  permissionCreate: boolean;
  permissionUpdate: boolean;
  permissionDelete: boolean;
  permissionManage: boolean;
}
export interface FakeRow {
  id: number;
  tableId: number;
  data: Map<number, unknown>;
}
export interface RecordedCall {
  method: string;
  path: string;
  body: string;
}
interface Fault {
  method: string;
  match: RegExp;
  status: number;
  times: number;
}

export const mirrorEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PORTAL_MIRROR: "true",
  NEXTCLOUD_BASE_URL: MIRROR_NC_URL,
  NEXTCLOUD_USERNAME: MIRROR_NC_USER,
  NEXTCLOUD_APP_PASSWORD: "app-password",
  ...extra,
});

export class FakeTablesNextcloud {
  calls: RecordedCall[] = [];
  tables: FakeTable[] = [];
  columns = new Map<number, FakeColumn[]>();
  shares: FakeShareRecord[] = [];
  rows: FakeRow[] = [];
  private faults: Fault[] = [];
  private nextId = 100;

  /** The next `times` requests with this method and a path matching `match` answer `status`. */
  fail(method: string, match: RegExp, status: number, times = 1) {
    this.faults.push({ method, match, status, times });
  }

  rowsOf(tableId: number) {
    return this.rows.filter((r) => r.tableId === tableId);
  }

  columnId(tableId: number, title: string): number {
    const col = this.columns.get(tableId)?.find((c) => c.title === title);
    if (!col) throw new Error(`no column ${title}`);
    return col.id;
  }

  cell(row: FakeRow, title: string): unknown {
    return row.data.get(this.columnId(row.tableId, title));
  }

  callsTo(method: string, match: RegExp) {
    return this.calls.filter((c) => c.method === method && match.test(c.path));
  }

  private json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  private rowJson(row: FakeRow) {
    return {
      id: row.id,
      tableId: row.tableId,
      data: [...row.data.entries()].map(([columnId, value]) => ({ columnId, value })),
    };
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : "";
    const path = url.pathname;
    this.calls.push({ method, path: path + url.search, body });

    const fault = this.faults.find((f) => f.method === method && f.match.test(path) && f.times > 0);
    if (fault) {
      fault.times -= 1;
      return this.json({ message: "fault" }, fault.status);
    }
    if (!path.startsWith(BASE)) return this.json({ message: "not found" }, 404);
    const rel = path.slice(BASE.length);

    if (rel === "/tables" && method === "GET") return this.json(this.tables);
    if (rel === "/tables" && method === "POST") {
      const { title } = JSON.parse(body) as { title: string };
      const table = { id: this.nextId++, title, ownership: MIRROR_NC_USER };
      this.tables.push(table);
      this.columns.set(table.id, []);
      return this.json(table);
    }
    const cols = /^\/tables\/(\d+)\/columns$/.exec(rel);
    if (cols) {
      const list = this.columns.get(Number(cols[1]));
      if (!list) return this.json({ message: "not found" }, 404);
      if (method === "GET") return this.json(list);
      const col = { id: this.nextId++, ...JSON.parse(body) } as FakeColumn;
      list.push(col);
      return this.json(col);
    }
    const shares = /^\/tables\/(\d+)\/shares$/.exec(rel);
    if (shares && method === "GET") {
      return this.json(this.shares.filter((s) => s.nodeId === Number(shares[1])));
    }
    if (rel === "/shares" && method === "POST") {
      const share = JSON.parse(body) as FakeShareRecord;
      this.shares.push(share);
      return this.json(share);
    }
    const tableRows = /^\/tables\/(\d+)\/rows$/.exec(rel);
    if (tableRows) {
      const tableId = Number(tableRows[1]);
      if (method === "GET") {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 100);
        return this.json(
          this.rowsOf(tableId)
            .slice(offset, offset + limit)
            .map((r) => this.rowJson(r))
        );
      }
      const { data } = JSON.parse(body) as { data: Record<string, unknown> };
      const row: FakeRow = {
        id: this.nextId++,
        tableId,
        data: new Map(Object.entries(data).map(([k, v]) => [Number(k), v])),
      };
      this.rows.push(row);
      return this.json({ id: row.id, tableId });
    }
    const oneRow = /^\/rows\/(\d+)$/.exec(rel);
    if (oneRow) {
      const row = this.rows.find((r) => r.id === Number(oneRow[1]));
      if (!row) return this.json({ message: "not found" }, 404);
      if (method === "DELETE") {
        this.rows = this.rows.filter((r) => r !== row);
        return this.json(this.rowJson(row));
      }
      if (method === "PUT") {
        const { data } = JSON.parse(body) as { data: Record<string, unknown> };
        for (const [k, v] of Object.entries(data)) row.data.set(Number(k), v);
        return this.json([...row.data.entries()].map(([columnId, value]) => ({ columnId, value })));
      }
    }
    return this.json({ message: "not found" }, 404);
  };
}
