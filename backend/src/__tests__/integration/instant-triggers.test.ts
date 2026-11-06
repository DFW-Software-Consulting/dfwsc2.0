import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../app";
import { db } from "../../db/client";
import { billingCustomers, billingSnapshots, clients, onboardingTokens } from "../../db/schema";
import { ensureBillingCustomer, linkPinnedBillingCustomer } from "../../lib/billing-customer";
import { markCustomerDirty } from "../../lib/billing-snapshot";
import { createClientWithOnboardingToken } from "../../lib/client-factory";
import { type KickableJob, registerKickable } from "../../lib/coalesced-runner";
import { hitBuckets } from "../../lib/rate-limit";
import { stripe } from "../../lib/stripe";
import { refreshCardPaymentsStatus, syncClientFromAccount } from "../../lib/stripe-connect-account";
import { makeAdminToken } from "../helpers/auth";
import { ensureBaseEnv } from "../helpers/env";

// Each wired write site kicks its job through kickJob(); a spy runner stands in for the job,
// so these tests check the wiring, not the cycles (those have their own tests).
const jobs: KickableJob[] = ["salesLead", "billingMirror", "portalMirror", "stripeIdWriteback"];
const kicks = Object.fromEntries(jobs.map((j) => [j, vi.fn<() => void>()])) as Record<
  KickableJob,
  ReturnType<typeof vi.fn<() => void>>
>;
let unregister: (() => void)[] = [];
let app: any;
const clientIds: string[] = [];
const codes: string[] = [];

async function addClient(): Promise<string> {
  const [row] = await db
    .insert(clients)
    .values({
      id: randomUUID(),
      name: "Wire Test",
      email: `wire-${randomUUID()}@example.com`,
      workspace: "client_portal",
      status: "active",
      stripeAccountId: `acct_${randomUUID().slice(0, 8)}`,
    } as typeof clients.$inferInsert)
    .returning({ id: clients.id });
  clientIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  ensureBaseEnv();
  app = await buildServer();
});
afterAll(async () => {
  for (const id of clientIds) {
    await db.delete(onboardingTokens).where(eq(onboardingTokens.clientId, id));
    await db.delete(clients).where(eq(clients.id, id));
  }
  for (const code of codes) {
    await db.delete(billingCustomers).where(eq(billingCustomers.clientCode, code));
  }
  if (app) await app.close();
});
beforeEach(() => {
  hitBuckets.clear();
  for (const job of jobs) {
    kicks[job].mockClear();
    unregister.push(
      registerKickable(job, { trigger: vi.fn(), kick: kicks[job], stop: async () => {} })
    );
  }
});
afterEach(() => {
  for (const off of unregister) off();
  unregister = [];
  vi.restoreAllMocks();
});

const admin = () => ({ authorization: `Bearer ${makeAdminToken()}` });

describe("portal mirror kicks", () => {
  it("client creation", async () => {
    const created = await createClientWithOnboardingToken({
      name: "Factory",
      email: `factory-${randomUUID()}@example.com`,
      workspace: "client_portal",
    });
    clientIds.push(created.clientId);
    expect(kicks.portalMirror).toHaveBeenCalledTimes(1);
  });

  it("admin PATCH and DELETE /clients/:id", async () => {
    const id = await addClient();
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/clients/${id}`,
      headers: admin(),
      payload: { name: "Patched" },
    });
    expect(patch.statusCode).toBe(200);
    expect(kicks.portalMirror).toHaveBeenCalledTimes(1);
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/clients/${id}`,
      headers: admin(),
    });
    expect(del.statusCode).toBe(204);
    expect(kicks.portalMirror).toHaveBeenCalledTimes(2);
  });

  it("readiness sync from a live account object and a live status refresh", async () => {
    const id = await addClient();
    await syncClientFromAccount(id, {
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      capabilities: { card_payments: "active" },
    });
    expect(kicks.portalMirror).toHaveBeenCalledTimes(1);

    vi.spyOn(stripe.accounts, "retrieve").mockResolvedValue({
      capabilities: { card_payments: "active" },
    } as never);
    await refreshCardPaymentsStatus({ id }, "acct_x");
    expect(kicks.portalMirror).toHaveBeenCalledTimes(2);
  });

  it("does not kick when the write fails", async () => {
    await expect(
      createClientWithOnboardingToken({
        name: "Bad",
        email: "x@example.com",
        workspace: "nope" as never,
      })
    ).rejects.toThrow();
    expect(kicks.portalMirror).not.toHaveBeenCalled();
  });
});

describe("billing mirror and write-back kicks", () => {
  const code = () => {
    const c = `WIRE-${randomUUID().slice(0, 8)}`;
    codes.push(c);
    return c;
  };

  it("markCustomerDirty kicks the billing mirror only for a known Customer", async () => {
    const clientCode = code();
    const customerId = `cus_${randomUUID().slice(0, 10)}`;
    await db.insert(billingCustomers).values({
      clientCode,
      company: "Acme",
      email: "a@example.com",
      stripeCustomerId: customerId,
      source: "created",
    });
    expect(await markCustomerDirty("cus_unknown")).toBe(false);
    expect(kicks.billingMirror).not.toHaveBeenCalled();
    expect(await markCustomerDirty(customerId)).toBe(true);
    expect(kicks.billingMirror).toHaveBeenCalledTimes(1);
    await db.delete(billingSnapshots).where(eq(billingSnapshots.stripeCustomerId, customerId));
  });

  it("a new billing_customers link kicks the write-back and the billing mirror, once", async () => {
    vi.spyOn(stripe.customers, "list").mockResolvedValue({ data: [{ id: "cus_wire1" }] } as never);
    const input = { clientCode: code(), company: "Acme", email: `w-${randomUUID()}@example.com` };
    expect(await ensureBillingCustomer(input)).toMatchObject({ status: "linked" });
    expect(kicks.stripeIdWriteback).toHaveBeenCalledTimes(1);
    expect(kicks.billingMirror).toHaveBeenCalledTimes(1);

    // Already linked: nothing new to show, nothing kicked.
    expect(await ensureBillingCustomer(input)).toMatchObject({ status: "linked" });
    expect(kicks.stripeIdWriteback).toHaveBeenCalledTimes(1);
    expect(kicks.billingMirror).toHaveBeenCalledTimes(1);
  });

  it("a pinned link kicks them too", async () => {
    vi.spyOn(stripe.customers, "retrieve").mockResolvedValue({
      id: "cus_wire2",
      deleted: false,
    } as never);
    await linkPinnedBillingCustomer(
      { clientCode: code(), company: "Acme", email: `p-${randomUUID()}@example.com` },
      "cus_wire2"
    );
    expect(kicks.stripeIdWriteback).toHaveBeenCalledTimes(1);
    expect(kicks.billingMirror).toHaveBeenCalledTimes(1);
  });
});
