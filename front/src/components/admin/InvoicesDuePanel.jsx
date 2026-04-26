import { useMemo, useState } from "react";
import { useCancelInvoice, useInvoices, useMarkInvoicePaidOutOfBand } from "../../hooks/useInvoices";
import MarkInvoicePaidModal from "./MarkInvoicePaidModal";
import StatusBadge from "./shared/StatusBadge";

function formatUsd(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function isPastDue(invoice) {
  if (invoice.status !== "open" || !invoice.dueDate) return false;
  return new Date(invoice.dueDate).getTime() < Date.now();
}

export default function InvoicesDuePanel({ showToast, onSelectClient }) {
  const { data: invoices = [], isLoading, isError, error, refetch } = useInvoices({
    workspace: "dfwsc_services",
  });
  const cancelInvoiceMutation = useCancelInvoice();
  const markPaidMutation = useMarkInvoicePaidOutOfBand();
  const [oobInvoice, setOobInvoice] = useState(null);

  const dueInvoices = useMemo(() => {
    return invoices
      .filter((inv) => inv.status === "open" || isPastDue(inv))
      .sort((a, b) => {
        const aDue = a.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
        const bDue = b.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
        return aDue - bDue;
      });
  }, [invoices]);

  const handleMarkPaid = (body) => {
    if (!oobInvoice) return;
    markPaidMutation.mutate(
      { id: oobInvoice.id, ...body },
      {
        onSuccess: () => {
          showToast?.("Invoice marked paid.", "success");
          setOobInvoice(null);
        },
        onError: (err) => showToast?.(err.message, "error"),
      }
    );
  };

  const handleCancel = (invoiceId) => {
    cancelInvoiceMutation.mutate(invoiceId, {
      onSuccess: () => showToast?.("Invoice canceled.", "success"),
      onError: (err) => showToast?.(err.message, "error"),
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-md font-semibold text-white">Invoices Due</h4>
        <button
          type="button"
          onClick={() => refetch()}
          className="text-sm bg-gray-700 hover:bg-gray-600 text-white py-1 px-3 rounded-md transition-colors"
        >
          Refresh
        </button>
      </div>

      {isLoading && <p className="text-sm text-gray-400">Loading due invoices...</p>}
      {isError && <p className="text-sm text-red-400">{error?.message}</p>}

      {!isLoading && !isError && dueInvoices.length === 0 && (
        <p className="text-sm text-gray-400">No open or past-due invoices.</p>
      )}

      {dueInvoices.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-700">
            <thead>
              <tr>
                {["Client", "Description", "Amount", "Due", "Status", "Actions"].map((h) => (
                  <th
                    key={h}
                    className="px-3 py-2 text-left text-xs font-medium text-gray-300 uppercase tracking-wider"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {dueInvoices.map((invoice) => (
                <tr key={invoice.id} className="hover:bg-gray-700/40">
                  <td className="px-3 py-2 text-sm">
                    <button
                      type="button"
                      onClick={() => onSelectClient?.(invoice.clientId)}
                      className="text-blue-400 hover:text-blue-300"
                    >
                      {invoice.clientName ?? "Unknown"}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-sm text-gray-200 max-w-xs truncate">
                    {invoice.description || "-"}
                  </td>
                  <td className="px-3 py-2 text-sm text-gray-200">{formatUsd(invoice.amountCents)}</td>
                  <td className="px-3 py-2 text-sm text-gray-300">{formatDate(invoice.dueDate)}</td>
                  <td className="px-3 py-2 text-sm">
                    {isPastDue(invoice) ? <StatusBadge status="past_due" /> : <StatusBadge status="open" />}
                  </td>
                  <td className="px-3 py-2 text-sm">
                    <div className="flex gap-2">
                      {invoice.hostedUrl && (
                        <button
                          type="button"
                          onClick={() => window.open(invoice.hostedUrl, "_blank")}
                          className="px-2 py-1 rounded text-xs bg-gray-600 hover:bg-gray-500 text-white"
                        >
                          Open
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setOobInvoice(invoice)}
                        className="px-2 py-1 rounded text-xs bg-green-700 hover:bg-green-600 text-white"
                      >
                        Mark Paid
                      </button>
                      <button
                        type="button"
                        onClick={() => handleCancel(invoice.id)}
                        className="px-2 py-1 rounded text-xs bg-red-700 hover:bg-red-600 text-white"
                      >
                        Cancel
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <MarkInvoicePaidModal
        isOpen={!!oobInvoice}
        invoice={oobInvoice}
        onClose={() => setOobInvoice(null)}
        onConfirm={handleMarkPaid}
        isLoading={markPaidMutation.isPending}
      />
    </div>
  );
}
