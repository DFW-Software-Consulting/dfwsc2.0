import { useEffect, useMemo, useState } from "react";
import { useClient } from "../../hooks/useClients";
import { useCreateInvoice, useLedgerInvoices } from "../../hooks/useInvoices";
import { useSubscriptions } from "../../hooks/useSubscriptions";
import Button from "./shared/Button";
import StatusBadge from "./shared/StatusBadge";

function formatUsd(cents) {
  if (typeof cents !== "number") return "-";
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

function isInvoicePastDue(invoice) {
  if (!invoice?.dueDate || invoice.status !== "open") return false;
  return new Date(invoice.dueDate).getTime() < Date.now();
}

export default function ClientProfile({
  clientId,
  workspace = "dfwsc_services",
  onBack,
  onCreateInvoice,
  onCreateSubscription,
  showToast,
}) {
  const { data: client, isLoading: clientLoading } = useClient(clientId, workspace);
  const {
    data: invoices = [],
    isLoading: invoicesLoading,
    isFetching: invoicesFetching,
    refetch: pullLedgerInvoices,
  } = useLedgerInvoices({ clientId }, false);
  const createInvoiceMutation = useCreateInvoice();
  const { data: subscriptions = [], isLoading: subscriptionsLoading } = useSubscriptions({
    workspace,
    clientId,
  });

  const [invoiceFilter, setInvoiceFilter] = useState("all");
  const [showQuickInvoiceForm, setShowQuickInvoiceForm] = useState(false);
  const [quickAmount, setQuickAmount] = useState("");
  const [quickDescription, setQuickDescription] = useState("");
  const [quickDueDate, setQuickDueDate] = useState("");
  const [quickFormError, setQuickFormError] = useState("");
  const [pendingInvoices, setPendingInvoices] = useState([]);

  useEffect(() => {
    pullLedgerInvoices();
  }, [pullLedgerInvoices]);

  const activeSubscription = useMemo(() => {
    return subscriptions.find((sub) => sub.status !== "cancelled") ?? subscriptions[0] ?? null;
  }, [subscriptions]);

  const filteredInvoices = useMemo(() => {
    if (invoiceFilter === "all") return invoices;
    if (invoiceFilter === "past_due") return invoices.filter((invoice) => isInvoicePastDue(invoice));
    return invoices.filter((invoice) => invoice.status === invoiceFilter);
  }, [invoiceFilter, invoices]);

  const sortedInvoices = useMemo(() => {
    return [...filteredInvoices].sort((a, b) => {
      const aTime = new Date(a.createdAt || a.dueDate || 0).getTime();
      const bTime = new Date(b.createdAt || b.dueDate || 0).getTime();
      return bTime - aTime;
    });
  }, [filteredInvoices]);

  const handleQuickInvoiceCreate = (e) => {
    e.preventDefault();
    setQuickFormError("");

    const amountCents = Math.round(parseFloat(quickAmount) * 100);
    if (Number.isNaN(amountCents) || amountCents <= 0) {
      setQuickFormError("Enter a valid amount.");
      return;
    }

    if (!quickDescription.trim()) {
      setQuickFormError("Description is required.");
      return;
    }

    const tempId = `pending_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const payload = {
      clientId,
      workspace,
      amountCents,
      description: quickDescription.trim(),
      dueDate: quickDueDate || null,
      waiveFee: false,
      taxRateId: null,
    };

    setPendingInvoices((prev) => [
      {
        id: tempId,
        status: "syncing",
        payload,
        error: null,
      },
      ...prev,
    ]);

    createInvoiceMutation.mutate(payload, {
      onSuccess: async () => {
        setPendingInvoices((prev) => prev.filter((item) => item.id !== tempId));
        setQuickAmount("");
        setQuickDescription("");
        setQuickDueDate("");
        setShowQuickInvoiceForm(false);
        await pullLedgerInvoices();
        showToast?.("Invoice synced to Stripe + Ledger.", "success");
      },
      onError: (err) => {
        setPendingInvoices((prev) =>
          prev.map((item) =>
            item.id === tempId
              ? { ...item, status: "failed", error: err?.message || "Failed to sync invoice" }
              : item
          )
        );
        setQuickFormError(err?.message || "Failed to create invoice.");
      },
    });
  };

  const retryPendingInvoice = (pendingId) => {
    const target = pendingInvoices.find((item) => item.id === pendingId);
    if (!target) return;

    setPendingInvoices((prev) =>
      prev.map((item) =>
        item.id === pendingId ? { ...item, status: "syncing", error: null } : item
      )
    );

    createInvoiceMutation.mutate(target.payload, {
      onSuccess: async () => {
        setPendingInvoices((prev) => prev.filter((item) => item.id !== pendingId));
        await pullLedgerInvoices();
        showToast?.("Retry succeeded and invoice synced.", "success");
      },
      onError: (err) => {
        setPendingInvoices((prev) =>
          prev.map((item) =>
            item.id === pendingId
              ? { ...item, status: "failed", error: err?.message || "Retry failed" }
              : item
          )
        );
      },
    });
  };

  if (clientLoading) {
    return <p className="text-sm text-gray-400">Loading client profile...</p>;
  }

  if (!client) {
    return <p className="text-sm text-red-400">Client not found.</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
        >
          Back
        </button>
      </div>

      <div className="rounded-lg border border-gray-700 bg-gray-800/30 p-4">
        <h4 className="text-lg font-semibold text-white">{client.name}</h4>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <p className="text-sm text-gray-300">Lifecycle: <span className="text-gray-100"><StatusBadge status={client.status} /></span></p>
          <p className="text-sm text-gray-300">Email: <span className="text-gray-100">{client.email || "-"}</span></p>
          <p className="text-sm text-gray-300">Phone: <span className="text-gray-100">{client.phone || "-"}</span></p>
          <p className="text-sm text-gray-300">Address: <span className="text-gray-100">{[client.addressLine1, client.addressLine2, client.city, client.state, client.postalCode, client.country].filter(Boolean).join(", ") || "-"}</span></p>
        </div>
      </div>

      <div className="rounded-lg border border-gray-700 bg-gray-800/30 p-4">
        <h5 className="text-sm font-semibold uppercase tracking-wide text-gray-300">Subscription</h5>
        {subscriptionsLoading ? (
          <p className="text-sm text-gray-400 mt-2">Loading subscription...</p>
        ) : !activeSubscription ? (
          <p className="text-sm text-gray-400 mt-2">No subscription.</p>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <p className="text-sm text-gray-300">Plan: <span className="text-gray-100">{activeSubscription.description || "-"}</span></p>
            <p className="text-sm text-gray-300">Amount: <span className="text-gray-100">{formatUsd(activeSubscription.amountPerPaymentCents)}</span></p>
            <p className="text-sm text-gray-300">Next Billing: <span className="text-gray-100">{formatDate(activeSubscription.nextPaymentDate)}</span></p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            setQuickFormError("");
            setShowQuickInvoiceForm((prev) => !prev);
          }}
        >
          {showQuickInvoiceForm ? "Close Invoice Form" : "Create Invoice"}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onCreateSubscription?.(client)}>
          Create Subscription
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onCreateInvoice?.(client)}>
          Advanced Billing
        </Button>
      </div>

      {showQuickInvoiceForm && (
        <div className="rounded-lg border border-gray-700 bg-gray-800/30 p-4">
          <h5 className="text-sm font-semibold uppercase tracking-wide text-gray-300">Quick Invoice</h5>
          <form onSubmit={handleQuickInvoiceCreate} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="quick-amount" className="block text-sm text-gray-300 mb-1">
                Amount ($)
              </label>
              <input
                id="quick-amount"
                type="number"
                min="0.01"
                step="0.01"
                value={quickAmount}
                onChange={(e) => setQuickAmount(e.target.value)}
                className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={createInvoiceMutation.isPending}
                required
              />
            </div>
            <div>
              <label htmlFor="quick-due-date" className="block text-sm text-gray-300 mb-1">
                Due Date (optional)
              </label>
              <input
                id="quick-due-date"
                type="date"
                value={quickDueDate}
                onChange={(e) => setQuickDueDate(e.target.value)}
                className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={createInvoiceMutation.isPending}
              />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="quick-description" className="block text-sm text-gray-300 mb-1">
                Description
              </label>
              <textarea
                id="quick-description"
                value={quickDescription}
                onChange={(e) => setQuickDescription(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={createInvoiceMutation.isPending}
                required
              />
            </div>
            {quickFormError && <p className="sm:col-span-2 text-sm text-red-400">{quickFormError}</p>}
            <div className="sm:col-span-2">
              <Button type="submit" size="sm" variant="primary" disabled={createInvoiceMutation.isPending}>
                {createInvoiceMutation.isPending ? "Creating..." : "Create Invoice"}
              </Button>
            </div>
          </form>
        </div>
      )}

      {pendingInvoices.length > 0 && (
        <div className="rounded-lg border border-amber-700/60 bg-amber-900/10 p-4">
          <h5 className="text-sm font-semibold uppercase tracking-wide text-amber-300">Pending Invoice Sync</h5>
          <div className="mt-3 space-y-2">
            {pendingInvoices.map((item) => (
              <div key={item.id} className="rounded border border-amber-700/40 bg-gray-900/40 p-3">
                <p className="text-sm text-gray-200">
                  {item.payload.description} - {formatUsd(item.payload.amountCents)}
                </p>
                <p className="text-xs text-amber-300 mt-1">
                  {item.status === "syncing" ? "Syncing..." : `Failed: ${item.error || "Unknown error"}`}
                </p>
                {item.status === "failed" && (
                  <div className="mt-2">
                    <Button size="sm" variant="secondary" onClick={() => retryPendingInvoice(item.id)}>
                      Retry
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-gray-700 bg-gray-800/30 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h5 className="text-sm font-semibold uppercase tracking-wide text-gray-300">Ledger Invoices</h5>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => pullLedgerInvoices()}
            isLoading={invoicesFetching}
          >
            Pull from Ledger
          </Button>
          <select
            value={invoiceFilter}
            onChange={(e) => setInvoiceFilter(e.target.value)}
            className="rounded-md border border-gray-600 bg-gray-900/60 px-2 py-1 text-xs text-gray-100"
          >
            <option value="all">All</option>
            <option value="past_due">Past Due</option>
            <option value="open">Open</option>
            <option value="paid">Paid</option>
            <option value="void">Canceled</option>
          </select>
        </div>

        {invoicesLoading ? (
          <p className="text-sm text-gray-400 mt-3">Loading invoices...</p>
        ) : sortedInvoices.length === 0 ? (
          <p className="text-sm text-gray-400 mt-3">No synced Ledger invoices for this filter.</p>
        ) : (
          <div className="overflow-x-auto mt-3">
            <table className="min-w-full divide-y divide-gray-700">
              <thead>
                <tr>
                  {["Description", "Amount", "Due", "Status", "Actions"].map((h) => (
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
                {sortedInvoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td className="px-3 py-2 text-sm text-gray-200">{invoice.description || "-"}</td>
                    <td className="px-3 py-2 text-sm text-gray-200">{formatUsd(invoice.amountCents)}</td>
                    <td className="px-3 py-2 text-sm text-gray-300">{formatDate(invoice.dueDate)}</td>
                    <td className="px-3 py-2 text-sm">
                      <StatusBadge status={isInvoicePastDue(invoice) ? "past_due" : invoice.status} />
                    </td>
                    <td className="px-3 py-2 text-sm">
                      {invoice.hostedUrl ? (
                        <button
                          type="button"
                          onClick={() => window.open(invoice.hostedUrl, "_blank")}
                          className="text-blue-400 hover:text-blue-300"
                        >
                          Open
                        </button>
                      ) : (
                        <span className="text-gray-500">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
