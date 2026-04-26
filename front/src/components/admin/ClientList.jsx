import { useCallback, useState } from "react";
import {
  useClients,
  usePatchClientStatus,
  useResendOnboarding,
  useRetryClientSync,
} from "../../hooks/useClients";
import { useGroups } from "../../hooks/useGroups";
import logger from "../../utils/logger";
import ConfirmModal from "./ConfirmModal";
import EditClientModal from "./EditClientModal";
import AdminTable from "./shared/AdminTable";
import Button from "./shared/Button";
import StatusBadge from "./shared/StatusBadge";

function formatFee(client, groups) {
  if (client.processingFeePercent != null) return `${client.processingFeePercent}%`;
  if (client.processingFeeCents != null)
    return `$${(client.processingFeeCents / 100).toFixed(2)} flat`;
  if (client.groupId) {
    const group = groups.find((g) => g.id === client.groupId);
    if (group?.processingFeePercent != null) return `${group.processingFeePercent}% (group)`;
    if (group?.processingFeeCents != null)
      return `$${(group.processingFeeCents / 100).toFixed(2)} flat (group)`;
  }
  return "Default";
}

function renderSyncBadge(client) {
  if (client.syncStatus === "failed") {
    return <span className="text-xs font-semibold text-red-300">Failed</span>;
  }
  if (client.syncStatus === "pending") {
    return <span className="text-xs font-semibold text-yellow-300">Pending</span>;
  }
  return <span className="text-xs font-semibold text-emerald-300">Synced</span>;
}

