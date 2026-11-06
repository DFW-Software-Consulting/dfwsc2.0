import { describe, expect, it } from "vitest";
import { lineItemSchema, validateStripeMetadata } from "../../lib/stripe-input";

const item = (over: Record<string, unknown> = {}) => ({
  price_data: {
    currency: "USD",
    product_data: { name: "Widget" },
    unit_amount: 500,
    ...over,
  },
});

describe("lineItemSchema", () => {
  it("lowercases currency and defaults quantity to 1", () => {
    const r = lineItemSchema.parse(item());
    expect(r.price_data.currency).toBe("usd");
    expect(r.quantity).toBe(1);
  });

  it("rejects bad currency, amounts and empty names", () => {
    expect(lineItemSchema.safeParse(item({ currency: "usdd" })).success).toBe(false);
    expect(lineItemSchema.safeParse(item({ unit_amount: 0 })).success).toBe(false);
    expect(lineItemSchema.safeParse(item({ unit_amount: 100_000_000 })).success).toBe(false);
    expect(lineItemSchema.safeParse(item({ unit_amount: 1.5 })).success).toBe(false);
    expect(lineItemSchema.safeParse(item({ product_data: { name: "" } })).success).toBe(false);
  });
});

describe("validateStripeMetadata", () => {
  it("returns {} for undefined and the input when valid", () => {
    expect(validateStripeMetadata(undefined)).toEqual({});
    expect(validateStripeMetadata({ a: "b" })).toEqual({ a: "b" });
  });

  it("rejects more than 50 keys", () => {
    const m = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, "v"]));
    expect(() => validateStripeMetadata(m)).toThrow("metadata must not exceed 50 keys.");
  });

  it("rejects over-long keys and values", () => {
    expect(() => validateStripeMetadata({ [`${"k".repeat(41)}`]: "v" })).toThrow(
      /exceeds 40 characters/
    );
    expect(() => validateStripeMetadata({ a: "v".repeat(501) })).toThrow(
      "metadata value for 'a' exceeds 500 characters."
    );
  });
});
