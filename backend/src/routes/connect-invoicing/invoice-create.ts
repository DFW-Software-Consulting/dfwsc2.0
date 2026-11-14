import { and, count, eq, gte, isNull, lt, min, ne, or } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Stripe from "stripe";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db/client";
import { clientGroups, connectCustomers, connectInvoices } from "../../db/schema";
import {
  assertTotalWithinCap,
  computeBaseCents,
  createInvoiceBodySchema,
  hashInvoiceRequest,
  type InvoiceRequest,
  type InvoiceRow,
  PROCESSING_FEE_DESCRIPTION,
  serializeInvoice,
} from "../../lib/connect-invoice";
import {
  INVOICE_ADOPTION_MAX_PAGES,
  INVOICE_CLAIM_LEASE_MS,
  INVOICE_DAILY_CREATE_LIMIT,
  INVOICE_STRIPE_KEY_WINDOW_MS,
} from "../../lib/constants";
import { errors } from "../../lib/errors";
import { stripe } from "../../lib/stripe";
import { resolveClientFee } from "../../lib/stripe-billing";
import { validateStripeMetadata } from "../../lib/stripe-input";
import { DEFAULT_DAYS_UNTIL_DUE, parseBody } from "../../lib/validation";
import {
  accountOf,
  assertNoReservedMetadataKeys,
  type ClientRow,
  type InvoicingDeps,
  invoiceKeyInUse,
  parseIdempotencyKeyHash,
  type RequestWithClient,
} from "./shared";

// Draft invoices on the client's connected account. The row in connect_invoices is stored BEFORE
// any Stripe call and doubles as the idempotency record and the resume point.

/** The create lost its claim to another request (the lease ran out): the other one owns it now. */
class ClaimLostError extends Error {}
/** Postgres failed after Stripe had already done something: the caller retries with the same key. */
class PersistenceError extends Error {}

/** The claim this request holds on a row; `at` moves forward with every save. */
interface Claim {
  at: Date;
}

type Step = <T>(action: string, call: () => Promise<T>) => Promise<T | undefined>;

/** The client's default payment terms when they are a valid day count, else the platform's 30. */
function defaultDaysUntilDue(client: ClientRow): number {
  const terms = client.defaultPaymentTermsDays;
  return terms !== null && Number.isInteger(terms) && terms >= 1 && terms <= 365
    ? terms
    : DEFAULT_DAYS_UNTIL_DUE;
}

const findInvoiceByKey = async (clientId: string, keyHash: string) =>
  (
    await db
      .select()
      .from(connectInvoices)
      .where(
        and(eq(connectInvoices.clientId, clientId), eq(connectInvoices.idempotencyKey, keyHash))
      )
      .limit(1)
  )[0];

/** A replay (or a request that lost the race) of a create that already finished or was deleted. */
const isFinishedOrDeleted = (row: InvoiceRow | undefined): row is InvoiceRow =>
  row?.creationState === "complete" || row?.status === "deleted";

/**
 * Writes progress on a row this request holds the claim on, and renews the claim (claimed_at =
 * now) in the same guarded UPDATE, so a long create keeps its lease while it makes progress. A
 * row no longer claimed by this request (the lease expired and another request took over) means
 * stop: ClaimLostError. Any Postgres failure becomes a PersistenceError (503, same key retry).
 */
async function saveProgress(
  row: InvoiceRow,
  claim: Claim,
  patch: Partial<typeof connectInvoices.$inferInsert>
): Promise<InvoiceRow> {
  const renewedAt = new Date();
  let updated: InvoiceRow | undefined;
  try {
    [updated] = await db
      .update(connectInvoices)
      .set({ claimedAt: renewedAt, ...patch })
      .where(and(eq(connectInvoices.id, row.id), eq(connectInvoices.claimedAt, claim.at)))
      .returning();
  } catch (err) {
    throw new PersistenceError("invoice progress not saved", { cause: err });
  }
  if (!updated) throw new ClaimLostError();
  if (updated.claimedAt) claim.at = updated.claimedAt;
  return updated;
}

