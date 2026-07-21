import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from "../../api/client";
import { getPaymentSession } from "../../api/payments";

describe("getPaymentSession", () => {
  it("GETs the public session endpoint with the encoded session id", async () => {
    apiFetch.mockResolvedValue({
      status: "completed",
      baseAmountCents: 10000,
      totalAmountCents: 10200,
      feeAmountCents: 200,
      currency: "usd",
      createdAt: new Date().toISOString(),
    });

    await getPaymentSession("cs_test_session_123");

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith("/payments/session/cs_test_session_123");
  });

  it("encodes special characters in the session id", async () => {
    apiFetch.mockResolvedValue({ status: "completed", currency: "usd" });

    await getPaymentSession("cs_test_session+with spaces");

    expect(apiFetch).toHaveBeenCalledWith("/payments/session/cs_test_session%2Bwith%20spaces");
  });
});
