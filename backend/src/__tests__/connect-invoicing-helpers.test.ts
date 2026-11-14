import { describe, expect, it } from "vitest";
import { replayMatches } from "../routes/connect-invoicing/customers";
import { invoiceMatchesComputed } from "../routes/connect-invoicing/invoice-create";
import {
  assertNoReservedMetadataKeys,
  isResourceMissing,
  parseIdempotencyKeyHash,
} from "../routes/connect-invoicing/shared";

const requestWith = (header: unknown) => ({ headers: { "idempotency-key": header } }) as never;

describe("parseIdempotencyKeyHash", () => {
  it("hashes the trimmed key with sha256", () => {
    // sha256("abc")
    expect(parseIdempotencyKeyHash(requestWith("  abc  "))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("uses the first value of a repeated header", () => {
    expect(parseIdempotencyKeyHash(requestWith(["abc", "other"]))).toBe(
      parseIdempotencyKeyHash(requestWith("abc"))
    );
  });

  it("rejects a missing or blank key", () => {
    expect(() => parseIdempotencyKeyHash(requestWith(undefined))).toThrow(
      "Idempotency-Key header is required."
    );
    expect(() => parseIdempotencyKeyHash(requestWith("   "))).toThrow(
      "Idempotency-Key header is required."
    );
  });

  it("rejects a key over 255 characters", () => {
    expect(() => parseIdempotencyKeyHash(requestWith("k".repeat(256)))).toThrow(
      "Idempotency-Key must not exceed 255 characters."
    );
    expect(() => parseIdempotencyKeyHash(requestWith("k".repeat(255)))).not.toThrow();
  });
});

describe("assertNoReservedMetadataKeys", () => {
  it("allows ordinary keys and refuses the reserved prefix", () => {
    expect(() => assertNoReservedMetadataKeys({ order: "1" })).not.toThrow();
    expect(() => assertNoReservedMetadataKeys({ dfwsc_client_id: "x" })).toThrow(
      "metadata keys starting with 'dfwsc_' are reserved."
    );
  });
});

describe("isResourceMissing", () => {
  it("is true only for the resource_missing code", () => {
    expect(isResourceMissing({ code: "resource_missing" })).toBe(true);
    expect(isResourceMissing({ code: "other" })).toBe(false);
    expect(isResourceMissing(null)).toBe(false);
  });
});

describe("invoiceMatchesComputed", () => {
  const row = { totalCents: 1250, feeAmountCents: 250 };
  const draft = { total: 1250, subtotal: 1250, currency: "usd", status: "draft" as const };

  it("accepts a draft whose amounts agree", () => {
    expect(invoiceMatchesComputed(draft, 250, row)).toBe(true);
    expect(invoiceMatchesComputed(draft, undefined, row)).toBe(true);
    expect(invoiceMatchesComputed(draft, null, row)).toBe(true);
  });

  it("rejects a differing total, subtotal, currency or status", () => {
    expect(invoiceMatchesComputed({ ...draft, total: 1251 }, 250, row)).toBe(false);
    expect(invoiceMatchesComputed({ ...draft, subtotal: 1000 }, 250, row)).toBe(false);
    expect(invoiceMatchesComputed({ ...draft, currency: "eur" }, 250, row)).toBe(false);
    expect(invoiceMatchesComputed({ ...draft, status: "open" }, 250, row)).toBe(false);
  });

  it("rejects a fee that differs or exceeds the total", () => {
    expect(invoiceMatchesComputed(draft, 100, row)).toBe(false);
    expect(
      invoiceMatchesComputed({ ...draft, total: 200, subtotal: 200 }, 250, {
        totalCents: 200,
        feeAmountCents: 250,
      })
    ).toBe(false);
  });
});

describe("replayMatches", () => {
  const row = { externalRef: "ref-1" } as never;
  const customer = {
    email: "Tenant@Example.com",
    name: "Ten Ant",
    phone: null,
    metadata: { dfwsc_client_id: "c1", order: "7" },
  } as never;
  const same = {
    email: "tenant@example.com",
    name: "Ten Ant",
    externalRef: "ref-1",
    userMetadata: { order: "7" },
  };

  it("matches the same request, ignoring email case, empties and reserved metadata", () => {
    expect(replayMatches(row, customer, same)).toBe(true);
    expect(replayMatches(row, customer, { ...same, phone: "" })).toBe(true);
  });

  it("does not match when any field differs", () => {
    expect(replayMatches(row, customer, { ...same, externalRef: "ref-2" })).toBe(false);
    expect(replayMatches(row, customer, { ...same, email: "other@example.com" })).toBe(false);
    expect(replayMatches(row, customer, { ...same, name: "Someone" })).toBe(false);
    expect(replayMatches(row, customer, { ...same, phone: "555" })).toBe(false);
    expect(replayMatches(row, customer, { ...same, userMetadata: { order: "8" } })).toBe(false);
  });
});