// Look-ups used only when a resumed create is older than Stripe's idempotency window, where the
// per-step keys no longer protect against a duplicate. The objects carry our metadata.
// Returns the invoice, null when the search was COMPLETE and found none, or undefined after an
// error reply. A search that runs out of pages is never "not found": it answers 503 and the
// caller creates nothing.
async function findAdoptableInvoice(
  request: FastifyRequest,
  reply: FastifyReply,
  step: Step,
  row: InvoiceRow,
  keyHash: string
): Promise<Stripe.Invoice | null | undefined> {
  const since = Math.floor(row.createdAt.getTime() / 1000) - 300;
  let startingAfter: string | undefined;
  for (let page = 0; page < INVOICE_ADOPTION_MAX_PAGES; page++) {
    const list = await step("invoices.list", () =>
      stripe.invoices.list(
        {
          customer: row.stripeCustomerId,
          created: { gte: since },
          limit: 100,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        },
        { stripeAccount: row.connectedAccountId }
      )
    );
    if (!list) return undefined;
    const hit = list.data.find(
      (i) => i.metadata?.dfwsc_idem_key === keyHash && i.metadata?.dfwsc_client_id === row.clientId
    );
    if (hit) return hit;
    const last = list.data[list.data.length - 1];
    if (!list.has_more) return null;
    // has_more with nothing to page from is inconclusive, never "not found".
    if (!last) break;
    startingAfter = last.id;
  }
  request.log.error(
    { clientId: row.clientId, invoiceRowId: row.id, pages: INVOICE_ADOPTION_MAX_PAGES },
    "Invoice adoption search incomplete; refusing to create a possible duplicate"
  );
  reply.code(503).header("Retry-After", "60").send({
    error:
      "The invoice could not be looked up safely right now. Retry later with the same Idempotency-Key, or contact support.",
    code: "INVOICE_ADOPTION_INCOMPLETE",
  });
  return undefined;
}

/** What one create run (driveCreate and its steps) works with. */
interface CreateRun {
  request: FastifyRequest;
  reply: FastifyReply;
  step: Step;
  claim: Claim;
  req: InvoiceRequest;
  keyHash: string;
  client: ClientRow;
  /** Always the account the row was reserved on, never the client's current one. */
  stripeAccount: string;
  idemBase: string;
  /** A resumed create older than Stripe's idempotency window: per-step keys no longer protect. */
  beyondKeyWindow: boolean;
  baseMetadata: { dfwsc_client_id: string; dfwsc_idem_key: string };
}

/** Step 1: the Stripe invoice (created, or adopted when the key window has passed). */
async function ensureStripeInvoice(
  run: CreateRun,
  cur: InvoiceRow
): Promise<InvoiceRow | undefined> {
  if (cur.stripeInvoiceId) return cur;
  const { request, reply, step, claim, req, keyHash, client, stripeAccount, idemBase } = run;
  let invoice: Stripe.Invoice | null | undefined = null;
  if (run.beyondKeyWindow) {
    invoice = await findAdoptableInvoice(request, reply, step, cur, keyHash);
    if (invoice === undefined) return undefined;
  }
  if (!invoice) {
    const metadata = validateStripeMetadata({ ...req.userMetadata, ...run.baseMetadata });
    const params: Stripe.InvoiceCreateParams = {
      customer: cur.stripeCustomerId,
      collection_method: "send_invoice",
      days_until_due: req.daysUntilDue ?? defaultDaysUntilDue(client),
      auto_advance: false,
      pending_invoice_items_behavior: "exclude",
      currency: "usd",
      // The fee is the stored one: a retry after a fee-setting change must send what the
      // first attempt did (Stripe refuses an idempotent call with other parameters).
      ...(cur.feeAmountCents > 0 ? { application_fee_amount: cur.feeAmountCents } : {}),
      ...(req.description ? { description: req.description } : {}),
      ...(req.footer ? { footer: req.footer } : {}),
      metadata,
    };
    invoice = await step("invoices.create", () =>
      stripe.invoices.create(params, {
        stripeAccount,
        idempotencyKey: `${idemBase}:invoice`,
      })
    );
    if (!invoice) return undefined;
  }
  return saveProgress(cur, claim, {
    stripeInvoiceId: invoice.id,
    creationState: "invoice_created",
  });
}

