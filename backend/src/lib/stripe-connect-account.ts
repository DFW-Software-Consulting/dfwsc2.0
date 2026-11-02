import { and, eq, isNull } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/client";
import { clients } from "../db/schema";
import { withStripeCircuit } from "./circuit-breakers";
import { errorLogFields } from "./safe-error-log";
import { stripe } from "./stripe-billing";

type ClientRecord = typeof clients.$inferSelect;
type Logger = Pick<FastifyBaseLogger, "info" | "error">;

export interface ExpressAccountState {
  stripeAccountId: string;
  chargesEnabled: boolean;
  cardPaymentsStatus: string | null;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

/**
 * Creates the Stripe Connect Express account for a client. The idempotency key is derived from
 * the client ID, so retries for the same client (within Stripe's idempotency window) return the
 * same account instead of creating another one.
 */
export async function createExpressAccountForClient(
  client: Pick<ClientRecord, "id" | "email">
): Promise<ExpressAccountState> {
  const account = await withStripeCircuit(() =>
    stripe.accounts.create(
      {
        type: "express",
        email: client.email,
        metadata: { clientId: client.id },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      },
      { idempotencyKey: `acct-create-${client.id}` }
    )
  );

  return {
    stripeAccountId: account.id,
    chargesEnabled: account.charges_enabled ?? false,
    cardPaymentsStatus: account.capabilities?.card_payments ?? "unrequested",
    payoutsEnabled: account.payouts_enabled ?? false,
    detailsSubmitted: account.details_submitted ?? false,
  };
}

/**
 * Best-effort delete of a Stripe account that was created but never persisted. Only call this
 * when the account cannot be referenced by any client row. Failure is logged (with both IDs, for
 * manual reconciliation) and swallowed so the caller can surface its original error.
 */
export async function deleteUnpersistedExpressAccount(
  stripeAccountId: string,
  clientId: string,
  logger: Logger
): Promise<void> {
  try {
    await stripe.accounts.del(stripeAccountId);
    logger.info({ clientId, stripeAccountId }, "Deleted unpersisted Stripe account");
  } catch (err) {
    logger.error(
      { ...errorLogFields(err), clientId, stripeAccountId },
      "Failed to delete unpersisted Stripe account; manual reconciliation required"
    );
  }
}

/**
 * Returns the client's persisted Stripe account ID, creating the Express account first for
 * legacy clients that predate eager provisioning. Throws unless the returned ID is confirmed to
 * be stored on the client row, so callers never build account links for an unpersisted account.
 */
export async function ensureExpressAccountForClient(
  client: ClientRecord,
  logger: Logger
): Promise<string> {
  if (client.stripeAccountId) return client.stripeAccountId;

  const created = await createExpressAccountForClient(client);

  // Conditional claim: only persist if no concurrent request already did. Concurrent requests
  // share the idempotency key, so they normally receive the same account ID. On a DB error we
  // do not delete the account: another request may already have persisted that same ID, and a
  // retry will receive it again through the idempotency key.
  let claimed: { stripeAccountId: string | null } | undefined;
  let refreshed: { stripeAccountId: string | null } | undefined;
  try {
    [claimed] = await db
      .update(clients)
      .set({
        stripeAccountId: created.stripeAccountId,
        chargesEnabled: created.chargesEnabled,
        cardPaymentsStatus: created.cardPaymentsStatus,
        payoutsEnabled: created.payoutsEnabled,
        detailsSubmitted: created.detailsSubmitted,
      })
      .where(and(eq(clients.id, client.id), isNull(clients.stripeAccountId)))
      .returning({ stripeAccountId: clients.stripeAccountId });

    if (!claimed) {
      [refreshed] = await db
        .select({ stripeAccountId: clients.stripeAccountId })
        .from(clients)
        .where(eq(clients.id, client.id))
        .limit(1);
    }
  } catch (err) {
    logger.error(
      { ...errorLogFields(err), clientId: client.id, stripeAccountId: created.stripeAccountId },
      "Failed to persist lazily created Stripe account"
    );
    throw err;
  }

  if (claimed?.stripeAccountId) return claimed.stripeAccountId;

  if (refreshed?.stripeAccountId) {
    if (refreshed.stripeAccountId !== created.stripeAccountId) {
      // A different account won the claim; ours is referenced by no client row.
      await deleteUnpersistedExpressAccount(created.stripeAccountId, client.id, logger);
    }
    return refreshed.stripeAccountId;
  }

  // The client row disappeared between the read and the claim, so nothing references the account.
  await deleteUnpersistedExpressAccount(created.stripeAccountId, client.id, logger);
  throw new Error(`Stripe account was not persisted for client ${client.id}`);
}

/**
 * Stripe can report `charges_enabled` while `capabilities.card_payments` is not active (for
 * example on transfers-only accounts), and invoicing on such an account fails at Stripe. Returns
 * the stored status, or reads it live once when it is NULL (never synced) and stores it. The
 * write only fills a NULL, so a newer value written meanwhile (for example by the account.updated
 * webhook) wins and is the one returned. Throws when the live read fails, so callers fail closed.
 */
export async function resolveCardPaymentsStatus(
  client: Pick<ClientRecord, "id" | "cardPaymentsStatus">,
  stripeAccountId: string
): Promise<string> {
  if (client.cardPaymentsStatus !== null) return client.cardPaymentsStatus;
  const account = await withStripeCircuit(() => stripe.accounts.retrieve(stripeAccountId));
  const live = account.capabilities?.card_payments ?? "unrequested";
  const written = await db
    .update(clients)
    .set({ cardPaymentsStatus: live, updatedAt: new Date() })
    .where(and(eq(clients.id, client.id), isNull(clients.cardPaymentsStatus)))
    .returning({ id: clients.id });
  if (written.length > 0) return live;
  const [current] = await db
    .select({ status: clients.cardPaymentsStatus })
    .from(clients)
    .where(eq(clients.id, client.id))
    .limit(1);
  return current?.status ?? live;
}
