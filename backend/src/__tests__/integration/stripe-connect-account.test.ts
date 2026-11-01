import { vi } from "vitest";

vi.mock("../../lib/stripe", () => ({
  stripe: {
    accounts: { create: vi.fn(), retrieve: vi.fn(), del: vi.fn() },
    accountLinks: { create: vi.fn() },
  },
}));

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db/client";
import { clients } from "../../db/schema";
import { stripe } from "../../lib/stripe";
import {
  createExpressAccountForClient,
  deleteUnpersistedExpressAccount,
  ensureExpressAccountForClient,
} from "../../lib/stripe-connect-account";
import { dump, expectNoPlanted, plantedStripeError } from "../helpers/log-capture";

const logger = { info: vi.fn(), error: vi.fn() };
const createdClientIds: string[] = [];

async function seedLegacyClient(stripeAccountId: string | null = null) {
  const id = randomUUID();
  const [row] = await db
    .insert(clients)
    .values({ id, name: "Legacy Client", email: `legacy-${id}@example.com`, stripeAccountId })
    .returning();
  createdClientIds.push(id);
  return row;
}

describe("stripe-connect-account", () => {
  afterAll(async () => {
    for (const id of createdClientIds) {
      await db
        .delete(clients)
        .where(eq(clients.id, id))
        .catch(() => undefined);
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (stripe.accounts.del as any).mockResolvedValue({ deleted: true });
  });

  it("creates the Express account with client metadata and a client-scoped idempotency key", async () => {
    const clientId = randomUUID();
    (stripe.accounts.create as any).mockResolvedValueOnce({
      id: "acct_fresh",
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
    });

    const state = await createExpressAccountForClient({ id: clientId, email: "a@example.com" });

    expect(state).toEqual({
      stripeAccountId: "acct_fresh",
      chargesEnabled: true,
      payoutsEnabled: false,
      detailsSubmitted: true,
    });
    expect(stripe.accounts.create).toHaveBeenCalledWith(
      {
        type: "express",
        email: "a@example.com",
        metadata: { clientId },
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      },
      { idempotencyKey: `acct-create-${clientId}` }
    );
  });

  it("returns an already persisted account without calling Stripe", async () => {
    const client = await seedLegacyClient(`acct_known_${randomUUID().slice(0, 8)}`);

    await expect(ensureExpressAccountForClient(client, logger)).resolves.toBe(
      client.stripeAccountId
    );
    expect(stripe.accounts.create).not.toHaveBeenCalled();
  });

  it("lazily creates and persists an account (with readiness flags) for a legacy client", async () => {
    const client = await seedLegacyClient();
    const accountId = `acct_lazy_${client.id.replace(/-/g, "").slice(0, 12)}`;
    (stripe.accounts.create as any).mockResolvedValueOnce({
      id: accountId,
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: true,
    });

    await expect(ensureExpressAccountForClient(client, logger)).resolves.toBe(accountId);

    const [row] = await db.select().from(clients).where(eq(clients.id, client.id));
    expect(row).toMatchObject({ stripeAccountId: accountId, detailsSubmitted: true });
    expect(stripe.accounts.del).not.toHaveBeenCalled();
  });

  it("concurrent lazy calls converge on one persisted account and delete nothing", async () => {
    const client = await seedLegacyClient();
    const accountId = `acct_race_${client.id.replace(/-/g, "").slice(0, 12)}`;
    // Shared idempotency key: Stripe returns the same account to both requests.
    (stripe.accounts.create as any).mockResolvedValue({ id: accountId });

    const results = await Promise.all([
      ensureExpressAccountForClient(client, logger),
      ensureExpressAccountForClient(client, logger),
    ]);

    expect(results).toEqual([accountId, accountId]);
    const keys = (stripe.accounts.create as any).mock.calls.map((c: any[]) => c[1].idempotencyKey);
    expect(new Set(keys)).toEqual(new Set([`acct-create-${client.id}`]));
    expect(stripe.accounts.del).not.toHaveBeenCalled();
    const [row] = await db.select().from(clients).where(eq(clients.id, client.id));
    expect(row.stripeAccountId).toBe(accountId);
  });

  it("returns the winning account and deletes the losing one when IDs differ", async () => {
    const client = await seedLegacyClient();
    const winner = `acct_win_${client.id.replace(/-/g, "").slice(0, 12)}`;
    await db.update(clients).set({ stripeAccountId: winner }).where(eq(clients.id, client.id));
    (stripe.accounts.create as any).mockResolvedValueOnce({ id: "acct_loser" });

    // `client` is the stale pre-claim snapshot (stripeAccountId still null).
    await expect(ensureExpressAccountForClient(client, logger)).resolves.toBe(winner);
    expect(stripe.accounts.del).toHaveBeenCalledWith("acct_loser");
  });

  it("logs only identifiers when deleting an unpersisted account fails", async () => {
    (stripe.accounts.del as any).mockRejectedValueOnce(plantedStripeError());
    logger.error.mockClear();

    await deleteUnpersistedExpressAccount("acct_orphan", "client-1", logger as never);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "client-1",
        stripeAccountId: "acct_orphan",
        errType: "StripeInvalidRequestError",
        errRequestId: "req_planted",
      }),
      expect.any(String)
    );
    expectNoPlanted(dump(logger.error.mock.calls));
  });

  it("throws, without deleting, when the account ID cannot be persisted", async () => {
    const owner = await seedLegacyClient(`acct_taken_${randomUUID().slice(0, 8)}`);
    const client = await seedLegacyClient();
    (stripe.accounts.create as any).mockResolvedValueOnce({ id: owner.stripeAccountId });

    await expect(ensureExpressAccountForClient(client, logger)).rejects.toThrow();
    expect(stripe.accounts.del).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: client.id,
        stripeAccountId: owner.stripeAccountId,
        errCode: "23505",
      }),
      expect.any(String)
    );
    // The raw pg error quotes the colliding row ("Key (stripe_account_id)=(...)").
    expect(dump(logger.error.mock.calls)).not.toMatch(/Key \(|duplicate key|Failed query/);
  });
});
