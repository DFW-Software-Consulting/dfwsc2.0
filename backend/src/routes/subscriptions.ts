import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type Stripe from "stripe";
import { db } from "../db/client";
import { clients } from "../db/schema";
import { requireAdminJwt } from "../lib/auth";
import { sendInvoiceEmail } from "../lib/mailer";
import { syncInvoiceToNextcloud, toNextcloudLedgerInvoiceInput } from "../lib/nextcloud-sync";
import { stripe } from "../lib/stripe";
import {
  type CalendarInterval,
  calculateIterations,
  ensureStripeCustomer,
  toStripeInterval,
} from "../lib/stripe-billing";
import { getStripeCustomerId, resolveSubscriptionClients } from "../lib/subscription-resolution";
import {
  STRIPE_LIST_LIMIT,
  validateDateFormat,
  validateDateRange,
  validateInterval,
  validateRequiredString,
  validateTaxRate,
  validateWorkspace,
  validateWorkspaceQuery,
  type Workspace,
} from "../lib/validation";

interface StripeSubscriptionWithPeriod extends Stripe.Subscription {
  current_period_end: number;
}

// Legacy interface for backward compatibility during transition
interface CreateSubscriptionBodyLegacy {
  clientId: string;
  workspace: Workspace;
  amountCents: number;
  description: string;
  interval: "monthly" | "quarterly" | "yearly";
  totalPayments?: number | null;
  taxRateId?: string | null;
}

// New calendar-based interface
interface CreateSubscriptionBody {
  clientId: string;
  workspace: Workspace;
  amountPerPaymentCents: number;
  description: string;
  interval: CalendarInterval;
  startDate: string; // YYYY-MM-DD
  endDate?: string | null; // YYYY-MM-DD, null = forever (recurring)
  taxRateId?: string | null;
}

interface SubscriptionParams {
  id: string;
}

interface SubscriptionPatchBody {
  status?: "paused" | "cancelled" | "active";
  totalPayments?: number | null;
  amountCents?: number;
  description?: string;
}

interface SubscriptionPatchQuery {
  workspace?: string;
}

interface SubscriptionFilterQuery {
  workspace?: string;
  clientId?: string;
}

interface DashboardQuery {
  workspace?: string;
  days?: string;
}

interface LinkSubscriptionBody {
  subscriptionId: string;
  clientId: string;
  workspace: Workspace;
}

const DASHBOARD_CACHE_TTL_MS = process.env.NODE_ENV === "test" ? 0 : 30_000;

type DashboardCacheEntry = {
  expiresAt: number;
  subscriptions: Stripe.Subscription[];
  schedules: Stripe.SubscriptionSchedule[];
};

const dashboardStripeCache = new Map<Workspace, DashboardCacheEntry>();

async function listAllSubscriptions(
  params: Stripe.SubscriptionListParams
): Promise<Stripe.Subscription[]> {
  const all: Stripe.Subscription[] = [];
  let startingAfter: string | undefined;

  while (true) {
    const page = await stripe.subscriptions.list({
      ...params,
      limit: STRIPE_LIST_LIMIT,
      starting_after: startingAfter,
    });
    all.push(...page.data);

    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1]?.id;
    if (!startingAfter) break;
  }

  return all;
}

async function listAllSchedules(
  params: Stripe.SubscriptionScheduleListParams
): Promise<Stripe.SubscriptionSchedule[]> {
  const all: Stripe.SubscriptionSchedule[] = [];
  let startingAfter: string | undefined;

  while (true) {
    const page = await stripe.subscriptionSchedules.list({
      ...params,
      limit: STRIPE_LIST_LIMIT,
      starting_after: startingAfter,
    });
    all.push(...page.data);

    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1]?.id;
    if (!startingAfter) break;
  }

  return all;
}

async function getDashboardStripeData(workspace: Workspace): Promise<{
  subscriptions: Stripe.Subscription[];
  schedules: Stripe.SubscriptionSchedule[];
}> {
  const now = Date.now();
  const cached = dashboardStripeCache.get(workspace);
  if (cached && cached.expiresAt > now) {
    return {
      subscriptions: cached.subscriptions,
      schedules: cached.schedules,
    };
  }

  const [subscriptions, schedules] = await Promise.all([
    listAllSubscriptions({ status: "all" }),
    listAllSchedules({}),
  ]);

  if (DASHBOARD_CACHE_TTL_MS > 0) {
    if (dashboardStripeCache.size >= 50) dashboardStripeCache.clear();
    dashboardStripeCache.set(workspace, {
      expiresAt: now + DASHBOARD_CACHE_TTL_MS,
      subscriptions,
      schedules,
    });
  }

  return { subscriptions, schedules };
}

// Format Stripe subscription for response
function formatStripeSub(
  sub: Stripe.Subscription,
  clientId: string,
  clientName?: string | null,
  unlinked = false
) {
  const item = sub.items.data[0];
  const rawStatus = sub.pause_collection ? "paused" : sub.status;
  const status = (rawStatus as string) === "canceled" ? "cancelled" : rawStatus;
  const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;

  // Determine subscription type from metadata
  const type = (sub.metadata?.type as "payment_plan" | "recurring") ?? "recurring";
  const startDate = sub.metadata?.startDate;
  const endDate = sub.metadata?.endDate ?? null;
  const totalPayments = sub.metadata?.totalPayments ? Number(sub.metadata.totalPayments) : null;
  const amountPerPaymentCents = sub.metadata?.amountPerPaymentCents
    ? Number(sub.metadata.amountPerPaymentCents)
    : (item?.price?.unit_amount ?? 0);
  const totalAmountCents = sub.metadata?.totalAmountCents
    ? Number(sub.metadata.totalAmountCents)
    : null;
  const paymentsMade = sub.metadata?.paymentsMade ? Number(sub.metadata.paymentsMade) : 0;

  return {
    id: sub.id,
    clientId,
    clientName: clientName ?? null,
    type,
    description: sub.metadata?.description ?? "",
    amountPerPaymentCents,
    totalAmountCents,
    totalPayments,
    paymentsMade,
    interval: sub.metadata?.interval ?? "month",
    startDate,
    endDate,
    nextPaymentDate: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    status,
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    createdAt: new Date(sub.created * 1000).toISOString(),
    unlinked,
  };
}

