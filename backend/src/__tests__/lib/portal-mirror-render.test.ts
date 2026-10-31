import { describe, expect, it } from "vitest";
import type { clientGroups, clients } from "../../db/schema";
import { columnBody, shareBody } from "../../lib/portal-mirror-nextcloud";
import {
  accountColumns,
  cellMatches,
  contentHash,
  DEFAULT_MIRROR_OPTIONS,
  effectiveFee,
  formatDateTime,
  onboardingState,
  renderAccount,
  toRowData,
} from "../../lib/portal-mirror-render";

const spec = (key: string) => {
  const found = accountColumns(DEFAULT_MIRROR_OPTIONS).find((s) => s.key === key);
  if (!found) throw new Error(key);
  return found;
};
const defaults = { percent: null, cents: 0 };
const baseClient = {
  id: "c1",
  workspace: "client_portal",
  name: "Acme",
  email: "owner@acme.example",
  stripeAccountId: "acct_1",
  status: "active",
  chargesEnabled: true,
  payoutsEnabled: false,
  detailsSubmitted: true,
  groupId: null,
  processingFeePercent: null,
  processingFeeCents: null,
  phone: "555-0100",
  addressLine1: "1 Main St",
  notes: "secret note",
  apiKeyHash: "hash",
  apiKeyLookup: "lookup",
  createdAt: new Date("2026-10-01T12:34:56Z"),
  updatedAt: new Date("2026-10-02T01:02:03Z"),
} as unknown as typeof clients.$inferSelect;
const group = (over: Record<string, unknown>) =>
  ({
    name: "Building A",
    processingFeePercent: null,
    processingFeeCents: null,
    ...over,
  }) as typeof clientGroups.$inferSelect;

describe("portal mirror rendering", () => {
  it("applies the same fee precedence as resolveClientFee", () => {
    const f = (c: object, g: object | null, d = defaults) =>
      effectiveFee({ processingFeePercent: null, processingFeeCents: null, ...c }, g as never, d);
    expect(
      f({ processingFeePercent: "2.50", processingFeeCents: 99 }, group({ processingFeeCents: 5 }))
    ).toEqual({ percent: 2.5, cents: null });
    expect(f({ processingFeeCents: 99 }, group({ processingFeePercent: "3.00" }))).toEqual({
      percent: null,
      cents: 99,
    });
    expect(f({}, group({ processingFeePercent: "3.00", processingFeeCents: 5 }))).toEqual({
      percent: 3,
      cents: null,
    });
    expect(f({}, group({ processingFeeCents: 5 }))).toEqual({ percent: null, cents: 5 });
    expect(f({}, null, { percent: "1.5", cents: 7 })).toEqual({ percent: 1.5, cents: null });
    expect(f({}, null, { percent: " ", cents: 7 })).toEqual({ percent: null, cents: 7 });
  });

  it("derives the onboarding state", () => {
    const s = (o: object) => onboardingState({ ...baseClient, ...o });
    expect(s({ stripeAccountId: null })).toBe("Not started");
    expect(s({ detailsSubmitted: false })).toBe("Details needed");
    expect(s({})).toBe("Under review");
    expect(s({ payoutsEnabled: true })).toBe("Ready");
  });

  it("renders labels, yes/no, dollars, and leaves out PII and secrets", () => {
    const values = renderAccount(
      baseClient,
      group({ processingFeeCents: 250 }),
      defaults,
      DEFAULT_MIRROR_OPTIONS
    );
    expect(values).toMatchObject({
      id: "c1",
      name: "Acme",
      group: "Building A",
      status: "Active",
      stripeAccount: "acct_1",
      onboarding: "Under review",
      charges: "Yes",
      payouts: "No",
      details: "Yes",
      feePercent: null,
      feeAmount: 2.5,
      created: "2026-10-01 12:34",
      updated: "2026-10-02 01:02",
    });
    const text = JSON.stringify(values);
    expect(values.email).toBe("owner@acme.example");
    for (const secret of ["555-0100", "1 Main St", "secret note", "hash", "lookup"]) {
      expect(text).not.toContain(secret);
    }
    const titles = accountColumns(DEFAULT_MIRROR_OPTIONS).map((c) => c.title);
    expect(titles.slice(0, 3)).toEqual(["Client ID", "Name", "Email"]);
  });

  it("can hide the email column", () => {
    const options = { ...DEFAULT_MIRROR_OPTIONS, includeEmail: false };
    expect(accountColumns(options).map((c) => c.title)).not.toContain("Email");
    expect(renderAccount(baseClient, null, defaults, options).email).toBeUndefined();
  });

  it("hashes stably and ignores key order", () => {
    expect(contentHash({ a: 1, b: "x" })).toBe(contentHash({ b: "x", a: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });

  it("maps values to column ids and compares cells tolerantly", () => {
    const specs = accountColumns(DEFAULT_MIRROR_OPTIONS);
    const ids = new Map(specs.map((s, i) => [s.key, i + 1]));
    const data = toRowData(specs, ids, { id: "c1", feeAmount: 2.5 });
    expect(data["1"]).toBe("c1");
    expect(data[String(ids.get("feeAmount"))]).toBe(2.5);
    expect(data[String(ids.get("name"))]).toBe("");
    const num = spec("feeAmount");
    const date = spec("created");
    expect(cellMatches(num, "2.50", 2.5)).toBe(true);
    expect(cellMatches(num, null, null)).toBe(true);
    expect(cellMatches(num, 3, 2.5)).toBe(false);
    expect(cellMatches(date, "2026-10-01 12:34:00", "2026-10-01 12:34")).toBe(true);
    expect(formatDateTime(new Date("2026-01-02T03:04:59Z"))).toBe("2026-01-02 03:04");
  });

  it("builds the verified Tables request shapes, with read-only shares", () => {
    const specs = accountColumns(DEFAULT_MIRROR_OPTIONS);
    expect(columnBody(spec("feeAmount"))).toEqual({
      title: "Fee $",
      type: "number",
      numberPrefix: "$",
      numberDecimals: 2,
      mandatory: false,
    });
    expect(columnBody(spec("created"))).toMatchObject({
      type: "datetime",
      subtype: "",
    });
    expect(columnBody(specs[0])).toMatchObject({ type: "text", subtype: "line" });
    expect(shareBody(7, "managers")).toEqual({
      nodeId: 7,
      nodeType: "table",
      receiver: "managers",
      receiverType: "group",
      permissionRead: true,
      permissionCreate: false,
      permissionUpdate: false,
      permissionDelete: false,
      permissionManage: false,
    });
  });
});
