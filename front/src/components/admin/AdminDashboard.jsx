import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { useSetupStatus } from "../../hooks/useSetupStatus";
import AddClientModal from "./AddClientModal";
import AdminLogin from "./AdminLogin";
import AdminSetup from "./AdminSetup";
import ClientList from "./ClientList";
import GroupPanel from "./GroupPanel";
import PaymentReports from "./PaymentReports";
import SettingsPanel from "./SettingsPanel";
import Toast from "./Toast";

const TABS = [
  { id: "clients", label: "Accounts" },
  { id: "groups", label: "Companies" },
  { id: "reports", label: "Reports" },
  { id: "settings", label: "Settings" },
];

export default function AdminDashboard() {
  const { isLoggedIn, logout } = useAuth();
  const {
    bootstrapPending,
    adminConfigured,
    requiresSetup,
    isLoading: statusLoading,
    error: statusError,
  } = useSetupStatus();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState("clients");
  const [showAddClientModal, setShowAddClientModal] = useState(false);
  const [toast, setToast] = useState({ show: false, message: "", type: "" });

  const showToast = useCallback((message, type = "info") => {
    setToast({ show: true, message, type });
  }, []);

  const hideToast = useCallback(() => {
    setToast({ show: false, message: "", type: "" });
  }, []);

  const handleSetupComplete = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["setup-status"] });
  }, [queryClient]);

  const handleLogout = useCallback(() => {
    logout();
    setActiveTab("clients");
  }, [logout]);

  if (!isLoggedIn) {
    if (statusLoading) {
      return (
        <div className="flex justify-center items-center py-8">
          <div className="text-gray-400">Loading...</div>
        </div>
      );
    }

    if (statusError) {
      return (
        <div className="bg-red-900/20 border border-red-500 rounded-lg p-4 mb-6">
          <p className="text-red-400 text-sm font-medium">
            Error: Could not connect to the backend. Please check if the API server is running and
            configured correctly.
          </p>
          <p className="text-red-300 text-xs mt-1">{statusError.message}</p>
        </div>
      );
    }

    const showLogin = !bootstrapPending && !requiresSetup && adminConfigured;
    const showSetup = bootstrapPending || requiresSetup;

    return (
      <>
        {showSetup && (
          <AdminSetup
            onSetupComplete={handleSetupComplete}
            showToast={showToast}
            isBootstrapPending={bootstrapPending}
            isCreatingAdmin={requiresSetup}
          />
        )}
        {showLogin ? (
          <AdminLogin showToast={showToast} />
        ) : (
          !showSetup && (
            <div className="text-center py-8">
              <p className="text-gray-400">
                Unable to load admin state. Please check your configuration.
              </p>
              <button
                type="button"
                onClick={() => queryClient.invalidateQueries({ queryKey: ["setup-status"] })}
                className="mt-4 text-blue-400 hover:text-blue-300 text-sm font-medium"
              >
                Retry
              </button>
            </div>
          )
        )}
        <Toast show={toast.show} message={toast.message} type={toast.type} onClose={hideToast} />
      </>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-lg font-semibold text-white">Welcome, Admin!</h3>
        <button
          type="button"
          onClick={handleLogout}
          className="text-sm bg-red-600 hover:bg-red-700 text-white py-1 px-3 rounded-md transition-colors"
        >
          Logout
        </button>
      </div>

      <div className="flex border-b border-gray-700 mb-6">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab.id
                ? "border-blue-500 text-blue-400"
                : "border-transparent text-gray-400 hover:text-gray-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "clients" && (
        <ClientList
          showToast={showToast}
          workspace="client_portal"
          onAddClient={() => setShowAddClientModal(true)}
        />
      )}

      {activeTab === "groups" && <GroupPanel showToast={showToast} workspace="client_portal" />}

      {activeTab === "reports" && (
        <PaymentReports showToast={showToast} workspace="client_portal" />
      )}

      {activeTab === "settings" && <SettingsPanel showToast={showToast} />}

      <AddClientModal
        isOpen={showAddClientModal}
        onClose={() => setShowAddClientModal(false)}
        onCreated={() => setShowAddClientModal(false)}
        showToast={showToast}
      />

      <Toast show={toast.show} message={toast.message} type={toast.type} onClose={hideToast} />
    </div>
  );
}
