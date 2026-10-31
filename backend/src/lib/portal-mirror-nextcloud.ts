import { type NextcloudConfig, portalMirrorRequest } from "./nextcloud";
import type { ColumnSpec } from "./portal-mirror-render";
import type { TableColumn } from "./sales-lead-mapping";
import { NextcloudBadResponseError, parseJson, positiveInt } from "./sales-lead-nextcloud";

// Nextcloud Tables v1 REST calls for the portal mirror, as the API's service account. They go
// through the mirror's own circuit breaker (portalMirrorRequest) with fixed, PII-free labels.
// Request shapes were verified live against Tables 2.4.0. Tables rows are never shared with
// write permission: see shareBody.

const TABLES_BASE = "/index.php/apps/tables/api/1";
const ROW_PAGE_SIZE = 200;
const MAX_ROW_PAGES = 100;

export interface MirrorTable {
  id: number;
  title: string;
  ownership: string | null;
}

export interface MirrorRow {
  id: number;
  cells: Map<number, unknown>;
}

export interface MirrorShare {
  receiver: string;
  receiverType: string;
}

// The one place a column request body is built.
export function columnBody(spec: ColumnSpec): Record<string, unknown> {
  switch (spec.type) {
    case "number":
      // No subtype: Tables rejects an empty one for numbers.
      return {
        title: spec.title,
        type: "number",
        ...(spec.prefix ? { numberPrefix: spec.prefix } : {}),
        numberDecimals: spec.decimals ?? 0,
        mandatory: false,
      };
    case "datetime":
      return { title: spec.title, type: "datetime", subtype: "", mandatory: false };
    default:
      return { title: spec.title, type: "text", subtype: "line", mandatory: false };
  }
}

// Read only, always. Create, update, delete and manage are never granted.
export function shareBody(tableId: number, group: string): Record<string, unknown> {
  return {
    nodeId: tableId,
    nodeType: "table",
    receiver: group,
    receiverType: "group",
    permissionRead: true,
    permissionCreate: false,
    permissionUpdate: false,
    permissionDelete: false,
    permissionManage: false,
  };
}

const JSON_HEADERS = { "content-type": "application/json" };

export class PortalMirrorNextcloud {
  private lastCallAt = 0;

  /** `minGapMs` spaces calls out (5 per second at 200) so a backfill cannot hammer Nextcloud. */
  constructor(
    private readonly nc: NextcloudConfig,
    private readonly minGapMs = 200
  ) {}

  get serviceUsername(): string {
    return this.nc.username;
  }

  private async call(request: Parameters<typeof portalMirrorRequest>[1]) {
    const wait = this.lastCallAt + this.minGapMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastCallAt = Date.now();
    return portalMirrorRequest(this.nc, request);
  }

  async listTables(): Promise<MirrorTable[]> {
    const label = "mirror.list_tables";
    const res = await this.call({ method: "GET", label, path: `${TABLES_BASE}/tables` });
    const tables = parseJson(res.body, label);
    if (!Array.isArray(tables)) throw new NextcloudBadResponseError(label);
    return tables.map((t: { id?: unknown; title?: unknown; ownership?: unknown }) => ({
      id: positiveInt(t.id, label),
      title: typeof t.title === "string" ? t.title : "",
      ownership: typeof t.ownership === "string" ? t.ownership : null,
    }));
  }

  async createTable(title: string, emoji: string): Promise<number> {
    const label = "mirror.create_table";
    const res = await this.call({
      method: "POST",
      label,
      path: `${TABLES_BASE}/tables`,
      headers: JSON_HEADERS,
      body: JSON.stringify({ title, emoji, template: "custom" }),
    });
    return positiveInt((parseJson(res.body, label) as { id?: unknown } | null)?.id, label);
  }

  async getColumns(tableId: number): Promise<TableColumn[]> {
    const label = "mirror.columns";
    const res = await this.call({
      method: "GET",
      label,
      path: `${TABLES_BASE}/tables/${tableId}/columns`,
    });
    const columns = parseJson(res.body, label);
    if (!Array.isArray(columns)) throw new NextcloudBadResponseError(label);
    return columns as TableColumn[];
  }

  async createColumn(tableId: number, spec: ColumnSpec): Promise<number> {
    const label = "mirror.create_column";
    const res = await this.call({
      method: "POST",
      label,
      path: `${TABLES_BASE}/tables/${tableId}/columns`,
      headers: JSON_HEADERS,
      body: JSON.stringify(columnBody(spec)),
    });
    return positiveInt((parseJson(res.body, label) as { id?: unknown } | null)?.id, label);
  }

  async listShares(tableId: number): Promise<MirrorShare[]> {
    const label = "mirror.list_shares";
    const res = await this.call({
      method: "GET",
      label,
      path: `${TABLES_BASE}/tables/${tableId}/shares`,
    });
    const shares = parseJson(res.body, label);
    if (!Array.isArray(shares)) throw new NextcloudBadResponseError(label);
    return shares.map((s: { receiver?: unknown; receiverType?: unknown }) => ({
      receiver: typeof s.receiver === "string" ? s.receiver : "",
      receiverType: typeof s.receiverType === "string" ? s.receiverType : "",
    }));
  }

  async shareReadOnly(tableId: number, group: string): Promise<void> {
    await this.call({
      method: "POST",
      label: "mirror.create_share",
      path: `${TABLES_BASE}/shares`,
      headers: JSON_HEADERS,
      body: JSON.stringify(shareBody(tableId, group)),
    });
  }

  private toRow(raw: unknown, label: string): MirrorRow {
    const row = (raw ?? {}) as { id?: unknown; data?: { columnId?: unknown; value?: unknown }[] };
    if (!Array.isArray(row.data)) throw new NextcloudBadResponseError(label);
    return {
      id: positiveInt(row.id, label),
      cells: new Map(
        row.data
          .filter((c) => typeof c.columnId === "number")
          .map((c) => [c.columnId as number, c.value])
      ),
    };
  }

  /** Every row of the table; refuses a table too large to scan rather than miss a row. */
  async listRows(tableId: number): Promise<MirrorRow[]> {
    const label = "mirror.list_rows";
    const rows: MirrorRow[] = [];
    for (let page = 0; page < MAX_ROW_PAGES; page++) {
      const res = await this.call({
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

  async createRow(tableId: number, data: Record<string, unknown>): Promise<number> {
    const label = "mirror.create_row";
    const res = await this.call({
      method: "POST",
      label,
      path: `${TABLES_BASE}/tables/${tableId}/rows`,
      headers: JSON_HEADERS,
      body: JSON.stringify({ data }),
    });
    return positiveInt((parseJson(res.body, label) as { id?: unknown } | null)?.id, label);
  }

  /** Not table-scoped. A 404 means the row was deleted in Nextcloud: the caller re-creates it. */
  async updateRow(rowId: number, data: Record<string, unknown>): Promise<void> {
    await this.call({
      method: "PUT",
      label: "mirror.update_row",
      path: `${TABLES_BASE}/rows/${rowId}`,
      headers: JSON_HEADERS,
      body: JSON.stringify({ data }),
    });
  }

  async deleteRow(rowId: number): Promise<void> {
    await this.call({
      method: "DELETE",
      label: "mirror.delete_row",
      path: `${TABLES_BASE}/rows/${rowId}`,
      okStatuses: [404],
    });
  }
}
