import { describe, expect, it } from "vitest";
import {
  assertLineItemCount,
  assertValidFee,
  buildCheckoutLineItems,
  buildCheckoutSessionParams,
  buildStripeIdempotencyKey,
  type CheckoutLineItemInput,
  computeBaseAmount,
  computeTotalAmount,
  resolveCheckoutCurrency,
} from "../../lib/checkout-session";

const item = (over: Partial<CheckoutLineItemInput["price_data"]> = {}, quantity = 1) =>
  ({
    price_data: {
      currency: "usd",
      product_data: { name: "Widget" },
      unit_amount: 500,
      ...over,
    },
    quantity,
  }) as CheckoutLineItemInput;

describe("buildStripeIdempotencyKey", () => {
  it("namespaces the key by client", () => {
    expect(buildStripeIdempotencyKey("c1", "k1")).toBe("c1:k1");
  });

  it("rejects a namespaced key over 255 characters with the remaining budget", () => {
    expect(() => buildStripeIdempotencyKey("c1", "x".repeat(253))).toThrow(
      "Idempotency-Key must not exceed 252 characters."
    );
    expect(buildStripeIdempotencyKey("c1", "x".repeat(252))).toHaveLength(255);
  });
});

describe("assertLineItemCount", () => {
  it("requires 1 to 100 items", () => {
    expect(() => assertLineItemCount(undefined)).toThrow("lineItems are required.");
    expect(() => assertLineItemCount([])).toThrow("lineItems are required.");
    expect(() => assertLineItemCount(Array.from({ length: 101 }, () => item()))).toThrow(
      "lineItems must not exceed 100 items."
    );
    expect(() => assertLineItemCount(Array.from({ length: 100 }, () => item()))).not.toThrow();
  });
});

describe("computeBaseAmount", () => {
  it("sums unit_amount * quantity and reports the currency", () => {
    expect(computeBaseAmount([item({}, 2), item({ unit_amount: 250 }, 3)])).toEqual({
      baseAmount: 1750,
      lineItemCurrency: "usd",
    });
  });

  it("rejects mixed currencies", () => {
    expect(() => computeBaseAmount([item(), item({ currency: "eur" })])).toThrow(
      "All line items must use the same currency."
    );
  });

  it("rejects totals beyond safe bounds", () => {
    expect(() => computeBaseAmount([item({ unit_amount: Number.MAX_SAFE_INTEGER }, 2)])).toThrow(
      "Line item total exceeds safe integer bounds."
    );
  });

  it("rejects a non-positive total", () => {
    expect(() => computeBaseAmount([item({ unit_amount: 0 })])).toThrow(
      "Computed base amount must be positive."
    );
  });

  it("rejects a sum that is not a safe integer", () => {
    // Each line is within the per-line bound; together they pass 2^53.
    const lines = Array.from({ length: 100 }, () => item({ unit_amount: 99_999_999 }, 999_999));
    expect(() => computeBaseAmount(lines)).toThrow(
      "Computed base amount exceeds safe integer bounds."
    );
  });
});

describe("resolveCheckoutCurrency", () => {
  it("prefers the line item currency, then the body currency", () => {
    expect(resolveCheckoutCurrency("eur", "usd")).toBe("eur");
    expect(resolveCheckoutCurrency(undefined, "usd")).toBe("usd");
  });

  it("rejects missing or malformed currencies", () => {
    expect(() => resolveCheckoutCurrency(undefined, undefined)).toThrow(
      "currency must be a 3-letter ISO code (e.g. 'usd')."
    );
    expect(() => resolveCheckoutCurrency(undefined, "usdd")).toThrow("3-letter ISO code");
  });
});

describe("assertValidFee / computeTotalAmount", () => {
  it("rejects negative and non-integer fees", () => {
    expect(() => assertValidFee(-1)).toThrow("Computed fee is invalid.");
    expect(() => assertValidFee(1.5)).toThrow("Computed fee is invalid.");
    expect(() => assertValidFee(Number.NaN)).toThrow("Computed fee is invalid.");
    expect(() => assertValidFee(0)).not.toThrow();
  });

  it("adds the fee unless waived", () => {
    expect(computeTotalAmount(1000, 100, false)).toBe(1100);
    expect(computeTotalAmount(1000, 100, true)).toBe(1000);
  });
});

describe("buildCheckoutLineItems", () => {
  const fee = (over = {}) => ({ amount: 100, waived: false, currency: "usd", ...over });

  it("appends a Processing Fee line when a fee applies", () => {
    const out = buildCheckoutLineItems([item({}, 2)], fee());
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      price_data: { currency: "usd", product_data: { name: "Widget" }, unit_amount: 500 },
      quantity: 2,
    });
    expect(out[1]).toEqual({
      price_data: {
        currency: "usd",
        product_data: { name: "Processing Fee" },
        unit_amount: 100,
      },
      quantity: 1,
    });
  });

  it("omits the fee line when waived or zero", () => {
    expect(buildCheckoutLineItems([item()], fee({ waived: true }))).toHaveLength(1);
    expect(buildCheckoutLineItems([item()], fee({ amount: 0 }))).toHaveLength(1);
  });

  it("includes the product description only when present", () => {
    const withDesc = item({ product_data: { name: "W", description: "d" } });
    expect(
      buildCheckoutLineItems([withDesc], fee({ amount: 0 }))[0].price_data?.product_data
    ).toEqual({ name: "W", description: "d" });
  });
});

describe("buildCheckoutSessionParams", () => {
  const base = {
    checkoutLineItems: [],
    successUrl: undefined,
    cancelUrl: undefined,
    frontendOrigin: "https://app.example",
    description: "d",
    userMetadata: { a: "b" },
    clientId: "c1",
    baseAmount: 1000,
    feeAmount: 100,
    waived: false,
  };

  it("sets the application fee and fee metadata when not waived", () => {
    const p = buildCheckoutSessionParams(base);
    expect(p.mode).toBe("payment");
    expect(p.success_url).toBe(
      "https://app.example/payment-success?session_id={CHECKOUT_SESSION_ID}"
    );
    expect(p.cancel_url).toBe("https://app.example/payment-cancel");
    expect(p.payment_intent_data).toEqual({
      description: "d",
      metadata: {
        a: "b",
        clientId: "c1",
        baseAmount: "1000",
        feeAmount: "100",
        waivedFeeAmount: "0",
      },
      application_fee_amount: 100,
    });
    expect(p.metadata).toEqual({ clientId: "c1" });
  });

  it("omits the application fee and records the waived amount when waived", () => {
    const p = buildCheckoutSessionParams({ ...base, waived: true });
    expect(p.payment_intent_data?.application_fee_amount).toBeUndefined();
    expect(p.payment_intent_data?.metadata).toMatchObject({
      feeAmount: "0",
      waivedFeeAmount: "100",
    });
  });

  it("uses configured URLs and appends the session id to the success URL", () => {
    const p = buildCheckoutSessionParams({
      ...base,
      successUrl: "https://ok.example/done",
      cancelUrl: "https://ok.example/no",
      frontendOrigin: undefined,
    });
    expect(p.success_url).toBe("https://ok.example/done?session_id={CHECKOUT_SESSION_ID}");
    expect(p.cancel_url).toBe("https://ok.example/no");
  });
});
