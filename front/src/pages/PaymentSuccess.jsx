import { useEffect, useMemo, useState } from "react";
import { getPaymentSession } from "../api/payments";

const PAID_STATUSES = new Set(["completed", "succeeded"]);
const FAILED_STATUSES = new Set(["failed", "expired", "canceled"]);
const REFUND_STATUSES = new Set(["refunded", "partially_refunded", "disputed"]);

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 10;

function formatMoney(amountCents, currency) {
  if (!currency || !Number.isFinite(amountCents)) return "";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toLowerCase(),
  }).format(amountCents / 100);
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function StatusIcon({ variant }) {
  const common = "h-10 w-10";
  if (variant === "paid") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className={`${common} text-green-500`}
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
          clipRule="evenodd"
        />
      </svg>
    );
  }
  if (variant === "refund") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className={`${common} text-amber-500`}
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M18 10A8 8 0 11.001 10 8 8 0 0118 10zM9 6a1 1 0 012 0v4a1 1 0 11-2 0V6zm1 9a1.25 1.25 0 100-2.5A1.25 1.25 0 0010 15z"
          clipRule="evenodd"
        />
      </svg>
    );
  }
  if (variant === "failed") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className={`${common} text-red-500`}
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
          clipRule="evenodd"
        />
      </svg>
    );
  }
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className={`${common} text-slate-500`}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M18 10A8 8 0 11.001 10 8 8 0 0118 10zM9 6a1 1 0 012 0v4a1 1 0 11-2 0V6zm1 9a1.25 1.25 0 100-2.5A1.25 1.25 0 0010 15z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function StatusCard({ title, children, variant = "neutral", live = "polite" }) {
  const ringColor =
    {
      paid: "bg-green-500/10 border-green-500/20",
      refund: "bg-amber-500/10 border-amber-500/20",
      failed: "bg-red-500/10 border-red-500/20",
      neutral: "bg-slate-500/10 border-slate-500/20",
    }[variant] || "bg-slate-500/10 border-slate-500/20";

  return (
    <div className="min-h-[90vh] flex items-center justify-center transition-colors duration-300">
      <div
        className="text-center max-w-2xl mx-auto px-6"
        role="status"
        aria-live={live}
        aria-atomic="true"
      >
        <div
          className={`w-16 h-16 mx-auto mb-6 flex items-center justify-center rounded-full ${ringColor}`}
        >
          <StatusIcon variant={variant} />
        </div>
        <h1 className="text-3xl font-bold text-slate-900 dark:text-white mb-4 transition-colors">
          {title}
        </h1>
        {children}
      </div>
    </div>
  );
}

const TITLE_MAP = {
  loading: "Verifying Payment - DFW Software Consulting",
  checking: "Verifying Payment - DFW Software Consulting",
  pending: "Payment Pending - DFW Software Consulting",
  paid: "Payment Successful - DFW Software Consulting",
  refund: "Payment Refunded - DFW Software Consulting",
  failed: "Payment Not Completed - DFW Software Consulting",
  unavailable: "Payment Unavailable - DFW Software Consulting",
  missing: "Payment Session Missing - DFW Software Consulting",
};

