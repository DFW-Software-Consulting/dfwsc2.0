import { useState } from "react";
import BaseModal from "./shared/BaseModal";
import Button from "./shared/Button";
import FormInput from "./shared/FormInput";

const METHODS = [
  { value: "paypal", label: "PayPal" },
  { value: "cash", label: "Cash" },
  { value: "check", label: "Check" },
  { value: "other", label: "Other" },
];

function todayIso() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export default function MarkInvoicePaidModal({ isOpen, invoice, onConfirm, onClose, isLoading }) {
  const [method, setMethod] = useState("check");
  const [reference, setReference] = useState("");
  const [paidAt, setPaidAt] = useState(todayIso());

  const reset = () => {
    setMethod("check");
    setReference("");
    setPaidAt(todayIso());
  };

  const handleConfirm = () => {
    onConfirm({
      method,
      reference: reference.trim() || undefined,
      paidAt: paidAt ? new Date(paidAt).toISOString() : undefined,
    });
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={handleClose}
      title="Mark invoice paid (outside Stripe)"
      titleId="mark-paid-modal-title"
      size="sm"
    >
      <p className="text-gray-300 mb-4 text-sm">
        Records the payment in Stripe as <em>paid out of band</em> and updates the ledger. Use this
        when a client paid by PayPal, cash, or check.
      </p>

      {invoice?.description && (
        <p className="text-gray-400 mb-4 text-xs">
          {invoice.description} — ${(invoice.amountCents / 100).toFixed(2)}
        </p>
      )}

      <div className="mb-4">
        <label htmlFor="oob-method" className="block text-sm font-medium text-gray-300 mb-1">
          Method
        </label>
        <select
          id="oob-method"
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          {METHODS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <FormInput
        id="oob-reference"
        label="Reference (optional)"
        value={reference}
        onChange={(e) => setReference(e.target.value)}
        placeholder={method === "check" ? "Check #1234" : "Transaction id / note"}
        wrapperClassName="mb-4"
      />

      <FormInput
        id="oob-paid-at"
        type="date"
        label="Paid date"
        value={paidAt}
        onChange={(e) => setPaidAt(e.target.value)}
      />

      <div className="flex justify-end gap-3 mt-6">
        <Button variant="secondary" onClick={handleClose} disabled={isLoading}>
          Cancel
        </Button>
        <Button variant="success" onClick={handleConfirm} isLoading={isLoading}>
          Mark Paid
        </Button>
      </div>
    </BaseModal>
  );
}
