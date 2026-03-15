import { useState } from "react";
import { useParams } from "react-router-dom";
import { usePayInvoice, usePublicInvoice } from "../hooks/usePublicInvoice";

export default function InvoicePayment() {
  const { token } = useParams();

  const { data: invoice, isLoading, error } = usePublicInvoice(token);
  const payMutation = usePayInvoice(token);

  const [paymentRef, setPaymentRef] = useState("");
  const [submitError, setSubmitError] = useState("");

  // Mock card form state
  const [cardNumber, setCardNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvc, setCvc] = useState("");

  function handleSubmit(e) {
    e.preventDefault();
    setSubmitError("");
    payMutation.mutate(undefined, {
      onSuccess: (data) => {
        setPaymentRef(data.payment?.id ?? "");
      },
      onError: (err) => {
        setSubmitError(err.message || "Payment failed. Please try again.");
      },
    });
  }

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-64 py-16">
        <div className="text-gray-400">Loading invoice...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex justify-center items-center min-h-64 py-16">
        <div className="max-w-md w-full mx-4 text-center">
          <div className="bg-red-900/30 border border-red-700 rounded-xl p-8">
            <p className="text-red-300 font-medium">
              {error.message || "This payment link is invalid or expired."}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const dollars = invoice ? `$${(invoice.amountCents / 100).toFixed(2)}` : "";

  if (invoice?.status === "paid") {
    return (
      <div className="flex justify-center items-center min-h-64 py-16">
        <div className="max-w-md w-full mx-4 text-center">
          <div className="bg-green-900/30 border border-green-700 rounded-xl p-8">
            <div className="text-green-400 text-4xl mb-4">✓</div>
            <h2 className="text-xl font-semibold text-white mb-2">Payment Received</h2>
            <p className="text-gray-300 mb-1">
              {dollars} — {invoice.description}
            </p>
            {(paymentRef || invoice.mockPaymentId) && (
              <p className="text-xs text-gray-500 mt-3 font-mono">
                Ref: {paymentRef || invoice.mockPaymentId}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (invoice?.status === "cancelled") {
    return (
      <div className="flex justify-center items-center min-h-64 py-16">
        <div className="max-w-md w-full mx-4 text-center">
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-8">
            <p className="text-gray-400">This invoice has been cancelled.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-center items-start py-16 px-4">
      <div className="max-w-md w-full">
        {/* Invoice details card */}
        <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-6 mb-6">
          <h2 className="text-lg font-semibold text-white mb-4">Invoice</h2>
          {invoice?.clientName && (
            <p className="text-sm text-gray-400 mb-1">For: {invoice.clientName}</p>
          )}
          <p className="text-2xl font-bold text-white mb-1">{dollars}</p>
          <p className="text-gray-300 mb-2">{invoice?.description}</p>
          {invoice?.dueDate && (
            <p className="text-sm text-gray-400">
              Due:{" "}
              {new Date(invoice.dueDate).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </p>
          )}
        </div>

        {/* Mock payment form */}
        <form
          onSubmit={handleSubmit}
          className="bg-gray-800/60 border border-gray-700 rounded-xl p-6"
        >
          <h3 className="text-md font-semibold text-white mb-4">Payment Details</h3>

          <div className="mb-4">
            <label htmlFor="card-number" className="block text-sm text-gray-300 mb-1">
              Card Number
            </label>
            <input
              id="card-number"
              type="text"
              value={cardNumber}
              onChange={(e) => setCardNumber(e.target.value)}
              placeholder="4242 4242 4242 4242"
              maxLength={19}
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex gap-4 mb-4">
            <div className="flex-1">
              <label htmlFor="expiry" className="block text-sm text-gray-300 mb-1">
                Expiry
              </label>
              <input
                id="expiry"
                type="text"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                placeholder="MM/YY"
                maxLength={5}
                className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                           placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="w-28">
              <label htmlFor="cvc" className="block text-sm text-gray-300 mb-1">
                CVC
              </label>
              <input
                id="cvc"
                type="text"
                value={cvc}
                onChange={(e) => setCvc(e.target.value)}
                placeholder="123"
                maxLength={4}
                className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                           placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {submitError && (
            <p className="mb-3 text-sm text-red-400" role="alert">
              {submitError}
            </p>
          )}

          <button
            type="submit"
            disabled={payMutation.isPending}
            className="w-full py-3 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-semibold
                       transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {payMutation.isPending ? "Processing..." : `Pay ${dollars}`}
          </button>

          <p className="mt-3 text-center text-xs text-gray-500">
            This is a mock payment form. No real charges will be made.
          </p>
        </form>
      </div>
    </div>
  );
}