// Format Stripe subscription schedule for response
function formatStripeSchedule(
  schedule: Stripe.SubscriptionSchedule,
  clientId: string,
  clientName?: string | null,
  unlinked = false
) {
  const phase = schedule.phases?.[0];
  const startDate = phase?.start_date
    ? new Date(phase.start_date * 1000).toISOString().split("T")[0]
    : null;
  const endDate = phase?.end_date
    ? new Date(phase.end_date * 1000).toISOString().split("T")[0]
    : null;

  const totalPayments = schedule.metadata?.totalPayments
    ? Number(schedule.metadata.totalPayments)
    : null;
  const phaseItem = phase?.items?.[0] as { plan?: { amount?: number } } | undefined;
  const phaseItemAmount = phaseItem?.plan?.amount ?? 0;
  const amountPerPaymentCents = schedule.metadata?.amountPerPaymentCents
    ? Number(schedule.metadata.amountPerPaymentCents)
    : phaseItemAmount;
  const totalAmountCents = schedule.metadata?.totalAmountCents
    ? Number(schedule.metadata.totalAmountCents)
    : null;
  const paymentsMade = schedule.metadata?.paymentsMade ? Number(schedule.metadata.paymentsMade) : 0;

  return {
    id: schedule.id,
    clientId,
    clientName: clientName ?? null,
    type: "payment_plan" as const,
    description: schedule.metadata?.description ?? "",
    amountPerPaymentCents,
    totalAmountCents,
    totalPayments,
    paymentsMade,
    interval: schedule.metadata?.interval ?? "month",
    startDate,
    endDate,
    nextPaymentDate: startDate, // First payment is on start date
    status: schedule.status === "canceled" ? "cancelled" : schedule.status,
    currentPeriodEnd: null,
    createdAt: new Date(schedule.created * 1000).toISOString(),
    unlinked,
  };
}

function formatStripeInvoice(inv: Stripe.Invoice, clientId?: string | null) {
  return {
    id: inv.id,
    clientId: clientId ?? inv.metadata?.clientId ?? null,
    amountCents: inv.amount_due,
    description: inv.description ?? "",
    dueDate: inv.due_date ? new Date(inv.due_date * 1000).toISOString() : null,
    status: inv.status,
    hostedUrl: inv.hosted_invoice_url ?? null,
    paidAt: inv.status_transitions?.paid_at
      ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
      : null,
    createdAt: new Date(inv.created * 1000).toISOString(),
  };
}

function backfillClientMetadata(
  backfills: Array<{
    kind: "subscription" | "schedule";
    id: string;
    clientId: string;
    existingMetadata: Record<string, string>;
  }>
) {
  if (backfills.length === 0) return;

  void Promise.allSettled(
    backfills.map((entry) => {
      const metadata = { ...entry.existingMetadata, clientId: entry.clientId };
      if (entry.kind === "subscription") {
        return stripe.subscriptions.update(entry.id, { metadata });
      }
      return stripe.subscriptionSchedules.update(entry.id, { metadata });
    })
  ).then((results) => {
    for (const [i, result] of results.entries()) {
      if (result.status === "rejected") {
        console.error(
          `[backfillClientMetadata] Failed to update ${backfills[i].kind} ${backfills[i].id}:`,
          result.reason
        );
      }
    }
  });
}

// Helper to convert legacy interval to new interval
function legacyToNewInterval(interval: "monthly" | "quarterly" | "yearly"): CalendarInterval {
  switch (interval) {
    case "monthly":
      return "month";
    case "quarterly":
      return "quarter";
    case "yearly":
      return "year";
  }
}

// Type guard to check if body is new format
function isNewFormat(body: unknown): body is CreateSubscriptionBody {
  return (
    typeof body === "object" &&
    body !== null &&
    "amountPerPaymentCents" in body &&
    "startDate" in body
  );
}