/** Items already on the invoice from an earlier attempt, by line tag (key window passed only). */
async function listKnownItems(
  run: CreateRun,
  invoiceId: string
): Promise<Map<string, string> | undefined> {
  const { step, keyHash, stripeAccount } = run;
  const list = await step("invoiceItems.list", () =>
    stripe.invoiceItems.list({ invoice: invoiceId, limit: 100 }, { stripeAccount })
  );
  if (!list) return undefined;
  return new Map(
    list.data.flatMap((it) =>
      it.metadata?.dfwsc_idem_key === keyHash && typeof it.metadata.dfwsc_line === "string"
        ? [[it.metadata.dfwsc_line, it.id] as [string, string]]
        : []
    )
  );
}

/** One invoice item (a line, or the fee under tag "fee"); an item adopted from `known` is reused. */
async function createInvoiceItem(
  run: CreateRun,
  customerId: string,
  invoiceId: string,
  known: Map<string, string>,
  tag: string,
  item: { description: string; quantity: number; unitAmountCents: number }
): Promise<string | undefined> {
  const adopted = known.get(tag);
  if (adopted) return adopted;
  // A line keeps its quantity and unit amount on the invoice: quantity plus
  // unit_amount_decimal (price_data would need a Product).
  const created = await run.step(`invoiceItems.create:${tag}`, () =>
    stripe.invoiceItems.create(
      {
        customer: customerId,
        invoice: invoiceId,
        currency: "usd",
        description: item.description,
        quantity: item.quantity,
        unit_amount_decimal: String(item.unitAmountCents),
        metadata: { ...run.baseMetadata, dfwsc_line: tag },
      },
      {
        stripeAccount: run.stripeAccount,
        idempotencyKey: `${run.idemBase}:${tag === "fee" ? "fee" : `line:${tag}`}`,
      }
    )
  );
  return created?.id;
}

/** Step 2: one invoice item per line, then the fee item. */
async function ensureInvoiceItems(
  run: CreateRun,
  start: InvoiceRow
): Promise<InvoiceRow | undefined> {
  if (start.creationState !== "invoice_created") return start;
  const { claim, req } = run;
  let cur = start;
  const invoiceId = cur.stripeInvoiceId as string;
  const ids: string[] = Array.isArray(cur.lineItemIds) ? (cur.lineItemIds as string[]) : [];
  const wantFee = cur.feeAmountCents > 0;
  const incomplete = ids.length < req.lines.length || (wantFee && !cur.stripeFeeItemId);
  let known = new Map<string, string>();
  if (run.beyondKeyWindow && incomplete) {
    const listed = await listKnownItems(run, invoiceId);
    if (!listed) return undefined;
    known = listed;
  }

  for (let i = ids.length; i < req.lines.length; i++) {
    const id = await createInvoiceItem(
      run,
      cur.stripeCustomerId,
      invoiceId,
      known,
      String(i),
      req.lines[i]
    );
    if (!id) return undefined;
    ids.push(id);
    cur = await saveProgress(cur, claim, { lineItemIds: [...ids] });
  }
  if (wantFee && !cur.stripeFeeItemId) {
    const id = await createInvoiceItem(run, cur.stripeCustomerId, invoiceId, known, "fee", {
      description: PROCESSING_FEE_DESCRIPTION,
      quantity: 1,
      unitAmountCents: cur.feeAmountCents,
    });
    if (!id) return undefined;
    cur = await saveProgress(cur, claim, { stripeFeeItemId: id });
  }
  return saveProgress(cur, claim, { creationState: "lines_added" });
}

/** Does the re-read Stripe draft agree with the amounts this API computed? */
export function invoiceMatchesComputed(
  fresh: Pick<Stripe.Invoice, "total" | "subtotal" | "currency" | "status">,
  stripeFee: number | null | undefined,
  row: Pick<InvoiceRow, "totalCents" | "feeAmountCents">
): boolean {
  return !(
    fresh.total !== row.totalCents ||
    fresh.subtotal !== row.totalCents ||
    fresh.currency !== "usd" ||
    fresh.status !== "draft" ||
    row.feeAmountCents > fresh.total ||
    (typeof stripeFee === "number" && stripeFee !== row.feeAmountCents)
  );
}

