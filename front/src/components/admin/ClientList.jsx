import { useState, useCallback } from "react";
import ConfirmModal from "./ConfirmModal";
import EditClientModal from "./EditClientModal";
import logger from "../../utils/logger";

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

export default function ClientList({
  clients,
  groups,
  onStatusChange,
  onClientUpdated,
  showToast,
  onSessionExpired,
  loading,
  error,
  onRefresh,
}) {
  const [loadingClientId, setLoadingClientId] = useState(null);
  const [resendingClientId, setResendingClientId] = useState(null);
  const [editingClient, setEditingClient] = useState(null);
  const [confirmModal, setConfirmModal] = useState({
    isOpen: false,
    clientId: null,
    clientName: "",
    currentStatus: "",
  });

  const updateClientStatus = useCallback(
    async (clientId, currentStatus) => {
      const token = sessionStorage.getItem("adminToken");
      if (!token) {
        showToast?.("Session expired. You have been logged out.", "warning");
        onSessionExpired?.();
        return;
      }

      const newStatus = currentStatus === "active" ? "inactive" : "active";
      setLoadingClientId(clientId);
      onStatusChange?.(clientId, newStatus);

      try {
        const res = await fetch(
          `${import.meta.env.VITE_API_URL}/clients/${clientId}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ status: newStatus }),
          },
        );

        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            sessionStorage.removeItem("adminToken");
            onSessionExpired?.();
            throw new Error("Session expired. You have been logged out.");
          } else if (res.status === 404) {
            throw new Error("Client not found");
          }
          const errorData = await res
            .json()
            .catch(() => ({ error: "Failed to update client status" }));
          throw new Error(
            errorData.error || `HTTP ${res.status}: ${res.statusText}`,
          );
        }

        showToast?.(
          `Client ${newStatus === "active" ? "activated" : "deactivated"} successfully`,
          "success",
        );
      } catch (err) {
        logger.error("Error updating client status:", err);
        onStatusChange?.(clientId, currentStatus);
        showToast?.(`Error updating client status: ${err.message}`, "error");
      } finally {
        setLoadingClientId(null);
      }
    },
    [onStatusChange, showToast, onSessionExpired],
  );

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
        updateClientStatus(client.id, client.status);
      }
    },
    [updateClientStatus],
  );

  const handleConfirmDeactivate = useCallback(() => {
    const { clientId, currentStatus } = confirmModal;
    setConfirmModal({ isOpen: false, clientId: null, clientName: "", currentStatus: "" });
    if (clientId) updateClientStatus(clientId, currentStatus);
  }, [confirmModal, updateClientStatus]);

  const handleCancelDeactivate = () => {
    setConfirmModal({ isOpen: false, clientId: null, clientName: "", currentStatus: "" });
  };

  const handleResendLink = async (client) => {
    const token = sessionStorage.getItem("adminToken");
    if (!token) {
      showToast?.("Session expired. You have been logged out.", "warning");
      onSessionExpired?.();
      return;
    }

    setResendingClientId(client.id);

    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/onboard-client/resend`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ clientId: client.id }),
        },
      );

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          sessionStorage.removeItem("adminToken");
          onSessionExpired?.();
          throw new Error("Session expired. You have been logged out.");
        }
        throw new Error(data.error || `HTTP ${res.status}: ${res.statusText}`);
      }

      showToast?.("New onboarding link sent successfully!", "success");
      logger.info(`Resent onboarding link for client: ${client.email}`);
    } catch (err) {
      logger.error("Error resending onboarding link:", err);
      showToast?.(`Error: ${err.message}`, "error");
    } finally {
      setResendingClientId(null);
    }
  };

  if (loading) {
    return (
      <div className="text-center py-8">
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500" />
        <p className="mt-3 text-gray-300">Loading clients...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-4">
        <p className="text-red-400">{error}</p>
        <button
          onClick={onRefresh}
          className="mt-3 text-sm bg-blue-600 hover:bg-blue-700 text-white py-1 px-3 rounded-md transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (clients.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-gray-300">No clients yet</p>
      </div>
    );
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-700">
          <thead>
            <tr>
              {["Name", "Email", "Status", "Onboarding", "Group", "Fee", "Stripe Account", "Actions"].map((h) => (
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
            {clients.map((client) => {
              const groupName = groups.find((g) => g.id === client.groupId)?.name;
              const onboardingStatus = client.stripeAccountId 
                ? "Completed" 
                : "Pending";
              return (
                <tr key={client.id} className="hover:bg-gray-700/50">
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-200">
                    {client.name}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-200">
                    {client.email}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm">
                    <span
                      className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                        client.status === "active"
                          ? "bg-green-800 text-green-200"
                          : "bg-red-800 text-red-200"
                      }`}
                    >
                      {client.status.charAt(0).toUpperCase() + client.status.slice(1)}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm">
                    <span
                      className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                        onboardingStatus === "Completed"
                          ? "bg-blue-800 text-blue-200"
                          : "bg-yellow-800 text-yellow-200"
                      }`}
                    >
                      {onboardingStatus}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-200">
                    {groupName ?? <span className="text-gray-500">—</span>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-200">
                    {formatFee(client, groups)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-200">
                    {client.stripeAccountId || "N/A"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm">
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleResendLink(client)}
                        disabled={resendingClientId === client.id || !!client.stripeAccountId}
                        title={client.stripeAccountId ? "Already onboarded" : "Resend onboarding link"}
                        className={`px-3 py-1 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                          resendingClientId === client.id
                            ? "bg-gray-500 text-white"
                            : "bg-purple-600 hover:bg-purple-700 text-white"
                        }`}
                      >
                        {resendingClientId === client.id ? (
                          <span className="inline-flex items-center">
                            <svg
                              className="animate-spin -ml-1 mr-1 h-3 w-3 text-white"
                              fill="none"
                              viewBox="0 0 24 24"
                            >
                              <circle
                                className="opacity-25"
                                cx="12"
                                cy="12"
                                r="10"
                                stroke="currentColor"
                                strokeWidth="4"
                              />
                              <path
                                className="opacity-75"
                                fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                              />
                            </svg>
                            Sending...
                          </span>
                        ) : (
                          "Resend Link"
                        )}
                      </button>
                      <button
                        onClick={() => setEditingClient(client)}
                        className="px-3 py-1 rounded text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleStatusToggle(client)}
                        disabled={loadingClientId === client.id}
                        className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                          client.status === "active"
                            ? "bg-red-600 hover:bg-red-700 text-white"
                            : "bg-green-600 hover:bg-green-700 text-white"
                        } disabled:opacity-50 disabled:cursor-not-allowed`}
                      >
                        {loadingClientId === client.id ? (
                          <span className="inline-flex items-center">
                            <svg
                              className="animate-spin -ml-1 mr-1 h-3 w-3 text-white"
                              fill="none"
                              viewBox="0 0 24 24"
                            >
                              <circle
                                className="opacity-25"
                                cx="12"
                                cy="12"
                                r="10"
                                stroke="currentColor"
                                strokeWidth="4"
                              />
                              <path
                                className="opacity-75"
                                fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                              />
                            </svg>
                            ...
                          </span>
                        ) : client.status === "active" ? (
                          "Deactivate"
                        ) : (
                          "Activate"
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

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
          groups={groups}
          onClose={() => setEditingClient(null)}
          onSaved={(updated) => {
            setEditingClient(null);
            onClientUpdated?.(updated);
          }}
          showToast={showToast}
        />
      )}
    </>
  );
}
