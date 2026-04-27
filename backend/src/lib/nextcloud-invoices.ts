import { db } from "../db/client";
import { invoices, clients } from "../db/schema";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

function isNextcloudConfigured(): boolean {
  return !!(process.env.NEXTCLOUD_BASE_URL && process.env.NEXTCLOUD_USERNAME && process.env.NEXTCLOUD_APP_PASSWORD);
}

async function createNextcloudInvoice(invoice: {
  id: string;
  invoiceNumber: string;
  amountCents: number;
  status: string;
  clientName: string;
  clientEmail: string;
}): Promise<{ success: boolean; externalId?: string; error?: string }> {
  if (!isNextcloudConfigured()) {
    return { success: false, error: "Nextcloud not configured" };
  }

  const baseUrl = process.env.NEXTCLOUD_BASE_URL!.replace(/\/$/, "");
  const registerId = process.env.NEXTCLOUD_REGISTER_ID || "1";
  const schemaId = process.env.NEXTCLOUD_LEDGER_SCHEMA_ID || "1";

  if (!schemaId) {
    return { success: false, error: "NEXTCLOUD_LEDGER_SCHEMA_ID not set" };
  }

  const payload = {
    name: invoice.invoiceNumber,
    amount_cents: invoice.amountCents,
    status: invoice.status,
    client_name: invoice.clientName,
    client_email: invoice.clientEmail,
    _dfwsc_invoice_id: invoice.id,
  };

  try {
    const res = await fetch(
      `${baseUrl}/index.php/apps/openregister/api/objects/${registerId}/${schemaId}`,
      {
        method: "POST",
        headers: {
          "OCS-APIREQUEST": "true",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `Nextcloud API error: ${res.status} ${text}` };
    }

    const data = await res.json();
    const externalId = data?.id || uuidv4();
    return { success: true, externalId };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

async function updateNextcloudInvoice(invoice: {
  id: string;
  invoiceNumber: string;
  amountCents: number;
  status: string;
  clientName: string;
  clientEmail: string;
  externalId?: string | null;
}): Promise<{ success: boolean; error?: string }> {
  if (!isNextcloudConfigured()) {
    return { success: false, error: "Nextcloud not configured" };
  }

  if (!invoice.externalId) {
    return createNextcloudInvoice(invoice);
  }

  const baseUrl = process.env.NEXTCLOUD_BASE_URL!.replace(/\/$/, "");
  const registerId = process.env.NEXTCLOUD_REGISTER_ID || "1";
  const schemaId = process.env.NEXTCLOUD_LEDGER_SCHEMA_ID || "1";

  if (!schemaId) {
    return { success: false, error: "NEXTCLOUD_LEDGER_SCHEMA_ID not set" };
  }

  const payload = {
    name: invoice.invoiceNumber,
    amount_cents: invoice.amountCents,
    status: invoice.status,
  };

  try {
    const res = await fetch(
      `${baseUrl}/index.php/apps/openregister/api/objects/${registerId}/${schemaId}/${invoice.externalId}`,
      {
        method: "PUT",
        headers: {
          "OCS-APIREQUEST": "true",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    if (!res.ok) {
      if (res.status === 404) {
        return createNextcloudInvoice(invoice);
      }
      const text = await res.text();
      return { success: false, error: `Nextcloud API error: ${res.status} ${text}` };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function syncInvoiceToNextcloud(invoiceId: string): Promise<{ synced: boolean; externalId?: string; error?: string }> {
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);

  if (!invoice) {
    return { synced: false, error: "Invoice not found" };
  }

  const [client] = await db
    .select()
    .from(clients)
    .where(eq(clients.id, invoice.clientId))
    .limit(1);

  if (!client) {
    return { synced: false, error: "Client not found" };
  }

  const result = await createNextcloudInvoice({
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    amountCents: Number(invoice.amountCents),
    status: invoice.status,
    clientName: client.name,
    clientEmail: client.email,
  });

  if (!result.success) {
    return { synced: false, error: result.error };
  }

  if (result.externalId) {
    await db
      .update(invoices)
      .set({ nextcloudId: result.externalId, updatedAt: new Date() })
      .where(eq(invoices.id, invoiceId));
  }

  return { synced: true, externalId: result.externalId };
}

export async function createInvoiceForClient(clientId: string, data: {
  amountCents: number;
  invoiceNumber: string;
  dueDate?: Date;
  notes?: string;
}): Promise<{ invoiceId: string; synced: boolean; externalId?: string; error?: string }> {
  const [client] = await db
    .select()
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);

  if (!client) {
    return { invoiceId: "", error: "Client not found" };
  }

  const invoiceId = `inv_${uuidv4().slice(0, 12)}`;
  const now = new Date();

  await db.insert(invoices).values({
    id: invoiceId,
    clientId: client.id,
    invoiceNumber: data.invoiceNumber,
    amountCents: data.amountCents,
    status: "open",
    dueDate: data.dueDate || new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    notes: data.notes || null,
    createdAt: now,
    updatedAt: now,
  });

  const syncResult = await createNextcloudInvoice({
    id: invoiceId,
    invoiceNumber: data.invoiceNumber,
    amountCents: data.amountCents,
    status: "open",
    clientName: client.name,
    clientEmail: client.email,
  });

  if (syncResult.success && syncResult.externalId) {
    await db
      .update(invoices)
      .set({ nextcloudId: syncResult.externalId })
      .where(eq(invoices.id, invoiceId));
  }

  return {
    invoiceId,
    synced: syncResult.success,
    externalId: syncResult.externalId,
    error: syncResult.error,
  };
}