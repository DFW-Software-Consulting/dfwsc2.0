import { useMemo, useState } from "react";
import { useClient } from "../../hooks/useClients";
import { useInvoices } from "../../hooks/useInvoices";
import { useSuspendClient, useReinstateClient } from "../../hooks/useCRM";
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

function resolvePaymentHealth(client) {
  if (!client) return "none";
  if (client.status === "inactive" || client.suspendedAt) return "canceled";
  if (!client.paymentStatus) return "none";
  return client.paymentStatus;
}

function canSuspend(health) {
  return ["past_due", "unpaid", "canceled"].includes(health);
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
  const { data: invoices = [], isLoading: invoicesLoading } = useInvoices({ workspace, clientId });
  const { data: subscriptions = [], isLoading: subscriptionsLoading } = useSubscriptions({
    workspace,
    clientId,
  });

  const suspendMutation = useSuspendClient(workspace);
  const reinstateMutation = useReinstateClient(workspace);

  const [invoiceFilter, setInvoiceFilter] = useState("all");

  const paymentHealth = resolvePaymentHealth(client);
  const isSuspended = client.status === "inactive" || Boolean(client.suspendedAt);
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

  const handleSuspend = () => {
    if (!client) return;
    if (!canSuspend(paymentHealth)) {
      showToast?.("Suspend is only available when payment health is overdue, unpaid, or canceled.", "error");
      return;
    }
    const confirmed = window.confirm(`Suspend ${client.name}? This marks the account inactive.`);
    if (!confirmed) return;

    suspendMutation.mutate(
      { id: client.id, reason: `Suspended from client profile (${paymentHealth})` },
      {
        onSuccess: () => showToast?.("Client suspended.", "success"),
        onError: (err) => showToast?.(err.message, "error"),
      }
    );
  };

  const handleReinstate = () => {
    if (!client) return;
    const confirmed = window.confirm(`Reinstate ${client.name}? This restores the account to active.`);
    if (!confirmed) return;

    reinstateMutation.mutate(
      { id: client.id },
      {
        onSuccess: () => showToast?.("Client reinstated.", "success"),
        onError: (err) => showToast?.(err.message, "error"),
      }
    );
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
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-300">Payment Health</span>
          <StatusBadge status={paymentHealth} />
        </div>
      </div>

      <div className="rounded-lg border border-gray-700 bg-gray-800/30 p-4">
        <h4 className="text-lg font-semibold text-white">{client.name}</h4>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
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
        <Button size="sm" variant="primary" onClick={() => onCreateInvoice?.(client)}>
          Create Invoice
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onCreateSubscription?.(client)}>
          Create Subscription
        </Button>
        {isSuspended ? (
          <Button
            size="sm"
            variant="success"
            onClick={handleReinstate}
            isLoading={reinstateMutation.isPending}
          >
            Reinstate
          </Button>
        ) : (
          <Button
            size="sm"
            variant="danger"
            onClick={handleSuspend}
            isLoading={suspendMutation.isPending}
            disabled={!canSuspend(paymentHealth) || reinstateMutation.isPending}
          >
            Suspend
          </Button>
        )}
      </div>

      {isSuspended && (
        <div className="rounded-lg border border-red-700/50 bg-red-900/20 p-3">
          <p className="text-sm text-red-300">
            Suspended {client.suspendedAt ? `on ${formatDate(client.suspendedAt)}` : ""}
          </p>
          {client.suspensionReason && (
            <p className="mt-1 text-xs text-red-200/90">Reason: {client.suspensionReason}</p>
          )}
        </div>
      )}

      <div className="rounded-lg border border-gray-700 bg-gray-800/30 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h5 className="text-sm font-semibold uppercase tracking-wide text-gray-300">Invoices</h5>
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
          <p className="text-sm text-gray-400 mt-3">No invoices for this filter.</p>
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
