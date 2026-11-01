import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../../db/client";
import { clients, connectCustomers, connectInvoices } from "../../db/schema";

describe("connect invoicing schema constraints", () => {
  const clientIds: string[] = [];

  afterEach(async () => {
    for (const id of clientIds.splice(0)) {
      await db.delete(clients).where(eq(clients.id, id));
    }
  });

  async function makeClient() {
    const id = randomUUID();
    clientIds.push(id);
    await db.insert(clients).values({
      id,
      name: "Schema Client",
      email: `schema-${id}@example.com`,
      workspace: "client_portal",
    });
    return { id, account: `acct_${id.slice(0, 12)}` };
  }

  async function makeCustomer(
    c: { id: string; account: string },
    over: Partial<typeof connectCustomers.$inferInsert> = {}
  ) {
    const stripeCustomerId = `cus_${randomUUID().slice(0, 12)}`;
    await db.insert(connectCustomers).values({
      id: randomUUID(),
      clientId: c.id,
      connectedAccountId: c.account,
      stripeCustomerId,
      idempotencyKey: randomUUID(),
      ...over,
    });
    return stripeCustomerId;
  }

  function invoiceValues(
    c: { id: string; account: string },
    customer: string,
    over: Partial<typeof connectInvoices.$inferInsert> = {}
  ): typeof connectInvoices.$inferInsert {
    return {
      id: randomUUID(),
      clientId: c.id,
      connectedAccountId: c.account,
      stripeCustomerId: customer,
      idempotencyKey: randomUUID(),
      requestHash: "h",
      currency: "usd",
      subtotalCents: 1000,
      feeAmountCents: 59,
      totalCents: 1059,
      amountRemainingCents: 1059,
      ...over,
    };
  }

  async function rejects(p: Promise<unknown>, constraint: string) {
    let err: any;
    try {
      await p;
    } catch (e) {
      err = e;
    }
    expect(err, `expected ${constraint} violation`).toBeDefined();
    const cause = err.cause ?? err;
    expect(cause.constraint).toBe(constraint);
  }

  it("rejects a duplicate (client_id, idempotency_key) on connect_customers", async () => {
    const c = await makeClient();
    await makeCustomer(c, { idempotencyKey: "k1" });
    await rejects(
      makeCustomer(c, { idempotencyKey: "k1" }),
      "connect_customers_client_idempotency_key_uniq"
    );
  });

  it("rejects a duplicate (client_id, idempotency_key) on connect_invoices", async () => {
    const c = await makeClient();
    const cus = await makeCustomer(c);
    await db.insert(connectInvoices).values(invoiceValues(c, cus, { idempotencyKey: "k1" }));
    await rejects(
      db.insert(connectInvoices).values(invoiceValues(c, cus, { idempotencyKey: "k1" })),
      "connect_invoices_client_idempotency_key_uniq"
    );
  });

  it("rejects a duplicate non-null stripe_invoice_id but allows many NULLs", async () => {
    const c = await makeClient();
    const cus = await makeCustomer(c);
    await db.insert(connectInvoices).values(invoiceValues(c, cus));
    await db.insert(connectInvoices).values(invoiceValues(c, cus));
    await db.insert(connectInvoices).values(invoiceValues(c, cus, { stripeInvoiceId: "in_1" }));
    await rejects(
      db.insert(connectInvoices).values(invoiceValues(c, cus, { stripeInvoiceId: "in_1" })),
      "connect_invoices_stripe_invoice_id_uniq"
    );
  });

  it("rejects a duplicate (client_id, external_ref) but allows many NULLs", async () => {
    const c = await makeClient();
    await makeCustomer(c);
    await makeCustomer(c);
    await makeCustomer(c, { externalRef: "ref-1" });
    await rejects(
      makeCustomer(c, { externalRef: "ref-1" }),
      "connect_customers_client_external_ref_uniq"
    );
    const other = await makeClient();
    await makeCustomer(other, { externalRef: "ref-1" });
  });

  it.each([
    ["subtotalCents", "connect_invoices_subtotal_cents_check"],
    ["feeAmountCents", "connect_invoices_fee_amount_cents_check"],
    ["totalCents", "connect_invoices_total_cents_check"],
    ["amountPaidCents", "connect_invoices_amount_paid_cents_check"],
    ["amountRemainingCents", "connect_invoices_amount_remaining_cents_check"],
    ["sendCount", "connect_invoices_send_count_check"],
  ] as const)("rejects a negative %s", async (field, constraint) => {
    const c = await makeClient();
    const cus = await makeCustomer(c);
    await rejects(
      db.insert(connectInvoices).values(invoiceValues(c, cus, { [field]: -1 })),
      constraint
    );
  });

  it.each(["USD", "us", "usdd", "12a"])("rejects currency %j", async (currency) => {
    const c = await makeClient();
    const cus = await makeCustomer(c);
    await rejects(
      db.insert(connectInvoices).values(invoiceValues(c, cus, { currency })),
      "connect_invoices_currency_check"
    );
  });

  it("rejects an invoice whose customer is not in connect_customers for that account", async () => {
    const c = await makeClient();
    const cus = await makeCustomer(c);
    await rejects(
      db.insert(connectInvoices).values(invoiceValues(c, "cus_unknown")),
      "connect_invoices_customer_fk"
    );
    await rejects(
      db.insert(connectInvoices).values(invoiceValues({ ...c, account: "acct_other" }, cus)),
      "connect_invoices_customer_fk"
    );
  });

  it("stores event timestamps beyond 2038 and cascades on client delete", async () => {
    const c = await makeClient();
    const cus = await makeCustomer(c);
    const row = invoiceValues(c, cus, { lastStripeEventCreatedAt: 4_000_000_000 });
    await db.insert(connectInvoices).values(row);
    const [got] = await db.select().from(connectInvoices).where(eq(connectInvoices.id, row.id));
    expect(got.lastStripeEventCreatedAt).toBe(4_000_000_000);
    await db.delete(clients).where(eq(clients.id, c.id));
    expect(await db.select().from(connectInvoices).where(eq(connectInvoices.id, row.id))).toEqual(
      []
    );
    expect(
      await db.select().from(connectCustomers).where(eq(connectCustomers.clientId, c.id))
    ).toEqual([]);
  });
});
