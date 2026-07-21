import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PaymentSuccess from "../pages/PaymentSuccess";

vi.mock("../api/payments", () => ({
  getPaymentSession: vi.fn(),
}));

import { getPaymentSession } from "../api/payments";

function setWindowSearch(search) {
  Object.defineProperty(window, "location", {
    value: { ...window.location, search },
    writable: true,
  });
}

function buildSession(overrides = {}) {
  return {
    status: "completed",
    baseAmountCents: 10000,
    totalAmountCents: 10200,
    feeAmountCents: 200,
    currency: "usd",
    createdAt: new Date("2026-07-20T12:00:00Z").toISOString(),
    ...overrides,
  };
}

describe("PaymentSuccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setWindowSearch("?session_id=cs_test_session_123");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows missing-session state when session_id is absent and never claims success", () => {
    setWindowSearch("");
    render(<PaymentSuccess />);

    expect(screen.getByRole("heading", { name: /payment session missing/i })).toBeInTheDocument();
    expect(screen.queryByText(/payment successful/i)).not.toBeInTheDocument();
  });

  it("shows verified paid state for completed status with currency formatting", async () => {
    getPaymentSession.mockResolvedValue(buildSession({ status: "completed" }));
    render(<PaymentSuccess />);

    expect(screen.getByRole("heading", { name: /verifying payment/i })).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /payment successful/i })).toBeInTheDocument();
    });

    expect(screen.getByText(/\$100\.00/)).toBeInTheDocument();
    expect(screen.getByText(/\$2\.00/)).toBeInTheDocument();
    expect(screen.getByText(/\$102\.00/)).toBeInTheDocument();
    expect(screen.getByText(/jul 20, 2026/i)).toBeInTheDocument();
  });

  it("treats succeeded as a paid status", async () => {
    getPaymentSession.mockResolvedValue(buildSession({ status: "succeeded" }));
    render(<PaymentSuccess />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /payment successful/i })).toBeInTheDocument();
    });
  });

  it("shows pending state after polling attempts are exhausted", async () => {
    vi.useFakeTimers();
    getPaymentSession.mockResolvedValue(buildSession({ status: "created" }));
    render(<PaymentSuccess />);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(screen.getByRole("heading", { name: /payment pending/i })).toBeInTheDocument();
  });

  it("shows failed state for canceled status", async () => {
    getPaymentSession.mockResolvedValue(buildSession({ status: "canceled" }));
    render(<PaymentSuccess />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /payment not completed/i })).toBeInTheDocument();
    });
  });

  it("shows refunded state with refunded amount", async () => {
    getPaymentSession.mockResolvedValue(
      buildSession({
        status: "partially_refunded",
        refundedAmountCents: 5000,
      })
    );
    render(<PaymentSuccess />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /payment refunded/i })).toBeInTheDocument();
    });

    expect(screen.getByText(/\$102\.00/)).toBeInTheDocument();
    expect(screen.getByText(/\$50\.00/)).toBeInTheDocument();
  });

  it("shows unavailable state when the backend request fails", async () => {
    getPaymentSession.mockRejectedValue(new Error("HTTP 500"));
    render(<PaymentSuccess />);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /payment status unavailable/i })
      ).toBeInTheDocument();
    });

    expect(screen.queryByText(/payment successful/i)).not.toBeInTheDocument();
  });

  it("shows unavailable state for a 404 unknown session", async () => {
    const error = new Error("HTTP 404");
    error.status = 404;
    getPaymentSession.mockRejectedValue(error);
    render(<PaymentSuccess />);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /payment status unavailable/i })
      ).toBeInTheDocument();
    });
  });
});
