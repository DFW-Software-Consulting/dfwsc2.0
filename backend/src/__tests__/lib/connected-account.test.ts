import { describe, expect, it } from "vitest";
import { getChargeableAccountId } from "../../lib/connected-account";

describe("getChargeableAccountId", () => {
  it("returns the account id when charges are enabled", () => {
    expect(getChargeableAccountId({ stripeAccountId: "acct_1", chargesEnabled: true })).toBe(
      "acct_1"
    );
  });

  it("returns null without an account id", () => {
    expect(getChargeableAccountId({ stripeAccountId: null, chargesEnabled: true })).toBeNull();
    expect(getChargeableAccountId({ stripeAccountId: "", chargesEnabled: true })).toBeNull();
  });

  it("returns null when charges are not enabled", () => {
    expect(getChargeableAccountId({ stripeAccountId: "acct_1", chargesEnabled: false })).toBeNull();
    expect(getChargeableAccountId({ stripeAccountId: "acct_1", chargesEnabled: null })).toBeNull();
  });
});
