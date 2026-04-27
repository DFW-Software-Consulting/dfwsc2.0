import { db } from "../db/client";
import { clients } from "../db/schema";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { stripe } from "./stripe";

function isNextcloudConfigured(): boolean {
  return !!(process.env.NEXTCLOUD_BASE_URL && process.env.NEXTCLOUD_USERNAME && process.env.NEXTCLOUD_APP_PASSWORD);
}

function getNextcloudAuth(): string {
  const user = process.env.NEXTCLOUD_USERNAME!;
  const pass = process.env.NEXTCLOUD_APP_PASSWORD!;
  return Buffer.from(`${user}:${pass}`).toString("base64");
}

async function createNextcloudContact(client: {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  notes?: string | null;
}): Promise<{ success: boolean; externalId?: string; error?: string }> {
  if (!isNextcloudConfigured()) {
    return { success: false, error: "Nextcloud not configured" };
  }

  const baseUrl = process.env.NEXTCLOUD_BASE_URL!.replace(/\/$/, "");
  const registerId = process.env.NEXTCLOUD_REGISTER_ID || "1";
  const schemaId = process.env.NEXTCLOUD_CONTACT_SCHEMA_ID || "1";

  const payload = {
    name: client.name,
    email: client.email,
    phone: client.phone ?? undefined,
    notes: client.notes ?? undefined,
    _dfwsc_client_id: client.id,
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

async function updateNextcloudContact(client: {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  notes?: string | null;
  externalId?: string | null;
}): Promise<{ success: boolean; error?: string }> {
  if (!isNextcloudConfigured()) {
    return { success: false, error: "Nextcloud not configured" };
  }

  if (!client.externalId) {
    return createNextcloudContact(client);
  }

  const baseUrl = process.env.NEXTCLOUD_BASE_URL!.replace(/\/$/, "");
  const registerId = process.env.NEXTCLOUD_REGISTER_ID || "1";
  const schemaId = process.env.NEXTCLOUD_CONTACT_SCHEMA_ID || "1";

  const payload = {
    name: client.name,
    email: client.email,
    phone: client.phone ?? undefined,
    notes: client.notes ?? undefined,
  };

  try {
    const res = await fetch(
      `${baseUrl}/index.php/apps/openregister/api/objects/${registerId}/${schemaId}/${client.externalId}`,
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
        return createNextcloudContact(client);
      }
      const text = await res.text();
      return { success: false, error: `Nextcloud API error: ${res.status} ${text}` };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function syncClientToNextcloud(clientId: string): Promise<{ synced: boolean; externalId?: string; error?: string }> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);

  if (!client) {
    return { synced: false, error: "Client not found" };
  }

  if (client.workspace !== "dfwsc") {
    return { synced: false, error: "Not a dfwsc workspace client" };
  }

  if (!client.email) {
    return { synced: false, error: "Client has no email" };
  }

  const result = await createNextcloudContact({
    id: client.id,
    name: client.name,
    email: client.email,
    phone: client.phone,
    notes: client.notes,
  });

  if (!result.success) {
    return { synced: false, error: result.error };
  }

  return { synced: true, externalId: result.externalId };
}

export async function createDfwscClient(data: {
  name: string;
  email: string;
  phone?: string;
  notes?: string;
}): Promise<{ clientId: string; stripeCustomerId?: string; synced: boolean; externalId?: string; error?: string }> {
  const clientId = `client_${uuidv4().slice(0, 12)}`;
  const now = new Date();

  let stripeCustomerId: string | null = null;
  try {
    const stripeCustomer = await stripe.customers.create({
      name: data.name,
      email: data.email.toLowerCase().trim(),
      phone: data.phone?.trim() || undefined,
      metadata: { clientId },
    });
    stripeCustomerId = stripeCustomer.id;
  } catch (err) {
    console.error("Failed to create Stripe customer:", err);
  }

  await db.insert(clients).values({
    id: clientId,
    workspace: "dfwsc",
    name: data.name,
    email: data.email.toLowerCase().trim(),
    phone: data.phone?.trim() || null,
    notes: data.notes || null,
    stripeCustomerId,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  const syncResult = await createNextcloudContact({
    id: clientId,
    name: data.name,
    email: data.email,
    phone: data.phone,
    notes: data.notes,
  });

  return {
    clientId,
    stripeCustomerId: stripeCustomerId || undefined,
    synced: syncResult.success,
    externalId: syncResult.externalId,
    error: syncResult.error,
  };
}