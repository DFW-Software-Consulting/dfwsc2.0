const LEDGER_PATH = "/remote.php/webdav/clients/dfwsc-ledger.csv";

const CSV_HEADERS = "Date,Client,Invoice ID,Description,Amount (USD),Fee (USD),Total (USD),Status,Due Date,Paid At";

export interface LedgerRow {
  date: string;
  client: string;
  invoiceId: string;
  description: string;
  amountCents: number;
  feeCents: number;
  totalCents: number;
  status: string;
  dueDate: string | null;
  paidAt: string | null;
}

function getConfig() {
  const url = process.env.NEXTCLOUD_URL;
  const user = process.env.NEXTCLOUD_USER;
  const pass = process.env.NEXTCLOUD_APP_PASSWORD;
  if (!url || !user || !pass) return null;
  return { url, user, pass };
}

function authHeader(user: string, pass: string) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

function centsToUsd(cents: number): string {
  return (cents / 100).toFixed(2);
}

function escapeCell(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function rowToCsv(row: LedgerRow): string {
  return [
    escapeCell(row.date),
    escapeCell(row.client),
    escapeCell(row.invoiceId),
    escapeCell(row.description),
    centsToUsd(row.amountCents),
    centsToUsd(row.feeCents),
    centsToUsd(row.totalCents),
    escapeCell(row.status),
    row.dueDate ? escapeCell(row.dueDate.split("T")[0]) : "",
    row.paidAt ? escapeCell(row.paidAt.split("T")[0]) : "",
  ].join(",");
}

async function readLedger(url: string, user: string, pass: string): Promise<string> {
  const res = await fetch(`${url}${LEDGER_PATH}`, {
    headers: { Authorization: authHeader(user, pass) },
  });
  if (res.status === 404) return `${CSV_HEADERS}\n`;
  if (!res.ok) throw new Error(`Nextcloud read failed: ${res.status}`);
  return res.text();
}

async function writeLedger(url: string, user: string, pass: string, content: string): Promise<void> {
  const res = await fetch(`${url}${LEDGER_PATH}`, {
    method: "PUT",
    headers: {
      Authorization: authHeader(user, pass),
      "Content-Type": "text/csv",
    },
    body: content,
  });
  if (!res.ok) throw new Error(`Nextcloud write failed: ${res.status}`);
}

export async function appendLedgerRow(row: LedgerRow): Promise<void> {
  const cfg = getConfig();
  if (!cfg) return;

  try {
    const current = await readLedger(cfg.url, cfg.user, cfg.pass);
    const updated = current.trimEnd() + "\n" + rowToCsv(row) + "\n";
    await writeLedger(cfg.url, cfg.user, cfg.pass, updated);
  } catch (err) {
    console.error("[nextcloud-ledger] appendLedgerRow failed:", err);
  }
}

export async function updateLedgerRow(invoiceId: string, status: string, paidAt?: string | null): Promise<void> {
  const cfg = getConfig();
  if (!cfg) return;

  try {
    const current = await readLedger(cfg.url, cfg.user, cfg.pass);
    const lines = current.split("\n");

    let updated = false;
    const newLines = lines.map((line) => {
      if (!line.trim() || line.startsWith("Date,")) return line;
      const cols = line.split(",");
      // Invoice ID is column index 2
      if (cols[2]?.replace(/"/g, "") === invoiceId) {
        cols[7] = escapeCell(status);
        if (paidAt) cols[9] = escapeCell(paidAt.split("T")[0]);
        updated = true;
        return cols.join(",");
      }
      return line;
    });

    if (updated) {
      await writeLedger(cfg.url, cfg.user, cfg.pass, newLines.join("\n"));
    }
  } catch (err) {
    console.error("[nextcloud-ledger] updateLedgerRow failed:", err);
  }
}

export async function backfillLedger(rows: LedgerRow[]): Promise<number> {
  const cfg = getConfig();
  if (!cfg) throw new Error("Nextcloud not configured.");

  const lines = [CSV_HEADERS, ...rows.map(rowToCsv), ""].join("\n");
  await writeLedger(cfg.url, cfg.user, cfg.pass, lines);
  return rows.length;
}
