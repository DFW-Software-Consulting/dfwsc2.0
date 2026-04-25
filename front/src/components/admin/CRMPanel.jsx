import { useCallback, useState } from "react";
import { useClients } from "../../hooks/useClients";
import {
  useConvertToClient,
  useCreateLead,
  useReinstateClient,
  useSuspendClient,
  useSyncPaymentStatus,
} from "../../hooks/useCRM";
import ClientInvoicesModal from "./ClientInvoicesModal";
import SuspendModal from "./SuspendModal";
import AdminTable from "./shared/AdminTable";
import BaseModal from "./shared/BaseModal";
import Button from "./shared/Button";
import FormInput from "./shared/FormInput";
import StatusBadge from "./shared/StatusBadge";

function formatSyncedAt(iso) {
  if (!iso) return <span className="text-gray-500 text-xs">—</span>;
  return <span className="text-xs text-gray-300">{new Date(iso).toLocaleString()}</span>;
}

function AddLeadModal({ isOpen, onClose, onSubmit, isPending }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [lastContactAt, setLastContactAt] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [followUpAt, setFollowUpAt] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = () => {
    if (!name.trim() || !email.trim()) {
      setError("Name and email are required.");
      return;
    }
    setError("");
    onSubmit({
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim() || undefined,
      notes: notes.trim() || undefined,
      lastContactAt: lastContactAt || undefined,
      nextAction: nextAction.trim() || undefined,
      followUpAt: followUpAt || undefined,
    });
  };

  const handleClose = () => {
    setName("");
    setEmail("");
    setPhone("");
    setNotes("");
    setLastContactAt("");
    setNextAction("");
    setFollowUpAt("");
    setError("");
    onClose();
  };

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={handleClose}
      title="Add New Lead"
      titleId="add-lead-title"
      size="md"
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormInput
            id="lead-name"
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Jane Smith"
            disabled={isPending}
          />
          <FormInput
            id="lead-email"
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="e.g. jane@company.com"
            disabled={isPending}
          />
        </div>
        <FormInput
          id="lead-phone"
          label="Phone (optional)"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="e.g. +1 (555) 123-4567"
          disabled={isPending}
        />
        <div>
          <label htmlFor="lead-notes" className="block text-sm font-medium text-gray-300 mb-1">
            Notes (optional)
          </label>
          <textarea
            id="lead-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="How'd you meet them? What are they interested in?"
            rows={3}
            className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            disabled={isPending}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormInput
            id="lead-last-contact-at"
            label="Last Contact (optional)"
            type="datetime-local"
            value={lastContactAt}
            onChange={(e) => setLastContactAt(e.target.value)}
            disabled={isPending}
          />
          <FormInput
            id="lead-follow-up-at"
            label="Follow-up (optional)"
            type="datetime-local"
            value={followUpAt}
            onChange={(e) => setFollowUpAt(e.target.value)}
            disabled={isPending}
          />
        </div>
        <FormInput
          id="lead-next-action"
          label="Next Action (optional)"
          value={nextAction}
          onChange={(e) => setNextAction(e.target.value)}
          placeholder="e.g. Send proposal and schedule call"
          disabled={isPending}
        />
        {error && <p className="text-red-400 text-sm">{error}</p>}
      </div>
      <div className="flex justify-end gap-3 mt-6">
        <Button variant="secondary" onClick={handleClose} disabled={isPending}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleSubmit} isLoading={isPending} disabled={isPending}>
          Save Lead
        </Button>
      </div>
    </BaseModal>
  );
}