/** Step 3: re-read the invoice, check Stripe agrees with our arithmetic, and complete the row. */
async function verifyAndComplete(run: CreateRun, cur: InvoiceRow): Promise<InvoiceRow | undefined> {
  const { request, reply, step, claim, req, client, stripeAccount } = run;
  const invoiceId = cur.stripeInvoiceId as string;
  const fresh = await step("invoices.retrieve", () =>
    stripe.invoices.retrieve(invoiceId, {}, { stripeAccount })
  );
  if (!fresh) return undefined;
  // `application_fee_amount` is not on the clover Invoice type, but is read when present.
  const stripeFee = (fresh as unknown as { application_fee_amount?: number | null })
    .application_fee_amount;
  if (!invoiceMatchesComputed(fresh, stripeFee, cur)) {
    // The draft stays on the connected account, unsent and uncollectable; the row stays at
    // 'lines_added' (hidden from reads) so the next retry checks again.
    request.log.error(
      {
        clientId: client.id,
        stripeInvoiceId: invoiceId,
        expectedTotalCents: cur.totalCents,
        stripeTotalCents: fresh.total,
        stripeSubtotalCents: fresh.subtotal,
        expectedFeeCents: cur.feeAmountCents,
        stripeFeeCents: stripeFee,
        stripeStatus: fresh.status,
      },
      "Stripe invoice does not match the computed amounts; leaving the draft"
    );
    reply.code(502).send({
      error:
        "The invoice could not be verified against the computed amounts. It was left as an unsent draft.",
      code: "INVOICE_TOTAL_MISMATCH",
    });
    return undefined;
  }
  return saveProgress(cur, claim, {
    creationState: "complete",
    status: "draft",
    // Lines before the fee; Stripe's own subtotal already includes the fee item.
    subtotalCents: fresh.subtotal - cur.feeAmountCents,
    totalCents: fresh.total,
    amountPaidCents: fresh.amount_paid,
    amountRemainingCents: fresh.amount_remaining,
    number: fresh.number ?? null,
    dueDate: fresh.due_date ? new Date(fresh.due_date * 1000) : null,
    hostedInvoiceUrl: fresh.hosted_invoice_url ?? null,
    invoicePdf: fresh.invoice_pdf ?? null,
    description: req.description,
    metadata: req.userMetadata,
    lastSyncedAt: new Date(),
    claimedAt: null,
  });
}

/**
 * Runs the create steps from wherever the row left off. Returns the completed row, or undefined
 * after sending an error reply. Throws ClaimLostError / PersistenceError (handled by the caller).
 *
 * Steps, each with its own Stripe idempotency key and its Stripe id saved before the next one:
 *   invoice ('invoice_created') -> one item per line, then the fee item ('lines_added') ->
 *   retrieve, verify, complete.
 */
async function driveCreate(
  deps: InvoicingDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  initial: InvoiceRow,
  claim: Claim,
  req: InvoiceRequest,
  keyHash: string,
  resumed: boolean
): Promise<InvoiceRow | undefined> {
  const client = (request as RequestWithClient).client;

  // Only a request that has not yet reached Stripe gives its write token back when refused.
  let succeeded = 0;
  const step: Step = async (action, call) => {
    const out = await deps.stripeCall(request, reply, action, call, {
      write: succeeded === 0,
      notFound: "Customer or invoice not found on the connected account.",
    });
    if (out !== undefined) succeeded += 1;
    return out;
  };

  const run: CreateRun = {
    request,
    reply,
    step,
    claim,
    req,
    keyHash,
    client,
    stripeAccount: initial.connectedAccountId,
    idemBase: `${client.id}:inv:${keyHash}`,
    beyondKeyWindow:
      resumed && Date.now() - initial.createdAt.getTime() >= INVOICE_STRIPE_KEY_WINDOW_MS,
    baseMetadata: { dfwsc_client_id: client.id, dfwsc_idem_key: keyHash },
  };

  const withInvoice = await ensureStripeInvoice(run, initial);
  if (!withInvoice) return undefined;
  const withLines = await ensureInvoiceItems(run, withInvoice);
  if (!withLines) return undefined;
  return verifyAndComplete(run, withLines);
}

/**
 * Parses and validates a create body into the hashed request. Throws the 400s (reserved or
 * oversized metadata); a body that fails the schema has already been answered when this returns
 * undefined.
 */
function parseCreateRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  clientId: string,
  keyHash: string
): { req: InvoiceRequest; baseCents: number; requestHash: string } | undefined {
  // Finalizing and sending are separate steps for now. Refused, not ignored: a caller that
  // sends `send: true` must not believe the invoice went out.
  const raw = request.body;
  if (raw && typeof raw === "object" && ("finalize" in raw || "send" in raw)) {
    throw errors.badRequest(
      "finalize and send are not supported when creating an invoice; the invoice is created as a draft."
    );
  }
  const body = parseBody(createInvoiceBodySchema, request.body, reply);
  if (!body) return undefined;

  const userMetadata = validateStripeMetadata(body.metadata);
  assertNoReservedMetadataKeys(userMetadata);
  // Leaves room for the two keys this API adds.
  validateStripeMetadata({ ...userMetadata, dfwsc_client_id: clientId, dfwsc_idem_key: keyHash });

  const baseCents = computeBaseCents(body.lines);
  const req: InvoiceRequest = {
    customerId: body.customerId,
    lines: body.lines.map((l) => ({
      description: l.description,
      unitAmountCents: l.unitAmountCents,
      quantity: l.quantity,
    })),
    currency: "usd",
    // As sent: the default terms are resolved only when calling Stripe (and not hashed).
    daysUntilDue: body.daysUntilDue ?? null,
    description: body.description ?? null,
    footer: body.footer ?? null,
    userMetadata,
  };
  return { req, baseCents, requestHash: hashInvoiceRequest(req) };
}

/** The processing fee for a new invoice. Throws the 400 for an unresolvable or invalid fee. */
async function computeInvoiceFee(client: ClientRow, baseCents: number): Promise<number> {
  const group = client.groupId
    ? ((
        await db.select().from(clientGroups).where(eq(clientGroups.id, client.groupId)).limit(1)
      )[0] ?? null)
    : null;
  let feeCents: number;
  try {
    // API keys can never waive the fee: waiveFee is not part of the body.
    feeCents = await resolveClientFee(client, group, baseCents);
  } catch (e: unknown) {
    throw errors.badRequest((e as Error).message);
  }
  if (!Number.isSafeInteger(feeCents) || feeCents < 0) {
    throw errors.badRequest("Computed fee is invalid.");
  }
  return feeCents;
}

/** Is the customer this client's, on this client's connected account? */
async function customerIsOwned(
  clientId: string,
  connectedAccountId: string,
  stripeCustomerId: string
): Promise<boolean> {
  const [customer] = await db
    .select({ id: connectCustomers.id })
    .from(connectCustomers)
    .where(
      and(
        eq(connectCustomers.clientId, clientId),
        eq(connectCustomers.connectedAccountId, connectedAccountId),
        eq(connectCustomers.stripeCustomerId, stripeCustomerId)
      )
    )
    .limit(1);
  return Boolean(customer);
}

/**
 * Rolling 24 hour ceiling, counted from connect_invoices. Two requests racing the last slot can
 * overshoot by one; the ceiling is a runaway guard, not an exact quota. Sends the 429 and returns
 * true when the ceiling is reached.
 */
async function replyIfDailyLimitReached(reply: FastifyReply, clientId: string): Promise<boolean> {
  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [usage] = await db
    .select({ n: count(), oldest: min(connectInvoices.createdAt) })
    .from(connectInvoices)
    .where(
      and(eq(connectInvoices.clientId, clientId), gte(connectInvoices.createdAt, windowStart))
    );
  if (usage.n < INVOICE_DAILY_CREATE_LIMIT) return false;
  const retryMs = usage.oldest ? usage.oldest.getTime() + 24 * 60 * 60 * 1000 - Date.now() : 60_000;
  reply
    .code(429)
    .header("Retry-After", String(Math.max(1, Math.ceil(retryMs / 1000))))
    .send({
      error: `At most ${INVOICE_DAILY_CREATE_LIMIT} invoices can be created per day.`,
      code: "INVOICE_DAILY_LIMIT",
    });
  return true;
}

interface ReserveInput {
  client: ClientRow;
  stripeAccount: string;
  keyHash: string;
  req: InvoiceRequest;
  requestHash: string;
  baseCents: number;
  claimAt: Date;
}

/**
 * A key with no row yet: run every 4xx check that comes before the first Stripe call, take the
 * write token, and store the row BEFORE Stripe. `claimed` is false when a concurrent request with
 * the same key won the insert (this one then handles it as a replay). Returns undefined after
 * sending an error reply.
 */
