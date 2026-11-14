import { describe, expect, it } from "vitest";
import { applyFeeConfig, feeTypeOf, feeValueOf } from "../utils/feeConfig";

describe("feeTypeOf / feeValueOf", () => {
  it("reads a percent fee", () => {
    const e = { processingFeePercent: 2.5, processingFeeCents: null };
    expect([feeTypeOf(e), feeValueOf(e)]).toEqual(["percent", "2.5"]);
  });
  it("reads a flat fee", () => {
    const e = { processingFeePercent: null, processingFeeCents: 150 };
    expect([feeTypeOf(e), feeValueOf(e)]).toEqual(["cents", "150"]);
  });
  it("defaults to none", () => {
    expect([feeTypeOf({}), feeValueOf({})]).toEqual(["none", ""]);
  });
});

describe("applyFeeConfig", () => {
  it("clears both fees for none", () => {
    const body = { name: "A" };
    expect(applyFeeConfig(body, "none", "")).toBeNull();
    expect(body).toEqual({ name: "A", processingFeePercent: null, processingFeeCents: null });
  });
  it("sets a percent fee and nulls the flat fee", () => {
    const body = {};
    expect(applyFeeConfig(body, "percent", "2.5")).toBeNull();
    expect(body).toEqual({ processingFeePercent: 2.5, processingFeeCents: null });
  });
  it("sets a flat fee and nulls the percent fee", () => {
    const body = {};
    expect(applyFeeConfig(body, "cents", "99")).toBeNull();
    expect(body).toEqual({ processingFeeCents: 99, processingFeePercent: null });
  });
  it("returns the fee error before any URL error and leaves the body untouched", () => {
    const body = { paymentSuccessUrl: "http://x" };
    expect(applyFeeConfig(body, "percent", "0")).toBe(
      "Fee percent must be greater than 0 and at most 100."
    );
    expect(body).toEqual({ paymentSuccessUrl: "http://x" });
  });
  it("reports invalid success and cancel URLs", () => {
    expect(applyFeeConfig({ paymentSuccessUrl: "http://x" }, "none", "")).toBe(
      "Success URL must be a valid HTTPS URL."
    );
    expect(
      applyFeeConfig({ paymentSuccessUrl: null, paymentCancelUrl: "http://x" }, "none", "")
    ).toBe("Cancel URL must be a valid HTTPS URL.");
  });
  it("accepts https and absent URLs", () => {
    expect(applyFeeConfig({ paymentSuccessUrl: "https://x.test" }, "none", "")).toBeNull();
    expect(applyFeeConfig({}, "none", "")).toBeNull();
  });
});
