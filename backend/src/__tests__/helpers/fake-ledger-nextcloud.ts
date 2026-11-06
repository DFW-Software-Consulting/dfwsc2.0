import { vi } from "vitest";

// In-memory stand-in for the Nextcloud apps the ledger sync talks to (NextLedger and the
// OpenRegister "Pipelinq" register). It is stateful, so a retry sees what an earlier attempt wrote.
// Installed as the global fetch: lib/nextcloud.ts sends every request through it.

export const FY_2026 = {
  id: 1,
  name: "FY 2026",
  dateStart: 1767247200,
  dateEnd: 1798783199,
  isActive: true,
};

export interface FakeLedgerCall {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

export interface FakeLedgerOptions {
  /** Years that exist before the sync runs. */
  fiscalYears?: Array<typeof FY_2026>;
  /** Ignore limit/offset/page and filters, like a server that does not know them. */
  ignorePaging?: boolean;
  /** Cap the page size below what the caller asks for, like a server with a smaller maximum. */
  maxPageSize?: number;
  /** Pause before answering a request, to interleave concurrent deliveries. */
  delayMs?: number;
}

interface Row extends Record<string, unknown> {
  id: number | string;
}

export class FakeLedgerNextcloud {
  calls: FakeLedgerCall[] = [];
  fiscalYears: Array<Record<string, unknown>>;
  incomes: Row[] = [];
  expenses: Row[] = [];
  register: Row[] = [];
  private nextId = 100;
  private failures: Array<{ method: string; urlPart: string; remaining: number }> = [];

  constructor(private readonly options: FakeLedgerOptions = {}) {
    this.fiscalYears = [...(options.fiscalYears ?? [FY_2026])];
  }

  /** Make the next `times` matching requests answer 500. */
  failNext(method: string, urlPart: string, times = 1) {
    this.failures.push({ method, urlPart, remaining: times });
  }

  posts(urlPart: string) {
    return this.calls.filter((c) => c.method === "POST" && c.url.includes(urlPart));
  }

  install() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => this.handle(url, init))
    );
  }

  private json(payload: unknown, status = 200) {
    return new Response(JSON.stringify(payload), { status });
  }

  private limitOf(params: URLSearchParams, fallback: number): number {
    const asked = Number(params.get("limit") ?? fallback) || 1;
    return Math.min(asked, this.options.maxPageSize ?? asked);
  }

  private page<T extends Row>(rows: T[], params: URLSearchParams): T[] {
    if (this.options.ignorePaging) return rows;
    const limit = this.limitOf(params, rows.length);
    const offset = params.has("page")
      ? (Number(params.get("page")) - 1) * limit
      : Number(params.get("offset") ?? 0);
    return rows.slice(offset, offset + limit);
  }

  private async handle(rawUrl: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    const url = new URL(rawUrl);
    const path = url.pathname;
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : undefined;
    this.calls.push({ method, url: `${path}${url.search}`, body });
    if (this.options.delayMs) await new Promise((r) => setTimeout(r, this.options.delayMs));

    const failure = this.failures.find(
      (f) => f.remaining > 0 && f.method === method && path.includes(f.urlPart)
    );
    if (failure) {
      failure.remaining -= 1;
      return this.json({}, 500);
    }

    const entries = /\/fiscal-years\/(\d+)\/(incomes|expenses)$/.exec(path);
    if (entries) {
      const rows = entries[2] === "incomes" ? this.incomes : this.expenses;
      if (method === "GET") return this.json(this.page(rows, url.searchParams));
      const row = { id: this.nextId++, ...body } as Row;
      rows.push(row);
      return this.json(row);
    }
    if (path.endsWith("/nextledger/api/fiscal-years")) {
      if (method === "GET") return this.json(this.fiscalYears);
      const year = { id: this.nextId++, ...body };
      this.fiscalYears.push(year);
      return this.json(year);
    }
    const objects = /\/openregister\/api\/objects\/\d+\/\d+(?:\/([^/]+))?$/.exec(path);
    if (objects) {
      const objectId = objects[1];
      if (method === "GET") {
        const filter = url.searchParams.get("stripe_invoice_id");
        const matching =
          filter && !this.options.ignorePaging
            ? this.register.filter((o) => o.stripe_invoice_id === filter)
            : this.register;
        const limit = this.limitOf(url.searchParams, matching.length);
        return this.json({
          results: this.page(matching, url.searchParams),
          pages: Math.max(1, Math.ceil(matching.length / limit)),
        });
      }
      if (method === "PUT" && objectId) {
        const idx = this.register.findIndex((o) => o.id === objectId);
        this.register[idx] = { id: objectId, ...body };
        return this.json(this.register[idx]);
      }
      const row = { id: `obj-${this.nextId++}`, ...body } as Row;
      this.register.push(row);
      return this.json(row);
    }
    return this.json({}, 404);
  }
}