async function reserveInvoiceRow(
  deps: InvoicingDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  i: ReserveInput
): Promise<{ row: InvoiceRow; claimed: boolean } | undefined> {
  const { client, stripeAccount, keyHash, req, requestHash, baseCents, claimAt } = i;
  const clientId = client.id;
  const feeCents = await computeInvoiceFee(client, baseCents);
  const totalCents = baseCents + feeCents;
  assertTotalWithinCap(totalCents);

  if (!(await customerIsOwned(clientId, stripeAccount, req.customerId))) {
    reply.code(404).send({ error: "Customer not found.", code: "NOT_FOUND" });
    return undefined;
  }
  if (await replyIfDailyLimitReached(reply, clientId)) return undefined;
  if (!(await deps.takeWriteToken(request, reply))) return undefined;

  // Store BEFORE Stripe. A concurrent request with the same key loses this insert and is
  // handled as a replay below.
  const [inserted] = await db
    .insert(connectInvoices)
    .values({
      id: uuidv4(),
      clientId,
      connectedAccountId: stripeAccount,
      stripeCustomerId: req.customerId,
      idempotencyKey: keyHash,
      requestHash,
      creationState: "reserved",
      status: "draft",
      currency: "usd",
      subtotalCents: baseCents,
      feeAmountCents: feeCents,
      totalCents,
      amountRemainingCents: totalCents,
      description: req.description,
      metadata: req.userMetadata,
      claimedAt: claimAt,
      // Millisecond precision on purpose: the list cursor round-trips this value exactly.
      createdAt: claimAt,
    })
    .onConflictDoNothing({
      target: [connectInvoices.clientId, connectInvoices.idempotencyKey],
    })
    .returning();
  if (inserted) return { row: inserted, claimed: true };
  const row = await findInvoiceByKey(clientId, keyHash);
  if (!row) throw errors.internal();
  return { row, claimed: false };
}

interface ResumeInput {
  row: InvoiceRow;
  clientId: string;
  stripeAccount: string;
  keyHash: string;
  claim: Claim;
  tokenTaken: boolean;
}

/**
 * An existing, unfinished row this request did not insert: a resume stays on the account the row
 * was reserved on, and takes the claim unless another request holds a live one. Returns the
 * claimed row, or undefined after sending a reply.
 */
async function claimForResume(
  deps: InvoicingDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  i: ResumeInput
): Promise<InvoiceRow | undefined> {
  const { row, clientId, stripeAccount, keyHash, claim, tokenTaken } = i;
  // If the client has been moved to another account since, nothing is sent: the saved ids belong
  // to the old one.
  if (row.connectedAccountId !== stripeAccount) {
    reply.code(409).send({
      error:
        "The client's Stripe account changed since this Idempotency-Key was first used. Use a new key.",
      code: "ACCOUNT_CHANGED",
    });
    return undefined;
  }
  if (!(await customerIsOwned(clientId, row.connectedAccountId, row.stripeCustomerId))) {
    reply.code(404).send({ error: "Customer not found.", code: "NOT_FOUND" });
    return undefined;
  }
  // Resume: take the claim unless another request holds a live one.
  if (!tokenTaken && !(await deps.takeWriteToken(request, reply))) return undefined;
  claim.at = new Date();
  const [taken] = await db
    .update(connectInvoices)
    .set({ claimedAt: claim.at })
    .where(
      and(
        eq(connectInvoices.id, row.id),
        ne(connectInvoices.creationState, "complete"),
        ne(connectInvoices.status, "deleted"),
        or(
          isNull(connectInvoices.claimedAt),
          lt(connectInvoices.claimedAt, new Date(claim.at.getTime() - INVOICE_CLAIM_LEASE_MS))
        )
      )
    )
    .returning();
  if (taken) return taken;
  const latest = await findInvoiceByKey(clientId, keyHash);
  if (isFinishedOrDeleted(latest)) {
    reply.code(200).send(serializeInvoice(latest));
    return undefined;
  }
  if (tokenTaken) await deps.writeBucket.refund(request);
  invoiceKeyInUse(reply);
  return undefined;
}

/**
 * Drives the create under the row's claim and turns a lost claim or a Postgres failure into the
 * reply. Returns the completed row, or undefined once a reply has been sent.
 */
