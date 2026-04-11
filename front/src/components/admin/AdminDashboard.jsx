import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { useSetupStatus } from "../../hooks/useSetupStatus";
import AdminLogin from "./AdminLogin";
import AdminSetup from "./AdminSetup";
import BillingPanel from "./BillingPanel";
import ClientList from "./ClientList";
import CreateClientForm from "./CreateClientForm";
import GroupPanel from "./GroupPanel";
import ImportStripeCustomer from "./ImportStripeCustomer";
import PaymentReports from "./PaymentReports";
import SettingsPanel from "./SettingsPanel";
import Toast from "./Toast";

const TABS = [
  { id: "clients", label: "Accounts" },
  { id: "groups", label: "Companies" },
  { id: "reports", label: "Reports" },
  { id: "billing", label: "Billing" },
  { id: "settings", label: "Settings" },
];

export default function AdminDashboard() {
  const { isLoggedIn, logout } = useAuth();
  const {
    bootstrapPending,
    adminConfigured,
    requiresSetup,
    isLoading: statusLoading,
  } = useSetupStatus();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("clients");
  const [clientSubTab, setClientSubTab] = useState("create"); // 'create' or 'import'
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

  // ─── Unauthenticated state ───────────────────────────────────────────────

  if (!isLoggedIn) {
    if (statusLoading) {
      return (
        <div className="flex justify-center items-center py-8">
          <div className="text-gray-400">Loading...</div>
        </div>
      );
    }
    return (
      <>
        {(bootstrapPending || requiresSetup) && (
          <AdminSetup
            onSetupComplete={handleSetupComplete}
            showToast={showToast}
            isBootstrapPending={bootstrapPending}
            isCreatingAdmin={requiresSetup}
          />
        )}
        {!bootstrapPending && !requiresSetup && adminConfigured ? (
          <AdminLogin showToast={showToast} />
        ) : null}
        <Toast show={toast.show} message={toast.message} type={toast.type} onClose={hideToast} />
      </>
    );
  }

  // ─── Authenticated state ─────────────────────────────────────────────────

  return (
    <div>
      {/* Header */}
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

      {/* Tabs */}
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

      {/* Clients tab */}
      {activeTab === "clients" && (
        <>
          <div className="flex gap-4 mb-4">
            <button
              type="button"
              onClick={() => setClientSubTab("create")}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                clientSubTab === "create"
                  ? "bg-blue-600 text-white shadow-lg"
                  : "bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-white"
              }`}
            >
              + New Client
            </button>
            <button
              type="button"
              onClick={() => setClientSubTab("import")}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                clientSubTab === "import"
                  ? "bg-blue-600 text-white shadow-lg"
                  : "bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-white"
              }`}
            >
              📥 Import from Stripe
            </button>
          </div>

          {clientSubTab === "create" ? (
            <CreateClientForm showToast={showToast} />
          ) : (
            <ImportStripeCustomer showToast={showToast} />
          )}

          <div className="mb-6">
            <h4 className="text-md font-semibold text-white mb-3">Client List</h4>
            <ClientList showToast={showToast} />
          </div>
        </>
      )}

      {/* Groups tab */}
      {activeTab === "groups" && <GroupPanel showToast={showToast} />}

      {/* Reports tab */}
      {activeTab === "reports" && <PaymentReports showToast={showToast} />}

      {/* Billing tab */}
      {activeTab === "billing" && <BillingPanel showToast={showToast} />}

      {/* Settings tab */}
      {activeTab === "settings" && <SettingsPanel showToast={showToast} />}

      <Toast show={toast.show} message={toast.message} type={toast.type} onClose={hideToast} />
    </div>
  );
}
