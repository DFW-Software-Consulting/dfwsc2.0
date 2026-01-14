import { useState, useCallback } from "react";
import ConfirmModal from "./ConfirmModal";

export default function ClientList({
  clients,
  onStatusChange,
  showToast,
  onSessionExpired,
  loading,
  error,
  onRefresh,
}) {
  const [loadingClientId, setLoadingClientId] = useState(null);
  const [confirmModal, setConfirmModal] = useState({
    isOpen: false,
    clientId: null,
    clientName: "",
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

      // Optimistic update
      onStatusChange?.(clientId, newStatus);

      try {
        const res = await fetch(
          `${import.meta.env.VITE_API_URL}/v1/clients/${clientId}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ status: newStatus }),
          }
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
            errorData.error || `HTTP ${res.status}: ${res.statusText}`
          );
        }

        showToast?.(
          `Client ${newStatus === "active" ? "activated" : "deactivated"} successfully`,
          "success"
        );
      } catch (err) {
        console.error("Error updating client status:", err);
        // Rollback optimistic update
        onStatusChange?.(clientId, currentStatus);
        showToast?.(`Error updating client status: ${err.message}`, "error");
      } finally {
        setLoadingClientId(null);
      }
    },
    [onStatusChange, showToast]
  );

  const handleStatusToggle = useCallback(
    (client) => {
      if (client.status === "active") {
        // Deactivation requires confirmation
        setConfirmModal({
          isOpen: true,
          clientId: client.id,
          clientName: client.name,
          currentStatus: client.status,
        });
      } else {
        // Activation does not require confirmation
        updateClientStatus(client.id, client.status);
      }
    },
    [updateClientStatus]
  );

  const handleConfirmDeactivate = useCallback(() => {
    if (confirmModal.clientId) {
      updateClientStatus(confirmModal.clientId, confirmModal.currentStatus);
    }
    setConfirmModal({ isOpen: false, clientId: null, clientName: "" });
  }, [confirmModal, updateClientStatus]);

  const handleCancelDeactivate = useCallback(() => {
    setConfirmModal({ isOpen: false, clientId: null, clientName: "" });
  }, []);

  if (loading) {
    return (
      <div className="text-center py-8">
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500"></div>
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
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">
                Name
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">
                Email
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">
                Status
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">
                Stripe Account
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {clients.map((client) => (
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
                    {client.status.charAt(0).toUpperCase() +
                      client.status.slice(1)}
                  </span>
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-200">
                  {client.stripeAccountId || "N/A"}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-sm">
                  <button
                    onClick={() => handleStatusToggle(client)}
                    disabled={loadingClientId === client.id}
                    className={`px-3 py-1 rounded text-xs font-medium ${
                      client.status === "active"
                        ? "bg-red-600 hover:bg-red-700 text-white"
                        : "bg-green-600 hover:bg-green-700 text-white"
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                    title={`${client.status === "active" ? "Deactivate" : "Activate"} client`}
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
                </td>
              </tr>
            ))}
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
    </>
  );
}