export default function CRMPanel({ showToast, workspace = "dfwsc_services" }) {
  const {
    data: allClients = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useClients({ workspace });

  const suspendMutation = useSuspendClient(workspace);
  const reinstateMutation = useReinstateClient(workspace);
  const syncMutation = useSyncPaymentStatus(workspace);
  const createLeadMutation = useCreateLead(workspace);
  const convertMutation = useConvertToClient(workspace);

  const [showAddLead, setShowAddLead] = useState(false);
  const [suspendModal, setSuspendModal] = useState({
    isOpen: false,
    clientId: null,
    clientName: "",
  });
  const [invoicesClient, setInvoicesClient] = useState(null);
  const [filter, setFilter] = useState("all"); // "all" | "leads" | "clients"

  const leads = allClients.filter((c) => c.status === "lead");
  const activeClients = allClients.filter((c) => c.status !== "lead");
  const displayed = filter === "leads" ? leads : filter === "clients" ? activeClients : allClients;

  const handleSyncNow = useCallback(() => {
    syncMutation.mutate(undefined, {
      onSuccess: ({ synced }) =>
        showToast?.(`Synced ${synced} client${synced !== 1 ? "s" : ""}`, "success"),
      onError: (err) => showToast?.(`Sync failed: ${err.message}`, "error"),
    });
  }, [syncMutation, showToast]);

  const handleAddLead = useCallback(
    (body) => {
      createLeadMutation.mutate(body, {
        onSuccess: (data) => {
          showToast?.(`Lead "${data.name}" added`, "success");
          setShowAddLead(false);
        },
        onError: (err) => showToast?.(`Error: ${err.message}`, "error"),
      });
    },
    [createLeadMutation, showToast]
  );

  const handleConvert = useCallback(
    (client) => {
      convertMutation.mutate(
        { id: client.id },
        {
          onSuccess: () =>
            showToast?.(`${client.name} is now a client — Stripe ID created`, "success"),
          onError: (err) => showToast?.(`Convert failed: ${err.message}`, "error"),
        }
      );
    },
    [convertMutation, showToast]
  );

  const handleSuspendClick = useCallback((client) => {
    setSuspendModal({ isOpen: true, clientId: client.id, clientName: client.name });
  }, []);

  const handleSuspendConfirm = useCallback(
    (reason) => {
      const { clientId } = suspendModal;
      setSuspendModal({ isOpen: false, clientId: null, clientName: "" });
      suspendMutation.mutate(
        { id: clientId, reason },
        {
          onSuccess: () => showToast?.("Client suspended", "success"),
          onError: (err) => showToast?.(`Error: ${err.message}`, "error"),
        }
      );
    },
    [suspendModal, suspendMutation, showToast]
  );

  const handleReinstate = useCallback(
    (client) => {
      reinstateMutation.mutate(
        { id: client.id },
        {
          onSuccess: () => showToast?.("Client reinstated", "success"),
          onError: (err) => showToast?.(`Error: ${err.message}`, "error"),
        }
      );
    },
    [reinstateMutation, showToast]
  );

  const columns = [
    { header: "Name", key: "name" },
    { header: "Email", key: "email" },
    {
      header: "Status",
      render: (c) => <StatusBadge status={c.status} />,
    },
    {
      header: "Payment",
      render: (c) => {
        if (c.status === "lead") return <span className="text-gray-500 text-xs">—</span>;
        return <StatusBadge status={c.paymentStatus ?? "none"} />;
      },
    },
    {
      header: "Last Synced",
      render: (c) => {
        if (c.status === "lead") return <span className="text-gray-500 text-xs">—</span>;
        return formatSyncedAt(c.paymentStatusSyncedAt);
      },
    },
    {
      header: "Follow-up",
      render: (c) =>
        c.followUpAt ? (
          <span className="text-xs text-gray-300">{new Date(c.followUpAt).toLocaleString()}</span>
        ) : (
          <span className="text-gray-500 text-xs">—</span>
        ),
    },
    {
      header: "Next Action",
      render: (c) =>
        c.nextAction ? (
          <span className="text-xs text-gray-300 max-w-[180px] truncate" title={c.nextAction}>
            {c.nextAction}
          </span>
        ) : (
          <span className="text-gray-500 text-xs">—</span>
        ),
    },
    {
      header: "Actions",
      render: (c) => {
        const isLead = c.status === "lead";
        const isSuspended = !!c.suspendedAt;
        const isConverting = convertMutation.isPending && convertMutation.variables?.id === c.id;
        const isSuspending = suspendMutation.isPending && suspendMutation.variables?.id === c.id;
        const isReinstating =
          reinstateMutation.isPending && reinstateMutation.variables?.id === c.id;

        if (isLead) {
          return (
            <Button
              size="sm"
              variant="primary"
              disabled={isConverting}
              isLoading={isConverting}
              onClick={() => handleConvert(c)}
            >
              Convert to Client
            </Button>
          );
        }

        return (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setInvoicesClient(c)}>
              Invoices
            </Button>
            {isSuspended ? (
              <div className="flex flex-col gap-1">
                <Button
                  size="sm"
                  variant="success"
                  disabled={isReinstating}
                  isLoading={isReinstating}
                  onClick={() => handleReinstate(c)}
                >
                  Reinstate
                </Button>
                {c.suspensionReason && (
                  <span
                    className="text-xs text-gray-400 max-w-[160px] truncate"
                    title={c.suspensionReason}
                  >
                    {c.suspensionReason}
                  </span>
                )}
              </div>
            ) : (
              <Button
                size="sm"
                variant="danger"
                disabled={isSuspending}
                isLoading={isSuspending}
                onClick={() => handleSuspendClick(c)}
              >
                Suspend
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div>
      {/* Header row */}
      <div className="flex flex-wrap justify-between items-center gap-3 mb-4">
        <div className="flex items-center gap-2">
          <h4 className="text-md font-semibold text-white">
            {workspace === "ledger_crm" ? "Ledger CRM" : "CRM"}
          </h4>
          <span className="text-xs text-gray-400">
            {leads.length} lead{leads.length !== 1 ? "s" : ""} · {activeClients.length} client
            {activeClients.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="primary" onClick={() => setShowAddLead(true)}>
            + Add Lead
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={syncMutation.isPending}
            isLoading={syncMutation.isPending}
            onClick={handleSyncNow}
          >
            Sync Now
          </Button>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-4 mb-4 border-b border-gray-700">
        {[
          ["all", "All"],
          ["leads", "Leads"],
          ["clients", "Clients"],
        ].map(([val, label]) => (
          <button
            key={val}
            type="button"
            onClick={() => setFilter(val)}
            className={`pb-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              filter === val
                ? "border-blue-500 text-blue-400"
                : "border-transparent text-gray-400 hover:text-gray-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <AdminTable
        columns={columns}
        rows={displayed}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={refetch}
        emptyMessage={
          filter === "leads"
            ? "No leads yet — add one above"
            : filter === "clients"
              ? "No clients yet"
              : "No records yet"
        }
        loadingMessage="Loading CRM data..."
      />

      <AddLeadModal
        isOpen={showAddLead}
        onClose={() => setShowAddLead(false)}
        onSubmit={handleAddLead}
        isPending={createLeadMutation.isPending}
      />

      {invoicesClient && (
        <ClientInvoicesModal
          client={invoicesClient}
          workspace={workspace}
          onClose={() => setInvoicesClient(null)}
          showToast={showToast}
        />
      )}

      <SuspendModal
        isOpen={suspendModal.isOpen}
        clientName={suspendModal.clientName}
        onConfirm={handleSuspendConfirm}
        onClose={() => setSuspendModal({ isOpen: false, clientId: null, clientName: "" })}
      />
    </div>
  );
}
