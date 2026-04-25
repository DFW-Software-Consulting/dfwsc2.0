const dbWhereMock = vi.fn();

vi.mock("../../db/client", () => ({
  db: {
    select: () => ({ from: () => ({ where: dbWhereMock }) }),
  },
}));

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSubscriptionClients } from "../../lib/subscription-resolution";

const CLIENT_A = {
  id: "client-aaa",
  name: "Client A",
  email: "a@example.com",
  workspace: "client_portal" as const,
  stripeCustomerId: "cus_AAA",
  status: "active" as const,
  apiKeyHash: null,
  apiKeyLookup: null,
  stripeAccountId: null,
  groupId: null,
  paymentSuccessUrl: null,
  paymentCancelUrl: null,
  processingFeePercent: null,
  processingFeeCents: null,
  phone: null,
  billingContactName: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  state: null,
  postalCode: null,
  country: null,
  notes: null,
  defaultPaymentTermsDays: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const CLIENT_B = {
  ...CLIENT_A,
  id: "client-bbb",
  name: "Client B",
  email: "b@example.com",
  stripeCustomerId: "cus_BBB",
};

function makeSub(overrides: { id?: string; metadata?: Record<string, string>; customer?: string }) {
  return {
    id: overrides.id ?? "sub_test",
    metadata: overrides.metadata ?? {},
    customer: overrides.customer ?? "cus_NONE",
  };
}

function makeSchedule(overrides: {
  id?: string;
  metadata?: Record<string, string>;
  customer?: string;
}) {
  return {
    id: overrides.id ?? "sch_test",
    metadata: overrides.metadata ?? {},
    customer: overrides.customer ?? "cus_NONE",
  };
}

describe("resolveSubscriptionClients", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbWhereMock.mockResolvedValue([]);
  });

  it("returns empty maps and no backfills for empty inputs without querying DB", async () => {
    const result = await resolveSubscriptionClients({
      subscriptions: [],
      schedules: [],
      workspace: "client_portal",
    });

    expect(result.subscriptionMap.size).toBe(0);
    expect(result.scheduleMap.size).toBe(0);
    expect(result.backfills).toEqual([]);
    expect(dbWhereMock).not.toHaveBeenCalled();
  });

  it("resolves subscription by metadata clientId", async () => {
    dbWhereMock.mockResolvedValue([CLIENT_A]);

    const sub = makeSub({
      id: "sub_meta",
      metadata: { clientId: "client-aaa" },
      customer: "cus_AAA",
    });
    const result = await resolveSubscriptionClients({
      subscriptions: [sub],
      schedules: [],
      workspace: "client_portal",
    });

    expect(result.subscriptionMap.size).toBe(1);
    const resolved = result.subscriptionMap.get("sub_meta");
    expect(resolved?.clientId).toBe("client-aaa");
    expect(resolved?.clientName).toBe("Client A");
    expect(resolved?.matchedBy).toBe("metadata");
    expect(result.backfills).toEqual([]);
  });

  it("resolves subscription by Stripe customer ID and generates a backfill entry", async () => {
    dbWhereMock.mockResolvedValue([CLIENT_A]);

    const sub = makeSub({ id: "sub_cus", metadata: {}, customer: "cus_AAA" });
    const result = await resolveSubscriptionClients({
      subscriptions: [sub],
      schedules: [],
      workspace: "client_portal",
    });

    expect(result.subscriptionMap.size).toBe(1);
    const resolved = result.subscriptionMap.get("sub_cus");
    expect(resolved?.clientId).toBe("client-aaa");
    expect(resolved?.matchedBy).toBe("stripe_customer");

    expect(result.backfills).toHaveLength(1);
    expect(result.backfills[0]).toMatchObject({
      kind: "subscription",
      id: "sub_cus",
      clientId: "client-aaa",
      existingMetadata: {},
    });
  });

  it("returns no entry for unmatched subscription", async () => {
    dbWhereMock.mockResolvedValue([]);

    const sub = makeSub({ id: "sub_unknown", customer: "cus_UNKNOWN" });
    const result = await resolveSubscriptionClients({
      subscriptions: [sub],
      schedules: [],
      workspace: "client_portal",
    });

    expect(result.subscriptionMap.size).toBe(0);
    expect(result.backfills).toEqual([]);
  });

  it("resolves schedule via metadata and produces no backfill", async () => {
    dbWhereMock.mockResolvedValue([CLIENT_B]);

    const sch = makeSchedule({ id: "sch_meta", metadata: { clientId: "client-bbb" } });
    const result = await resolveSubscriptionClients({
      subscriptions: [],
      schedules: [sch],
      workspace: "client_portal",
    });

    expect(result.scheduleMap.size).toBe(1);
    const resolved = result.scheduleMap.get("sch_meta");
    expect(resolved?.matchedBy).toBe("metadata");
    expect(result.backfills).toEqual([]);
  });

  it("resolves schedule via Stripe customer ID and generates a backfill with kind=schedule", async () => {
    dbWhereMock.mockResolvedValue([CLIENT_B]);

    const sch = makeSchedule({ id: "sch_cus", metadata: {}, customer: "cus_BBB" });
    const result = await resolveSubscriptionClients({
      subscriptions: [],
      schedules: [sch],
      workspace: "client_portal",
    });

    expect(result.scheduleMap.size).toBe(1);
    expect(result.backfills).toHaveLength(1);
    expect(result.backfills[0]).toMatchObject({
      kind: "schedule",
      id: "sch_cus",
      clientId: "client-bbb",
    });
  });

  it("metadata match takes priority over stripe_customer match", async () => {
    // CLIENT_A matched by metadata; CLIENT_B has the same customer but should NOT match
    const clientAWithDifferentCustomer = { ...CLIENT_A, stripeCustomerId: "cus_OTHER" };
    dbWhereMock.mockResolvedValue([clientAWithDifferentCustomer, CLIENT_B]);

    const sub = makeSub({
      id: "sub_pri",
      metadata: { clientId: "client-aaa" },
      customer: "cus_BBB",
    });
    const result = await resolveSubscriptionClients({
      subscriptions: [sub],
      schedules: [],
      workspace: "client_portal",
    });

    const resolved = result.subscriptionMap.get("sub_pri");
    expect(resolved?.clientId).toBe("client-aaa");
    expect(resolved?.matchedBy).toBe("metadata");
    expect(result.backfills).toEqual([]);
  });

  it("issues a single DB query even for multiple subs sharing the same Stripe customer", async () => {
    dbWhereMock.mockResolvedValue([CLIENT_A]);

    const subs = [
      makeSub({ id: "sub_1", customer: "cus_AAA" }),
      makeSub({ id: "sub_2", customer: "cus_AAA" }),
      makeSub({ id: "sub_3", customer: "cus_AAA" }),
    ];
    await resolveSubscriptionClients({
      subscriptions: subs,
      schedules: [],
      workspace: "client_portal",
    });

    expect(dbWhereMock).toHaveBeenCalledTimes(1);
  });
});
