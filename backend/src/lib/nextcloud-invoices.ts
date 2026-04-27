import { db } from "../db/client";
import { invoices, clients } from "../db/schema";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { stripe } from "./stripe";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

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
  stripeInvoiceId?: string;
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
    _dfwsc_stripe_invoice_id: invoice.stripeInvoiceId,
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
    return { invoiceId: "", synced: false, error: "Client not found" };
  }

  if (!client.stripeCustomerId) {
    return { invoiceId: "", synced: false, error: "Client is missing Stripe customer ID" };
  }

  const invoiceId = `inv_${uuidv4().slice(0, 12)}`;
  const now = new Date();
  const effectiveDueDate = data.dueDate || new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  let stripeInvoiceId: string | undefined;
  let stripeError: string | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await stripe.invoiceItems.create({
        customer: client.stripeCustomerId,
        amount: data.amountCents,
        currency: "usd",
        description: data.notes || data.invoiceNumber,
        metadata: {
          clientId: client.id,
          invoiceId,
          invoiceNumber: data.invoiceNumber,
        },
      });

      const stripeInvoice = await stripe.invoices.create({
        customer: client.stripeCustomerId,
        collection_method: "send_invoice",
        due_date: Math.floor(effectiveDueDate.getTime() / 1000),
        auto_advance: true,
        metadata: {
          clientId: client.id,
          invoiceId,
          invoiceNumber: data.invoiceNumber,
        },
      });

      stripeInvoiceId = stripeInvoice.id;
      break;
    } catch (err) {
      stripeError = String(err);
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
      }
    }
  }

  if (!stripeInvoiceId) {
    return {
      invoiceId: "",
      synced: false,
      error: stripeError || "Failed to create Stripe invoice",
    };
  }

  let syncResult: { success: boolean; externalId?: string; error?: string } = {
    success: false,
    error: "Unknown sync error",
  };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    syncResult = await createNextcloudInvoice({
      id: invoiceId,
      invoiceNumber: data.invoiceNumber,
      amountCents: data.amountCents,
      status: "open",
      clientName: client.name,
      clientEmail: client.email,
      stripeInvoiceId,
    });

    if (syncResult.success) break;

    if (attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
    }
  }

  if (!syncResult.success) {
    try {
      await stripe.invoices.voidInvoice(stripeInvoiceId);
    } catch {
      // best effort rollback
    }
    return {
      invoiceId: "",
      synced: false,
      error: syncResult.error || "Failed to sync invoice to Nextcloud Ledger",
    };
  }

  return {
    invoiceId: syncResult.externalId || invoiceId,
    synced: true,
    externalId: syncResult.externalId,
  };
}

export async function getLedgerInvoicesForClient(clientId: string): Promise<{
  invoices: Array<{
    id: string;
    clientId: string;
    invoiceNumber: string;
    amountCents: number;
    status: string;
    dueDate: string | null;
    createdAt: string | null;
    description: string;
    hostedUrl: string | null;
    nextcloudId: string;
    stripeInvoiceId: string | null;
  }>;
  error?: string;
}> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) {
    return { invoices: [], error: "Client not found" };
  }

  if (!isNextcloudConfigured()) {
    return { invoices: [], error: "Nextcloud not configured" };
  }

  const baseUrl = process.env.NEXTCLOUD_BASE_URL!.replace(/\/$/, "");
  const registerId = process.env.NEXTCLOUD_REGISTER_ID || "1";
  const schemaId = process.env.NEXTCLOUD_LEDGER_SCHEMA_ID || "1";

  try {
    const res = await fetch(`${baseUrl}/index.php/apps/openregister/api/objects/${registerId}/${schemaId}`, {
      method: "GET",
      headers: {
        "OCS-APIREQUEST": "true",
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      return { invoices: [], error: `Nextcloud API error: ${res.status} ${text}` };
    }

    const body = await res.json();
    const rows = Array.isArray(body)
      ? body
      : Array.isArray(body?.results)
        ? body.results
        : Array.isArray(body?.data)
          ? body.data
          : [];

    const filtered = rows.filter((row: any) => row?.client_email === client.email || row?._dfwsc_client_id === client.id);

    const mapped = filtered.map((row: any) => ({
      id: row?._dfwsc_invoice_id || row?.id || `ledger_${uuidv4().slice(0, 12)}`,
      clientId: client.id,
      invoiceNumber: row?.name || row?.invoice_number || "-",
      amountCents: Number(row?.amount_cents ?? 0),
      status: String(row?.status || "open"),
      dueDate: row?.due_date || null,
      createdAt: row?.created || row?.createdAt || null,
      description: row?.description || row?.notes || row?.name || "",
      hostedUrl: row?.hosted_url || row?.hostedUrl || null,
      nextcloudId: String(row?.id || ""),
      stripeInvoiceId: row?._dfwsc_stripe_invoice_id || null,
    }));

    return { invoices: mapped };
  } catch (err) {
    return { invoices: [], error: String(err) };
  }
}
