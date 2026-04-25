import { useInvoices } from "../../hooks/useInvoices";
import AdminTable from "./shared/AdminTable";
import BaseModal from "./shared/BaseModal";
import Button from "./shared/Button";
import StatusBadge from "./shared/StatusBadge";

function formatCurrency(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(iso) {
  if (!iso) return <span className="text-gray-500">—</span>;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function ClientInvoicesModal({ client, workspace, onClose }) {
  const {
    data: invoices = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useInvoices({ workspace, clientId: client.id });

  const totalPaid = invoices
    .filter((inv) => inv.status === "paid")
    .reduce((sum, inv) => sum + inv.amountCents, 0);
  const totalOpen = invoices
    .filter((inv) => inv.status === "open")
    .reduce((sum, inv) => sum + inv.amountCents, 0);

  const columns = [
    {
      header: "Description",
      render: (inv) => (
        <span className="max-w-xs truncate inline-block align-middle" title={inv.description}>
          {inv.description || "—"}
        </span>
      ),
    },
    { header: "Amount", render: (inv) => formatCurrency(inv.amountCents) },
    { header: "Due", render: (inv) => formatDate(inv.dueDate) },
    { header: "Paid", render: (inv) => formatDate(inv.paidAt) },
    { header: "Status", render: (inv) => <StatusBadge status={inv.status} /> },
    {
      header: "",
      render: (inv) =>
        inv.hostedUrl ? (
          <a
            href={inv.hostedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="px-2 py-1 rounded text-xs bg-gray-600 hover:bg-gray-500 text-white transition-colors"
          >
            Open
          </a>
        ) : null,
    },
  ];

  return (
    <BaseModal
      isOpen
      onClose={onClose}
      title={`Invoices — ${client.name}`}
      titleId="client-invoices-title"
      size="xl"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex gap-6 text-sm">
          <span className="text-gray-400">
            Total: <span className="text-white font-semibold">{invoices.length}</span>
          </span>
          <span className="text-gray-400">
            Paid: <span className="text-green-400 font-semibold">{formatCurrency(totalPaid)}</span>
          </span>
          <span className="text-gray-400">
            Open: <span className="text-yellow-400 font-semibold">{formatCurrency(totalOpen)}</span>
          </span>
        </div>
        <Button size="sm" variant="secondary" onClick={() => refetch()}>
          Refresh
        </Button>
      </div>

      <AdminTable
        columns={columns}
        rows={invoices}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={refetch}
        emptyMessage="No invoices yet for this client."
        loadingMessage="Loading invoices..."
      />
    </BaseModal>
  );
}