export default function ClientList({ showToast, workspace = "client_portal" }) {
  const isDfwscMode = workspace === "dfwsc_services";
  const { data: clients = [], isLoading, isError, error, refetch } = useClients({ workspace });
  const { data: groups = [] } = useGroups(workspace);
  const patchClientStatusMutation = usePatchClientStatus();
  const resendMutation = useResendOnboarding();
  const retrySyncMutation = useRetryClientSync();

  const [editingClient, setEditingClient] = useState(null);
  const [confirmModal, setConfirmModal] = useState({
    isOpen: false,
    clientId: null,
    clientName: "",
    currentStatus: "",
  });

  const handleStatusToggle = useCallback(
    (client) => {
      if (client.status === "active") {
        setConfirmModal({
          isOpen: true,
          clientId: client.id,
          clientName: client.name,
          currentStatus: client.status,
        });
      } else {
        patchClientStatusMutation.mutate(
          { id: client.id, status: "active" },
          {
            onSuccess: () => showToast?.("Client activated successfully", "success"),
            onError: (err) => showToast?.(`Error updating client status: ${err.message}`, "error"),
          }
        );
      }
    },
    [patchClientStatusMutation, showToast]
  );

  const handleConfirmDeactivate = useCallback(() => {
    const { clientId } = confirmModal;
    setConfirmModal({ isOpen: false, clientId: null, clientName: "", currentStatus: "" });
    if (clientId) {
      patchClientStatusMutation.mutate(
        { id: clientId, status: "inactive" },
        {
          onSuccess: () => showToast?.("Client deactivated successfully", "success"),
          onError: (err) => showToast?.(`Error updating client status: ${err.message}`, "error"),
        }
      );
    }
  }, [confirmModal, patchClientStatusMutation, showToast]);

  const handleCancelDeactivate = () => {
    setConfirmModal({ isOpen: false, clientId: null, clientName: "", currentStatus: "" });
  };

  const handleResendLink = useCallback(
    (client) => {
      resendMutation.mutate(
        { clientId: client.id },
        {
          onSuccess: () => {
            showToast?.("New onboarding link sent successfully!", "success");
            logger.info(`Resent onboarding link for client: ${client.email}`);
          },
          onError: (err) => {
            logger.error("Error resending onboarding link:", err);
            showToast?.(`Error: ${err.message}`, "error");
          },
        }
      );
    },
    [resendMutation, showToast]
  );

  const columns = [
    { header: "Name", key: "name" },
    { header: "Email", key: "email" },
    ...(!isDfwscMode
      ? [
          {
            header: "Status",
            render: (client) => <StatusBadge status={client.status} />,
          },
          {
            header: "Onboarding",
            render: (client) => (
              <StatusBadge status={client.stripeAccountId ? "completed" : "pending"} />
            ),
          },
        ]
      : []),
    ...(isDfwscMode
      ? [
          {
            header: "Status",
            render: (client) => <StatusBadge status={client.status} />,
          },
        ]
      : []),
    ...(!isDfwscMode
      ? [
          {
            header: "Group",
            render: (client) => {
              const groupName = groups.find((g) => g.id === client.groupId)?.name;
              return groupName ?? <span className="text-gray-500">—</span>;
            },
          },
        ]
      : []),
    {
      header: "Fee",
      render: (client) => formatFee(client, groups),
    },
    {
      header: "Sync",
      render: (client) => renderSyncBadge(client),
    },
    ...(isDfwscMode
      ? [
          {
            header: "Stripe Customer",
            render: (client) => client.stripeCustomerId || "N/A",
          },
        ]
      : [
          {
            header: "Stripe Account",
            render: (client) => client.stripeAccountId || "N/A",
          },
        ]),
    {
      header: "Actions",
      render: (client) => {
        const isTogglingStatus =
          patchClientStatusMutation.isPending &&
          patchClientStatusMutation.variables?.id === client.id;
        const isRetryingSync =
          retrySyncMutation.isPending && retrySyncMutation.variables === client.id;
        return (
          <div className="flex gap-2">
            {client.syncStatus === "failed" && (
              <Button
                size="sm"
                variant="ghost"
                className="bg-amber-600 hover:bg-amber-700 text-white"
                title={client.syncError || "Retry sync"}
                isLoading={isRetryingSync}
                onClick={() =>
                  retrySyncMutation.mutate(client.id, {
                    onSuccess: () => showToast?.("Client sync retried.", "success"),
                    onError: (err) => showToast?.(`Retry failed: ${err.message}`, "error"),
                  })
                }
              >
                Retry Sync
              </Button>
            )}
            {!isDfwscMode && (
              <Button
                size="sm"
                variant="ghost"
                className="bg-purple-600 hover:bg-purple-700 text-white"
                disabled={!!client.stripeAccountId}
                title={client.stripeAccountId ? "Already onboarded" : "Resend onboarding link"}
                onClick={() => handleResendLink(client)}
              >
                Resend Link
              </Button>
            )}
            <Button size="sm" onClick={() => setEditingClient(client)}>
              Edit
            </Button>
            <Button
              size="sm"
              variant={client.status === "active" ? "danger" : "success"}
              disabled={isTogglingStatus}
              isLoading={isTogglingStatus}
              onClick={() => handleStatusToggle(client)}
            >
              {isTogglingStatus ? "..." : client.status === "active" ? "Deactivate" : "Activate"}
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <>
      <AdminTable
        columns={columns}
        rows={clients}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={refetch}
        emptyMessage="No clients yet"
        loadingMessage="Loading clients..."
      />

      <ConfirmModal
        isOpen={confirmModal.isOpen}
        title="Deactivate Client"
        message={`Are you sure you want to deactivate "${confirmModal.clientName}"? They will no longer be able to access the system.`}
        onConfirm={handleConfirmDeactivate}
        onCancel={handleCancelDeactivate}
        confirmText="Deactivate"
        cancelText="Cancel"
        confirmVariant="danger"
      />

      {editingClient && (
        <EditClientModal
          client={editingClient}
          onClose={() => setEditingClient(null)}
          onSaved={() => setEditingClient(null)}
          showToast={showToast}
          workspace={workspace}
        />
      )}
    </>
  );
}