const subscriptionRoutes: FastifyPluginAsync = async (app) => {
  // POST /subscriptions — create Stripe subscription (calendar-based or legacy)
  app.post<{ Body: CreateSubscriptionBody | CreateSubscriptionBodyLegacy }>(
    "/subscriptions",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const body = req.body;
      const isNew = isNewFormat(body);

      // Extract common fields
      const clientId = body.clientId;
      const workspace = body.workspace;
      const description = body.description;
      const taxRateId = body.taxRateId;

      // New format fields
      let amountPerPaymentCents: number;
      let interval: CalendarInterval;
      let startDate: string;
      let endDate: string | null = null;
      let totalPayments: number | null = null;

      if (isNew) {
        amountPerPaymentCents = body.amountPerPaymentCents;
        interval = body.interval;
        startDate = body.startDate;
        endDate = body.endDate ?? null;
      } else {
        // Legacy format - convert to new format
        amountPerPaymentCents = body.amountCents;
        interval = legacyToNewInterval(body.interval);
        // For legacy, start today
        startDate = new Date().toISOString().split("T")[0];
        if (body.totalPayments) {
          // Calculate end date based on total payments.
          // We advance by (N-1) intervals so the schedule's end_date falls on the
          // last billing date rather than one interval past it. Without the -1,
          // Stripe opens a new billing cycle on end_date before cancelling the
          // schedule, generating N+1 invoices instead of N.
          // Special-case N=1: advance by 1 interval so the schedule has a valid
          // non-zero duration; totalPayments is still stored as 1 in metadata.
          const intervals = body.totalPayments === 1 ? 1 : body.totalPayments - 1;
          const start = new Date(startDate);
          switch (interval) {
            case "month":
              start.setMonth(start.getMonth() + intervals);
              break;
            case "quarter":
              start.setMonth(start.getMonth() + intervals * 3);
              break;
            case "year":
              start.setFullYear(start.getFullYear() + intervals);
              break;
            case "week":
              start.setDate(start.getDate() + intervals * 7);
              break;
            case "bi_weekly":
              start.setDate(start.getDate() + intervals * 14);
              break;
          }
          endDate = start.toISOString().split("T")[0];
        }
      }

      // Validation
      const validWorkspace = validateWorkspace(workspace, res);
      if (!validWorkspace) return;

      if (!clientId) {
        return res.status(400).send({ error: "clientId is required." });
      }
      if (!Number.isInteger(amountPerPaymentCents) || amountPerPaymentCents <= 0) {
        return res.status(400).send({ error: "amountPerPaymentCents must be a positive integer." });
      }
      if (!validateRequiredString(description, "description", res)) return;
      if (!validateInterval(interval, ["week", "bi_weekly", "month", "quarter", "year"], res))
        return;

      // Validate totalPayments if provided (legacy format)
      if (
        !isNew &&
        "totalPayments" in body &&
        body.totalPayments !== undefined &&
        body.totalPayments !== null
      ) {
        if (!Number.isInteger(body.totalPayments) || body.totalPayments < 1) {
          return res.status(400).send({ error: "totalPayments must be a positive integer." });
        }
      }

      const startDateObj = validateDateFormat(startDate, "startDate", res);
      if (!startDateObj) return;

      if (endDate !== null) {
        const endDateObj = validateDateFormat(endDate, "endDate", res);
        if (!endDateObj) return;
        if (!validateDateRange(startDateObj, endDateObj, res)) return;
      }

      if (taxRateId && !(await validateTaxRate(taxRateId, res))) return;

      const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
      if (!client) {
        return res.status(404).send({ error: "Client not found." });
      }
      if (client.workspace !== workspace) {
        return res
          .status(400)
          .send({ error: "clientId does not belong to the selected workspace." });
      }

      const customerId = await ensureStripeCustomer(client);

      // Calculate total payments and total amount if endDate is provided.
      // For the legacy format the caller already specified totalPayments; trust
      // that value rather than re-deriving it from calculateIterations (which
      // would produce N-1 after the endDate adjustment above).
      let totalAmountCents: number | null = null;
      if (endDate) {
        if (!isNew && "totalPayments" in body && body.totalPayments) {
          totalPayments = body.totalPayments;
        } else {
          totalPayments = calculateIterations(startDate, endDate, interval);
        }
        totalAmountCents = amountPerPaymentCents * totalPayments;
      }

      // Common metadata
      const commonMetadata: Record<string, string> = {
        clientId,
        description: description.trim(),
        interval,
        startDate,
        amountPerPaymentCents: String(amountPerPaymentCents),
        taxRateId: taxRateId ?? "",
      };

      if (endDate) {
        commonMetadata.endDate = endDate;
        commonMetadata.totalPayments = String(totalPayments);
        commonMetadata.totalAmountCents = String(totalAmountCents);
        commonMetadata.type = "payment_plan";
      } else {
        commonMetadata.type = "recurring";
      }

      // Path 1: Payment Plan (with endDate) - Use Subscription Schedules
      if (endDate && totalPayments && totalPayments > 0) {
        const stripeInterval = toStripeInterval(interval);

        // Create the price for the subscription schedule
        const price = await stripe.prices.create({
          unit_amount: amountPerPaymentCents,
          currency: "usd",
          recurring: stripeInterval,
          product_data: { name: description.trim() },
          ...(taxRateId ? { tax_behavior: "exclusive" } : {}),
        });

        // Calculate start and end timestamps
        const startTimestamp = Math.floor(startDateObj.getTime() / 1000);
        const endTimestamp = Math.floor(new Date(endDate).getTime() / 1000);

        let schedule: Stripe.SubscriptionSchedule;
        try {
          // @ts-expect-error: Stripe SDK typings missing subscriptionSchedules.create overload for phases with items
          schedule = await stripe.subscriptionSchedules.create({
            customer: customerId,
            start_date: startTimestamp,
            end_behavior: "cancel",
            phases: [
              {
                items: [{ price: price.id }],
                start_date: startTimestamp,
                end_date: endTimestamp,
                collection_method: "send_invoice",
                days_until_due: 30,
                ...(taxRateId ? { default_tax_rates: [taxRateId] } : {}),
              },
            ],
            metadata: commonMetadata,
          });
        } catch (err) {
          await stripe.prices
            .update(price.id, {
              active: false,
              metadata: {
                orphaned: "true",
                orphanedAt: new Date().toISOString(),
              },
            })
            .catch(() => {});
          throw err;
        }

        await sendInvoiceEmail({
          to: client.email,
          clientName: client.name,
          amountCents: amountPerPaymentCents,
          description: description.trim(),
          dueDate: null,
          payUrl: "",
          isSubscription: true,
          paymentsRemaining: totalPayments,
        }).catch(() => {});

        return res.status(201).send({
          subscription: formatStripeSchedule(schedule, clientId, client.name),
        });
      }

      // Path 2: Recurring (no endDate) - Use regular Subscriptions
      const stripeInterval = toStripeInterval(interval);

      const price = await stripe.prices.create({
        unit_amount: amountPerPaymentCents,
        currency: "usd",
        recurring: stripeInterval,
        product_data: { name: description.trim() },
        ...(taxRateId ? { tax_behavior: "exclusive" } : {}),
      });

      // Calculate billing_cycle_anchor from startDate
      const billingCycleAnchor = Math.floor(startDateObj.getTime() / 1000);

      let sub: Stripe.Subscription;
      try {
        sub = await stripe.subscriptions.create({
          customer: customerId,
          items: [{ price: price.id }],
          billing_cycle_anchor: billingCycleAnchor,
          collection_method: "send_invoice",
          days_until_due: 30,
          metadata: commonMetadata,
          ...(taxRateId ? { default_tax_rates: [taxRateId] } : {}),
        });
      } catch (err) {
        await stripe.prices
          .update(price.id, {
            active: false,
            metadata: {
              orphaned: "true",
              orphanedAt: new Date().toISOString(),
            },
          })
          .catch(() => {});
        throw err;
      }

      // Finalize first invoice if it's a draft
      let firstInvoice: Stripe.Invoice | null = null;
      if (sub.latest_invoice) {
        const latestInvoiceId =
          typeof sub.latest_invoice === "string" ? sub.latest_invoice : sub.latest_invoice.id;
        let inv = await stripe.invoices.retrieve(latestInvoiceId);
        if (inv.status === "draft") {
          inv = await stripe.invoices.finalizeInvoice(inv.id);
        }
        firstInvoice = inv;
      }

      const hostedInvoiceUrl = firstInvoice?.hosted_invoice_url ?? null;

      if (firstInvoice) {
        try {
          const ledgerSyncState = await syncInvoiceToNextcloud(
            toNextcloudLedgerInvoiceInput(firstInvoice, {
              id: client.id,
              name: client.name,
              email: client.email,
              workspace: client.workspace,
            })
          );

          if (ledgerSyncState.syncStatus === "failed") {
            req.log.warn(
              {
                invoiceId: firstInvoice.id,
                clientId,
                error: ledgerSyncState.syncError,
              },
              "Failed to sync initial subscription invoice to Nextcloud ledger"
            );
          }
        } catch (err) {
          req.log.warn(
            { err, invoiceId: firstInvoice.id, clientId },
            "Initial subscription invoice ledger sync skipped"
          );
        }
      }

      await sendInvoiceEmail({
        to: client.email,
        clientName: client.name,
        amountCents: amountPerPaymentCents,
        description: description.trim(),
        dueDate: null,
        payUrl: hostedInvoiceUrl ?? "",
        isSubscription: true,
        paymentsRemaining: null,
      }).catch(() => {});

      return res.status(201).send({
        subscription: formatStripeSub(sub, clientId, client.name),
        hostedInvoiceUrl,
      });
    }
  );

  // GET /subscriptions — list with optional ?clientId= filter
  app.get<{ Querystring: SubscriptionFilterQuery }>(
    "/subscriptions",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { workspace, clientId } = req.query;

      const validWorkspace = validateWorkspaceQuery(workspace, res);
      if (!validWorkspace) return;

      // Fetch both regular subscriptions and subscription schedules
      const [allSubs, allSchedules] = await Promise.all([
        listAllSubscriptions({}),
        listAllSchedules({}),
      ]);

      const { subscriptionMap, scheduleMap, backfills } = await resolveSubscriptionClients({
        subscriptions: allSubs,
        schedules: allSchedules,
        workspace: validWorkspace,
      });

      // Filter by clientId if provided
      if (clientId) {
        const filteredSubs = allSubs.filter(
          (sub) => subscriptionMap.get(sub.id)?.clientId === clientId
        );
        const filteredSchedules = allSchedules.filter(
          (sch) => scheduleMap.get(sch.id)?.clientId === clientId
        );

        const formattedSubs = filteredSubs.map((sub) =>
          formatStripeSub(
            sub,
            subscriptionMap.get(sub.id)?.clientId ?? clientId,
            subscriptionMap.get(sub.id)?.clientName ?? null,
            false
          )
        );
        const formattedSchedules = filteredSchedules.map((sch) =>
          formatStripeSchedule(
            sch,
            scheduleMap.get(sch.id)?.clientId ?? clientId,
            scheduleMap.get(sch.id)?.clientName ?? null,
            false
          )
        );

        backfillClientMetadata(
          backfills.filter((entry) =>
            entry.kind === "subscription"
              ? filteredSubs.some((sub) => sub.id === entry.id)
              : filteredSchedules.some((sch) => sch.id === entry.id)
          )
        );

        return res.status(200).send([...formattedSchedules, ...formattedSubs]);
      }

      const formattedSubs = allSubs.map((sub) => {
        const resolved = subscriptionMap.get(sub.id);
        if (!resolved) {
          return formatStripeSub(sub, "", null, true);
        }
        return formatStripeSub(
          sub,
          resolved.clientId,
          resolved.clientName,
          resolved.matchedBy !== "metadata"
        );
      });

      const formattedSchedules = allSchedules.map((sch) => {
        const resolved = scheduleMap.get(sch.id);
        if (!resolved) {
          return formatStripeSchedule(sch, "", null, true);
        }
        return formatStripeSchedule(
          sch,
          resolved.clientId,
          resolved.clientName,
          resolved.matchedBy !== "metadata"
        );
      });

      backfillClientMetadata(backfills);

      return res.status(200).send([...formattedSchedules, ...formattedSubs]);
    }
  );

  // GET /subscriptions/:id — single subscription + invoice list
  app.get<{ Params: SubscriptionParams }>(
    "/subscriptions/:id",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { id } = req.params;

      // Try to fetch as subscription first
      let sub: Stripe.Subscription | null = null;
      let schedule: Stripe.SubscriptionSchedule | null = null;

      try {
        sub = await stripe.subscriptions.retrieve(id, {
          expand: ["latest_invoice", "items.data.price"],
        });
      } catch {
        // Not a subscription, try as schedule
        try {
          schedule = await stripe.subscriptionSchedules.retrieve(id, {
            expand: ["phases.items.plan"],
          });
        } catch {
          return res.status(404).send({ error: "Subscription not found." });
        }
      }

      const clientId = sub?.metadata?.clientId ?? schedule?.metadata?.clientId ?? "";

      let clientName: string | null = null;
      if (clientId) {
        const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
        clientName = client?.name ?? null;
      }

      // Get invoices for this subscription/schedule
      const invoiceList = await stripe.invoices.list({
        subscription: sub?.id ?? undefined,
        limit: STRIPE_LIST_LIMIT,
      });

      if (schedule) {
        return res.status(200).send({
          ...formatStripeSchedule(schedule, clientId, clientName),
          invoices: invoiceList.data.map((inv) => formatStripeInvoice(inv, clientId)),
        });
      }

      if (!sub) {
        return res.status(404).send({ error: "Subscription not found." });
      }

      return res.status(200).send({
        ...formatStripeSub(sub, clientId, clientName),
        invoices: invoiceList.data.map((inv) => formatStripeInvoice(inv, clientId)),
      });
    }
  );

  // PATCH /subscriptions/:id — pause, cancel, resume, or update
  app.patch<{
    Params: SubscriptionParams;
    Querystring: SubscriptionPatchQuery;
    Body: SubscriptionPatchBody;
  }>("/subscriptions/:id", { preHandler: requireAdminJwt }, async (req, res) => {
    const { id } = req.params;
    const { workspace } = req.query;
    const { status, totalPayments, amountCents, description } = req.body;

    const validWorkspace = validateWorkspaceQuery(workspace, res);
    if (!validWorkspace) return;

    if (amountCents !== undefined || description !== undefined) {
      return res.status(400).send({
        error:
          "Editing amountCents and description is not supported. Only totalPayments and status can be changed.",
      });
    }

    if (status !== undefined) {
      const ALLOWED_STATUSES = ["paused", "cancelled", "active"];
      if (!ALLOWED_STATUSES.includes(status)) {
        return res.status(422).send({ error: "status must be one of: paused, cancelled, active." });
      }
    }

    if (totalPayments !== undefined && totalPayments !== null) {
      if (!Number.isInteger(totalPayments) || totalPayments < 1) {
        return res.status(422).send({ error: "totalPayments must be a positive integer." });
      }
    }

    // Try subscription first
    let isSchedule = false;
    let sub: Stripe.Subscription | null = null;
    let schedule: Stripe.SubscriptionSchedule | null = null;

    try {
      sub = await stripe.subscriptions.retrieve(id);
    } catch {
      // Try schedule
      try {
        schedule = await stripe.subscriptionSchedules.retrieve(id);
        isSchedule = true;
      } catch {
        return res.status(404).send({ error: "Subscription not found." });
      }
    }

    const currentStatus = isSchedule
      ? schedule?.status === "canceled"
        ? "cancelled"
        : schedule?.status
      : sub?.status;

    const scopedClientId =
      (isSchedule ? schedule?.metadata?.clientId : sub?.metadata?.clientId) ?? "";
    if (!scopedClientId) {
      return res.status(400).send({ error: "Subscription is missing client metadata." });
    }

    const [scopedClient] = await db
      .select({ id: clients.id, workspace: clients.workspace })
      .from(clients)
      .where(eq(clients.id, scopedClientId))
      .limit(1);

    if (!scopedClient) {
      return res.status(404).send({ error: "Client not found for subscription." });
    }

    if (scopedClient.workspace !== validWorkspace) {
      return res
        .status(400)
        .send({ error: "Subscription does not belong to the selected workspace." });
    }

    if (currentStatus === "cancelled" || currentStatus === "canceled") {
      return res.status(422).send({ error: "Cannot modify a cancelled subscription." });
    }

    if (isSchedule) {
      if (!schedule) {
        return res.status(404).send({ error: "Subscription not found." });
      }

      // Handle subscription schedule updates
      let updated = schedule;

      if (status === "cancelled") {
        updated = await stripe.subscriptionSchedules.cancel(id);
      }

      if (totalPayments !== undefined) {
        updated = await stripe.subscriptionSchedules.update(id, {
          metadata: {
            ...updated.metadata,
            totalPayments: totalPayments !== null ? String(totalPayments) : "",
          },
        });
      }

      const clientId = updated.metadata?.clientId ?? "";
      return res.status(200).send(formatStripeSchedule(updated, clientId));
    }

    // Handle regular subscription updates
    if (!sub) {
      return res.status(404).send({ error: "Subscription not found." });
    }

    let updated = sub;

    if (status === "paused") {
      updated = await stripe.subscriptions.update(id, {
        pause_collection: { behavior: "void" },
      });
    } else if (status === "active") {
      // biome-ignore lint/suspicious/noExplicitAny: Stripe SDK requires "" to clear Emptyable fields
      updated = await stripe.subscriptions.update(id, { pause_collection: "" as any });
    } else if (status === "cancelled") {
      updated = await stripe.subscriptions.update(id, { cancel_at_period_end: true });
    }

    if (totalPayments !== undefined) {
      updated = await stripe.subscriptions.update(id, {
        metadata: {
          ...updated.metadata,
          totalPayments: totalPayments !== null ? String(totalPayments) : "",
        },
      });
    }

    const clientId = updated.metadata?.clientId ?? "";
    return res.status(200).send(formatStripeSub(updated, clientId));
  });

  // POST /subscriptions/link — manually link an existing Stripe subscription to a local client
  app.post<{ Body: LinkSubscriptionBody }>(
    "/subscriptions/link",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { subscriptionId, clientId, workspace } = req.body;

      const validWorkspace = validateWorkspace(workspace, res);
      if (!validWorkspace) return;
      if (!validateRequiredString(subscriptionId, "subscriptionId", res)) return;
      if (!validateRequiredString(clientId, "clientId", res)) return;

      const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);

      if (!client) {
        return res.status(404).send({ error: "Client not found." });
      }
      if (client.workspace !== validWorkspace) {
        return res
          .status(400)
          .send({ error: "clientId does not belong to the selected workspace." });
      }

      let sub: Stripe.Subscription | null = null;
      let schedule: Stripe.SubscriptionSchedule | null = null;

      try {
        sub = await stripe.subscriptions.retrieve(subscriptionId);
      } catch {
        try {
          schedule = await stripe.subscriptionSchedules.retrieve(subscriptionId);
        } catch {
          return res.status(404).send({ error: "Subscription not found." });
        }
      }

      const customerId = getStripeCustomerId(sub?.customer ?? schedule?.customer);
      if (client.stripeCustomerId && customerId && client.stripeCustomerId !== customerId) {
        return res.status(400).send({
          error:
            "Subscription customer does not match this client's Stripe customer. Import/sync the customer first.",
        });
      }

      if (!client.stripeCustomerId && customerId) {
        await db
          .update(clients)
          .set({ stripeCustomerId: customerId })
          .where(eq(clients.id, client.id));
      }

      if (sub) {
        const updated = await stripe.subscriptions.update(sub.id, {
          metadata: {
            ...sub.metadata,
            clientId: client.id,
          },
        });
        return res.status(200).send(formatStripeSub(updated, client.id, client.name, false));
      }

      if (!schedule) {
        return res.status(404).send({ error: "Subscription not found." });
      }

      const updated = await stripe.subscriptionSchedules.update(schedule.id, {
        metadata: {
          ...schedule.metadata,
          clientId: client.id,
        },
      });

      return res.status(200).send(formatStripeSchedule(updated, client.id, client.name, false));
    }
  );

  // ==================== ADMIN DASHBOARD ENDPOINTS ====================

  // GET /subscriptions/dashboard/summary — Quick stats
  app.get<{ Querystring: DashboardQuery }>(
    "/subscriptions/dashboard/summary",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { workspace } = req.query;

      const validWorkspace = validateWorkspaceQuery(workspace, res);
      if (!validWorkspace) return;

      const { subscriptions: allSubscriptions, schedules: allSchedules } =
        await getDashboardStripeData(validWorkspace);

      const { subscriptionMap, scheduleMap, backfills } = await resolveSubscriptionClients({
        subscriptions: allSubscriptions,
        schedules: allSchedules,
        workspace: validWorkspace,
      });

      const filteredSubs = allSubscriptions.filter((s) => subscriptionMap.has(s.id));
      const filteredSchedules = allSchedules.filter((s) => scheduleMap.has(s.id));

      backfillClientMetadata(backfills);

      const activeSubs = filteredSubs.filter(
        (s) => s.status === "active" && !s.pause_collection
      ).length;
      const pausedSubs = filteredSubs.filter((s) => s.pause_collection).length;
      const cancelledSubs = filteredSubs.filter((s) => s.status === "canceled").length;
      const pastDueSubs = filteredSubs.filter((s) => s.status === "past_due").length;

      const activeSchedules = filteredSchedules.filter((s) => s.status === "active").length;
      const completedSchedules = filteredSchedules.filter((s) => s.status === "completed").length;
      const cancelledSchedules = filteredSchedules.filter((s) => s.status === "canceled").length;

      const totalRecurringMRR = filteredSubs
        .filter((s) => s.status === "active" && !s.pause_collection)
        .reduce((sum, s) => sum + (s.items.data[0]?.price?.unit_amount ?? 0), 0);

      return res.status(200).send({
        recurring: {
          active: activeSubs,
          paused: pausedSubs,
          cancelled: cancelledSubs,
          pastDue: pastDueSubs,
          totalMrrCents: totalRecurringMRR,
        },
        paymentPlans: {
          active: activeSchedules,
          completed: completedSchedules,
          cancelled: cancelledSchedules,
        },
        total: {
          active: activeSubs + activeSchedules,
          paused: pausedSubs,
          cancelled: cancelledSubs + cancelledSchedules,
          completed: completedSchedules,
        },
      });
    }
  );

  // GET /subscriptions/dashboard/active — All clients with active subs
  app.get<{ Querystring: DashboardQuery }>(
    "/subscriptions/dashboard/active",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { workspace } = req.query;

      const validWorkspace = validateWorkspaceQuery(workspace, res);
      if (!validWorkspace) return;

      const { subscriptions: allSubscriptions, schedules: allSchedules } =
        await getDashboardStripeData(validWorkspace);

      // Get active subscriptions (not paused)
      const activeSubs = allSubscriptions.filter(
        (s) => s.status === "active" && !s.pause_collection
      );
      const activeSchedules = allSchedules.filter((s) => s.status === "active");

      const { subscriptionMap, scheduleMap, backfills } = await resolveSubscriptionClients({
        subscriptions: activeSubs,
        schedules: activeSchedules,
        workspace: validWorkspace,
      });

      const result = [];

      for (const sub of activeSubs) {
        const resolved = subscriptionMap.get(sub.id);
        if (!resolved) continue;

        result.push({
          clientId: resolved.clientId,
          clientName: resolved.clientName,
          clientEmail: resolved.clientEmail,
          subscriptionId: sub.id,
          type: "recurring",
          amountPerPaymentCents: sub.items.data[0]?.price?.unit_amount ?? 0,
          interval: sub.metadata?.interval ?? "month",
          nextPaymentDate: (sub as StripeSubscriptionWithPeriod).current_period_end
            ? new Date(
                (sub as StripeSubscriptionWithPeriod).current_period_end * 1000
              ).toISOString()
            : null,
          status: "active",
        });
      }

      for (const sch of activeSchedules) {
        const resolved = scheduleMap.get(sch.id);
        if (!resolved) continue;

        const phase = sch.phases?.[0];
        result.push({
          clientId: resolved.clientId,
          clientName: resolved.clientName,
          clientEmail: resolved.clientEmail,
          subscriptionId: sch.id,
          type: "payment_plan",
          amountPerPaymentCents: sch.metadata?.amountPerPaymentCents
            ? Number(sch.metadata.amountPerPaymentCents)
            : ((phase?.items?.[0]?.plan as { amount?: number })?.amount ?? 0),
          interval: sch.metadata?.interval ?? "month",
          startDate: sch.metadata?.startDate,
          endDate: sch.metadata?.endDate,
          totalPayments: sch.metadata?.totalPayments ? Number(sch.metadata.totalPayments) : null,
          paymentsMade: sch.metadata?.paymentsMade ? Number(sch.metadata.paymentsMade) : 0,
          status: "active",
        });
      }

      backfillClientMetadata(backfills);

      return res.status(200).send(result);
    }
  );

  // GET /subscriptions/dashboard/overdue — Past due subscriptions
  app.get<{ Querystring: DashboardQuery }>(
    "/subscriptions/dashboard/overdue",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { workspace } = req.query;

      const validWorkspace = validateWorkspaceQuery(workspace, res);
      if (!validWorkspace) return;

      const { subscriptions: allSubscriptions } = await getDashboardStripeData(validWorkspace);
      const pastDueSubs = allSubscriptions.filter((s) => s.status === "past_due");

      const { subscriptionMap, backfills } = await resolveSubscriptionClients({
        subscriptions: pastDueSubs,
        schedules: [],
        workspace: validWorkspace,
      });

      const result = [];

      for (const sub of pastDueSubs) {
        const resolved = subscriptionMap.get(sub.id);
        if (!resolved) continue;

        result.push({
          clientId: resolved.clientId,
          clientName: resolved.clientName,
          clientEmail: resolved.clientEmail,
          subscriptionId: sub.id,
          type: sub.metadata?.type ?? "recurring",
          amountPerPaymentCents: sub.items.data[0]?.price?.unit_amount ?? 0,
          interval: sub.metadata?.interval ?? "month",
          pastDueSince: (sub as StripeSubscriptionWithPeriod).current_period_end
            ? new Date(
                (sub as StripeSubscriptionWithPeriod).current_period_end * 1000
              ).toISOString()
            : null,
          status: "past_due",
        });
      }

      backfillClientMetadata(backfills);

      return res.status(200).send(result);
    }
  );

  // GET /subscriptions/dashboard/ending-soon?days=30 — Payment plans ending soon
  app.get<{ Querystring: DashboardQuery }>(
    "/subscriptions/dashboard/ending-soon",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { workspace, days = "30" } = req.query;
      const daysNum = parseInt(days, 10) || 30;

      const validWorkspace = validateWorkspaceQuery(workspace, res);
      if (!validWorkspace) return;

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() + daysNum);
      const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);

      const { schedules: allSchedules } = await getDashboardStripeData(validWorkspace);
      const activeSchedules = allSchedules.filter((s) => s.status === "active");

      // Filter schedules ending before cutoff
      const endingSoon = activeSchedules.filter((sch) => {
        const phase = sch.phases?.[0];
        return phase?.end_date && phase.end_date <= cutoffTimestamp;
      });

      const { scheduleMap, backfills } = await resolveSubscriptionClients({
        subscriptions: [],
        schedules: endingSoon,
        workspace: validWorkspace,
      });

      const result = [];

      for (const sch of endingSoon) {
        const resolved = scheduleMap.get(sch.id);
        if (!resolved) continue;
        const phase = sch.phases?.[0];

        result.push({
          clientId: resolved.clientId,
          clientName: resolved.clientName,
          clientEmail: resolved.clientEmail,
          subscriptionId: sch.id,
          type: "payment_plan",
          amountPerPaymentCents: sch.metadata?.amountPerPaymentCents
            ? Number(sch.metadata.amountPerPaymentCents)
            : ((phase?.items?.[0]?.plan as { amount?: number })?.amount ?? 0),
          interval: sch.metadata?.interval ?? "month",
          endDate: phase?.end_date
            ? new Date(phase.end_date * 1000).toISOString().split("T")[0]
            : null,
          totalPayments: sch.metadata?.totalPayments ? Number(sch.metadata.totalPayments) : null,
          paymentsMade: sch.metadata?.paymentsMade ? Number(sch.metadata.paymentsMade) : 0,
          status: "active",
        });
      }

      backfillClientMetadata(backfills);

      return res.status(200).send(result);
    }
  );

  // GET /subscriptions/dashboard/recently-cancelled?days=30 — Recently cancelled
  app.get<{ Querystring: DashboardQuery }>(
    "/subscriptions/dashboard/recently-cancelled",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { workspace, days = "30" } = req.query;
      const daysNum = parseInt(days, 10) || 30;

      const validWorkspace = validateWorkspaceQuery(workspace, res);
      if (!validWorkspace) return;

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysNum);
      const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);

      const { subscriptions: allSubscriptions, schedules: allSchedules } =
        await getDashboardStripeData(validWorkspace);
      const canceledSubs = allSubscriptions.filter((s) => s.status === "canceled");
      const canceledSchedules = allSchedules.filter((s) => s.status === "canceled");

      // Filter by cancellation time
      const recentlyCancelledSubs = canceledSubs.filter(
        (s) =>
          s.canceled_at !== null && s.canceled_at !== undefined && s.canceled_at >= cutoffTimestamp
      );
      const recentlyCancelledSchedules = canceledSchedules.filter(
        (s) =>
          s.canceled_at !== null && s.canceled_at !== undefined && s.canceled_at >= cutoffTimestamp
      );

      const { subscriptionMap, scheduleMap, backfills } = await resolveSubscriptionClients({
        subscriptions: recentlyCancelledSubs,
        schedules: recentlyCancelledSchedules,
        workspace: validWorkspace,
      });

      const result = [];

      for (const sub of recentlyCancelledSubs) {
        const resolved = subscriptionMap.get(sub.id);
        if (!resolved) continue;

        result.push({
          clientId: resolved.clientId,
          clientName: resolved.clientName,
          clientEmail: resolved.clientEmail,
          subscriptionId: sub.id,
          type: sub.metadata?.type ?? "recurring",
          amountPerPaymentCents: sub.items.data[0]?.price?.unit_amount ?? 0,
          interval: sub.metadata?.interval ?? "month",
          cancelledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
          status: "cancelled",
        });
      }

      for (const sch of recentlyCancelledSchedules) {
        const resolved = scheduleMap.get(sch.id);
        if (!resolved) continue;

        result.push({
          clientId: resolved.clientId,
          clientName: resolved.clientName,
          clientEmail: resolved.clientEmail,
          subscriptionId: sch.id,
          type: "payment_plan",
          amountPerPaymentCents: sch.metadata?.amountPerPaymentCents
            ? Number(sch.metadata.amountPerPaymentCents)
            : 0,
          interval: sch.metadata?.interval ?? "month",
          cancelledAt: sch.canceled_at ? new Date(sch.canceled_at * 1000).toISOString() : null,
          status: "cancelled",
        });
      }

      backfillClientMetadata(backfills);

      return res.status(200).send(result);
    }
  );

  // GET /clients/:clientId/subscriptions — Full subscription details for one client
  app.get<{ Params: { clientId: string }; Querystring: DashboardQuery }>(
    "/clients/:clientId/subscriptions",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { clientId } = req.params;
      const { workspace } = req.query;

      const validWorkspace = validateWorkspaceQuery(workspace, res);
      if (!validWorkspace) return;

      const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);

      if (!client) {
        return res.status(404).send({ error: "Client not found." });
      }

      if (client.workspace !== workspace) {
        return res.status(400).send({ error: "Client does not belong to the selected workspace." });
      }

      if (!client.stripeCustomerId) {
        return res.status(200).send({
          client: {
            id: client.id,
            name: client.name,
            email: client.email,
          },
          subscriptions: [],
          invoices: [],
        });
      }

      // Fetch subscriptions and schedules for this client
      const [subList, scheduleList, invoiceList] = await Promise.all([
        listAllSubscriptions({
          customer: client.stripeCustomerId,
          expand: ["data.latest_invoice"],
        }),
        listAllSchedules({}),
        stripe.invoices.list({
          customer: client.stripeCustomerId,
          limit: STRIPE_LIST_LIMIT,
        }),
      ]);

      const { scheduleMap, backfills } = await resolveSubscriptionClients({
        subscriptions: [],
        schedules: scheduleList,
        workspace: validWorkspace,
      });

      const clientSchedules = scheduleList.filter((s) => {
        const resolved = scheduleMap.get(s.id);
        if (resolved?.clientId === clientId) return true;
        const scheduleCustomerId = getStripeCustomerId(s.customer);
        return !!client.stripeCustomerId && scheduleCustomerId === client.stripeCustomerId;
      });

      backfillClientMetadata(
        backfills.filter((entry) => clientSchedules.some((s) => s.id === entry.id))
      );

      // Format subscriptions
      const formattedSubs = subList.map((sub) => formatStripeSub(sub, clientId, client.name));

      // Format schedules
      const formattedSchedules = clientSchedules.map((sch) =>
        formatStripeSchedule(sch, clientId, client.name)
      );

      return res.status(200).send({
        client: {
          id: client.id,
          name: client.name,
          email: client.email,
          stripeCustomerId: client.stripeCustomerId,
        },
        subscriptions: [...formattedSchedules, ...formattedSubs],
        invoices: invoiceList.data.map((inv) => formatStripeInvoice(inv, clientId)),
      });
    }
  );
};

export default subscriptionRoutes;
