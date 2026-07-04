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
import Button from "./shared/Button";
import Toast from "./Toast";

const TABS = [
  { id: "clients", label: "Accounts" },
  { id: "groups", label: "Companies" },
  { id: "reports", label: "Reports" },
  { id: "settings", label: "Settings" },
];

export default function AdminDashboard() {
  const { isLoggedIn, logout, token, bootstrapPending, clearBootstrapPending } = useAuth();
  const { requiresSetup, isLoading: statusLoading, error: statusError } = useSetupStatus();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState("clients");
  const [toast, setToast] = useState({ show: false, message: "", type: "" });
  const [showAddClient, setShowAddClient] = useState(false);

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

    const showSetup = requiresSetup;

    return (
      <>
        {showSetup ? (
          <AdminSetup
            onSetupComplete={handleSetupComplete}
            showToast={showToast}
            isBootstrapPending={false}
          />
        ) : (
          <AdminLogin showToast={showToast} />
        )}
        <Toast show={toast.show} message={toast.message} type={toast.type} onClose={hideToast} />
      </>
    );
  }

  if (bootstrapPending) {
    return (
      <>
        <AdminSetup
          isBootstrapPending
          token={token}
          showToast={showToast}
          onSetupComplete={clearBootstrapPending}
        />
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
        <>
          <div className="flex justify-end mb-4">
            <Button onClick={() => setShowAddClient(true)}>Add Client</Button>
          </div>
          <ClientList showToast={showToast} workspace="client_portal" />
        </>
      )}

      {showAddClient && (
        <AddClientModal
          onClose={() => setShowAddClient(false)}
          showToast={showToast}
          workspace="client_portal"
        />
      )}

      {activeTab === "groups" && <GroupPanel showToast={showToast} workspace="client_portal" />}

      {activeTab === "reports" && (
        <PaymentReports showToast={showToast} workspace="client_portal" />
      )}

      {activeTab === "settings" && <SettingsPanel showToast={showToast} />}

      <Toast show={toast.show} message={toast.message} type={toast.type} onClose={hideToast} />
    </div>
  );
}