async function runClaimedCreate(
  deps: InvoicingDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  i: { row: InvoiceRow; claim: Claim; req: InvoiceRequest; keyHash: string; resumed: boolean }
): Promise<InvoiceRow | undefined> {
  const { row, claim, req, keyHash, resumed } = i;
  const clientId = (request as RequestWithClient).client.id;

  // Give the claim back so an immediate retry resumes instead of waiting out the lease. A
  // finished row already cleared it. Best effort: the lease expires on its own.
  // One shared promise: the handler's `finally` and the onSend hook both wait on the same
  // release, and the response cannot leave before it is done. (The hook cannot be skipped by the
  // handler returning first: it runs after the handler, so the entry must outlive it.)
  let releasing: Promise<void> | undefined;
  const releaseClaim = () => {
    releasing ??= db
      .update(connectInvoices)
      .set({ claimedAt: null })
      .where(and(eq(connectInvoices.id, row.id), eq(connectInvoices.claimedAt, claim.at)))
      .then(() => undefined)
      .catch(() => undefined);
    return releasing;
  };
  deps.pendingRelease.set(request, releaseClaim);

  try {
    return await driveCreate(deps, request, reply, row, claim, req, keyHash, resumed);
  } catch (err) {
    if (err instanceof ClaimLostError) {
      // Another request took the row over (the lease ran out). If it finished the invoice,
      // that is this request's answer too.
      const latest = await findInvoiceByKey(clientId, keyHash);
      if (isFinishedOrDeleted(latest)) {
        reply.code(200).send(serializeInvoice(latest));
        return undefined;
      }
      invoiceKeyInUse(reply);
      return undefined;
    }
    if (err instanceof PersistenceError) {
      // The driver error quotes the failed query's parameters (which can include a hosted
      // URL), so only its SQLSTATE is logged.
      const dbCode = (err.cause as { cause?: { code?: unknown } } | undefined)?.cause?.code;
      request.log.error(
        { clientId, invoiceRowId: row.id, dbCode },
        "Invoice step done on Stripe but not recorded; returning 503"
      );
      reply.code(503).send({
        error:
          "Invoice created but confirmation failed. Please retry with the same Idempotency-Key.",
        code: "LEDGER_PERSISTENCE_FAILED",
      });
      return undefined;
    }
    throw err;
  } finally {
    await releaseClaim();
  }
}

/** POST /invoices: create a draft invoice (idempotent, resumable). */
export function registerInvoiceCreateRoutes(fastify: FastifyInstance, deps: InvoicingDeps) {
  fastify.post("/invoices", { preHandler: deps.chargeGuards }, async (request, reply) => {
    const client = (request as RequestWithClient).client;
    const clientId = client.id;
    const stripeAccount = accountOf(request);

    const keyHash = parseIdempotencyKeyHash(request);
    const parsed = parseCreateRequest(request, reply, clientId, keyHash);
    if (!parsed) return;
    const { req, baseCents, requestHash } = parsed;

    // Everything below that can answer 4xx runs before the first Stripe call.
    let tokenTaken = false;
    let row = await findInvoiceByKey(clientId, keyHash);
    const claimAt = new Date();
    const claim: Claim = { at: claimAt };
    let claimed = false;

    if (!row) {
      const reserved = await reserveInvoiceRow(deps, request, reply, {
        client,
        stripeAccount,
        keyHash,
        req,
        requestHash,
        baseCents,
        claimAt,
      });
      if (!reserved) return reply;
      tokenTaken = true;
      ({ row, claimed } = reserved);
    }

    if (row.requestHash !== requestHash) {
      return reply.code(409).send({
        error:
          "This Idempotency-Key was already used for a different invoice. Use a new unique key for each new invoice.",
        code: "IDEMPOTENCY_KEY_REUSED",
      });
    }
    // A deleted draft stays deleted: a replay reports it and never resumes adding lines.
    if (row.creationState === "complete" || row.status === "deleted") {
      return reply.code(200).send(serializeInvoice(row));
    }

    if (!claimed) {
      const taken = await claimForResume(deps, request, reply, {
        row,
        clientId,
        stripeAccount,
        keyHash,
        claim,
        tokenTaken,
      });
      if (!taken) return reply;
      row = taken;
    }

    const done = await runClaimedCreate(deps, request, reply, {
      row,
      claim,
      req,
      keyHash,
      resumed: !claimed,
    });
    if (!done) return reply;
    return reply.code(201).send(serializeInvoice(done));
  });
}