export default function PaymentSuccess() {
  const [sessionId] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("session_id") || "";
  });
  const [state, setState] = useState(() => (sessionId ? { type: "loading" } : { type: "missing" }));

  const summary = useMemo(() => {
    if (state.type !== "paid" && state.type !== "refund" && state.type !== "failed") {
      return null;
    }
    const data = state.data;
    return {
      total: formatMoney(data.totalAmountCents, data.currency),
      base: formatMoney(data.baseAmountCents, data.currency),
      fee: formatMoney(data.feeAmountCents, data.currency),
      refunded: data.refundedAmountCents
        ? formatMoney(data.refundedAmountCents, data.currency)
        : "",
      date: formatDate(data.createdAt),
    };
  }, [state]);

  useEffect(() => {
    document.title = TITLE_MAP[state.type] || TITLE_MAP.loading;
  }, [state.type]);

  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;
    let attempts = 0;
    let timer = null;

    async function check() {
      try {
        const data = await getPaymentSession(sessionId);
        if (cancelled) return;

        if (PAID_STATUSES.has(data.status)) {
          setState({ type: "paid", data });
          return;
        }

        if (REFUND_STATUSES.has(data.status)) {
          setState({ type: "refund", data });
          return;
        }

        if (FAILED_STATUSES.has(data.status)) {
          setState({ type: "failed", data });
          return;
        }

        attempts += 1;
        if (attempts >= MAX_POLL_ATTEMPTS) {
          setState({ type: "pending", data });
          return;
        }

        setState({ type: "checking", data });
        timer = setTimeout(check, POLL_INTERVAL_MS);
      } catch (error) {
        if (cancelled) return;
        setState({ type: "unavailable", error });
      }
    }

    check();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId]);

  if (state.type === "missing") {
    return (
      <StatusCard title="Payment Session Missing" variant="failed" live="assertive">
        <p className="text-slate-600 dark:text-gray-200 text-lg mb-6 transition-colors">
          We could not find a session to verify. If you just completed a payment, please use the
          link or button from the checkout page.
        </p>
        <p className="text-slate-500 dark:text-gray-400 transition-colors">
          Need help? Contact the DFWSC team and we can look it up for you.
        </p>
      </StatusCard>
    );
  }

  if (state.type === "unavailable") {
    return (
      <StatusCard title="Payment Status Unavailable" variant="neutral" live="assertive">
        <p className="text-slate-600 dark:text-gray-200 text-lg mb-6 transition-colors">
          We could not verify this payment right now. This may be a temporary issue.
        </p>
        <p className="text-slate-500 dark:text-gray-400 transition-colors">
          Please return to the site where you started the payment, or contact the DFWSC team for
          assistance.
        </p>
      </StatusCard>
    );
  }

  if (state.type === "loading" || state.type === "checking") {
    return (
      <StatusCard title="Verifying Payment" variant="neutral">
        <p className="text-slate-600 dark:text-gray-200 text-lg mb-6 transition-colors">
          {state.type === "loading"
            ? "Hang tight while we confirm your payment with our payment provider."
            : "Payment is still being processed. We are checking again..."}
        </p>
        <div className="flex justify-center">
          <div
            className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-500"
            aria-hidden="true"
          />
        </div>
      </StatusCard>
    );
  }

  if (state.type === "pending") {
    return (
      <StatusCard title="Payment Pending" variant="neutral">
        <p className="text-slate-600 dark:text-gray-200 text-lg mb-6 transition-colors">
          Your payment is still being processed by our payment provider. It may take a few minutes
          to complete.
        </p>
        <p className="text-slate-500 dark:text-gray-400 transition-colors">
          You can close this page. Once confirmed, you will receive a receipt by email.
        </p>
      </StatusCard>
    );
  }

  if (state.type === "failed") {
    return (
      <StatusCard title="Payment Not Completed" variant="failed" live="assertive">
        <p className="text-slate-600 dark:text-gray-200 text-lg mb-6 transition-colors">
          This payment was not completed. It may have been canceled, expired, or failed.
        </p>
        {summary?.total && (
          <p className="text-slate-500 dark:text-gray-400 transition-colors mb-6">
            Amount: <span className="font-semibold">{summary.total}</span>
          </p>
        )}
        <p className="text-slate-500 dark:text-gray-400 transition-colors">
          Return to the site where you started the payment to try again, or contact the DFWSC team
          for help.
        </p>
      </StatusCard>
    );
  }

  if (state.type === "refund") {
    return (
      <StatusCard title="Payment Refunded" variant="refund" live="assertive">
        <p className="text-slate-600 dark:text-gray-200 text-lg mb-6 transition-colors">
          This payment has been refunded or is under review.
        </p>
        <div className="text-slate-600 dark:text-gray-200 text-lg mb-6 space-y-2 transition-colors">
          {summary?.total && (
            <p>
              Total amount: <span className="font-semibold">{summary.total}</span>
            </p>
          )}
          {summary?.refunded && (
            <p>
              Refunded: <span className="font-semibold">{summary.refunded}</span>
            </p>
          )}
        </div>
        <p className="text-slate-500 dark:text-gray-400 transition-colors">
          Contact the DFWSC team if you have questions.
        </p>
      </StatusCard>
    );
  }

  return (
    <StatusCard title="Payment Successful" variant="paid">
      <p className="text-slate-600 dark:text-gray-200 text-lg mb-6 transition-colors">
        Thank you. Your payment was completed successfully.
      </p>
      {summary && (
        <dl className="text-left sm:text-center grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6 text-slate-600 dark:text-gray-200 transition-colors">
          <div className="rounded-lg border border-slate-200 dark:border-white/10 p-3 bg-white/50 dark:bg-white/[0.03]">
            <dt className="text-sm text-slate-500 dark:text-gray-400">Amount</dt>
            <dd className="text-lg font-semibold">{summary.base}</dd>
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-white/10 p-3 bg-white/50 dark:bg-white/[0.03]">
            <dt className="text-sm text-slate-500 dark:text-gray-400">Processing fee</dt>
            <dd className="text-lg font-semibold">{summary.fee}</dd>
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-white/10 p-3 bg-white/50 dark:bg-white/[0.03]">
            <dt className="text-sm text-slate-500 dark:text-gray-400">Total paid</dt>
            <dd className="text-lg font-semibold">{summary.total}</dd>
          </div>
        </dl>
      )}
      {summary?.date && (
        <p className="text-sm text-slate-500 dark:text-gray-400 mb-6 transition-colors">
          Paid on {summary.date}
        </p>
      )}
      <p className="text-slate-500 dark:text-gray-400 transition-colors">
        You can close this page or return to the site where you started the payment.
      </p>
    </StatusCard>
  );
}
