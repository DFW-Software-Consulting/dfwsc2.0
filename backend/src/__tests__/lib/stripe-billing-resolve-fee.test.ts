import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureStripeCustomer, getSettings, resolveClientFee } from "../../lib/stripe-billing";

// Mock the db module
vi.mock("../../db/client", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue([]),
    }),
  },
}));

import { db } from "../../db/client";
import { stripe } from "../../lib/stripe";

// Mock stripe
vi.mock("../../lib/stripe", () => ({
  stripe: {
    customers: {
      create: vi.fn(),
    },
  },
}));

describe("resolveClientFee", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DEFAULT_PROCESS_FEE_CENTS;
  });

  it("uses client processingFeePercent when available", async () => {
    const client = {
      id: "client_1",
      processingFeePercent: "3.5",
      processingFeeCents: null,
    } as any;

    const result = await resolveClientFee(client, null, 1000);
    expect(result).toBe(35);
  });

  it("uses client processingFeeCents when available", async () => {
    const client = {
      id: "client_1",
      processingFeePercent: null,
      processingFeeCents: 150,
    } as any;

    const result = await resolveClientFee(client, null);
    expect(result).toBe(150);
  });

  it("uses group processingFeePercent when client has no fee", async () => {
    const client = {
      id: "client_1",
      processingFeePercent: null,
      processingFeeCents: null,
    } as any;

    const group = {
      id: "group_1",
      processingFeePercent: "2.5",
      processingFeeCents: null,
    } as any;

    const result = await resolveClientFee(client, group, 1000);
    expect(result).toBe(25);
  });

  it("uses group processingFeeCents when client has no fee", async () => {
    const client = {
      id: "client_1",
      processingFeePercent: null,
      processingFeeCents: null,
    } as any;

    const group = {
      id: "group_1",
      processingFeePercent: null,
      processingFeeCents: 100,
    } as any;

    const result = await resolveClientFee(client, group);
    expect(result).toBe(100);
  });

  it("throws error when client percent fee requires amount but none provided", async () => {
    const client = {
      id: "client_1",
      processingFeePercent: "3.5",
      processingFeeCents: null,
    } as any;

    await expect(resolveClientFee(client, null)).rejects.toThrow(
      "amount is required when client uses a percentage-based fee."
    );
  });

  it("throws error when group percent fee requires amount but none provided", async () => {
    const client = {
      id: "client_1",
      processingFeePercent: null,
      processingFeeCents: null,
    } as any;

    const group = {
      id: "group_1",
      processingFeePercent: "2.5",
      processingFeeCents: null,
    } as any;

    await expect(resolveClientFee(client, group)).rejects.toThrow(
      "amount is required when group uses a percentage-based fee."
    );
  });

  it("throws error for invalid client processingFeePercent", async () => {
    const client = {
      id: "client_1",
      processingFeePercent: "invalid",
      processingFeeCents: null,
    } as any;

    await expect(resolveClientFee(client, null, 1000)).rejects.toThrow(
      "Invalid client processingFeePercent: must be a valid number."
    );
  });

  it("throws error for client processingFeePercent > 100", async () => {
    const client = {
      id: "client_1",
      processingFeePercent: "150",
      processingFeeCents: null,
    } as any;

    await expect(resolveClientFee(client, null, 1000)).rejects.toThrow(
      "client processingFeePercent must be between 0 and 100."
    );
  });

  it("throws error for client processingFeePercent < 0", async () => {
    const client = {
      id: "client_1",
      processingFeePercent: "-5",
      processingFeeCents: null,
    } as any;

    await expect(resolveClientFee(client, null, 1000)).rejects.toThrow(
      "client processingFeePercent must be between 0 and 100."
    );
  });
});

describe("getSettings", () => {
  it("returns empty object when no settings exist", async () => {
    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockResolvedValue([]),
    });
    (db.select as any) = mockSelect;

    const result = await getSettings();
    expect(result).toEqual({});
  });

  it("returns settings as key-value object", async () => {
    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockResolvedValue([
        { key: "default_fee_cents", value: "200" },
        { key: "default_fee_percent", value: "3.5" },
      ]),
    });
    (db.select as any) = mockSelect;

    const result = await getSettings();
    expect(result).toEqual({
      default_fee_cents: "200",
      default_fee_percent: "3.5",
    });
  });
});

describe("ensureStripeCustomer", () => {
  it("returns existing stripeCustomerId when available", async () => {
    const client = {
      id: "client_1",
      email: "test@example.com",
      name: "Test Client",
      stripeCustomerId: "cus_existing",
    } as any;

    const result = await ensureStripeCustomer(client);
    expect(result).toBe("cus_existing");
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  it("creates new customer when stripeCustomerId is null", async () => {
    const client = {
      id: "client_1",
      email: "test@example.com",
      name: "Test Client",
      stripeCustomerId: null,
    } as any;

    (stripe.customers.create as any).mockResolvedValue({ id: "cus_new" });

    const result = await ensureStripeCustomer(client);
    expect(result).toBe("cus_new");
    expect(stripe.customers.create).toHaveBeenCalledWith(
      {
        email: "test@example.com",
        name: "Test Client",
        metadata: { clientId: "client_1" },
      },
      { idempotencyKey: "customer-client_1" }
    );
  });
});
