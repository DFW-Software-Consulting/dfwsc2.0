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
    error: statusError,
  } = useSetupStatus();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("clients");
  const [clientSubTab, setClientSubTab] = useState("create"); // 'create' or 'import'
  const [workspace, setWorkspace] = useState("dfwsc_services");
  const [toast, setToast] = useState({ show: false, message: "", type: "" });
  const [billingSubTab, setBillingSubTab] = useState("invoices");
  const [preselectedClient, setPreselectedClient] = useState(null);
  const [showDfwsClientSuccess, setShowDfwsClientSuccess] = useState(false);

  const isDfwscMode = workspace === "dfwsc_services";
  const visibleTabs = isDfwscMode ? TABS.filter((tab) => tab.id !== "groups") : TABS;

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

  const handleDfwscClientCreated = useCallback((client) => {
    setPreselectedClient(client);
    setShowDfwsClientSuccess(true);
    setActiveTab("billing");
  }, []);

  const handleBackToClients = useCallback(() => {
    setShowDfwsClientSuccess(false);
    setPreselectedClient(null);
    setActiveTab("clients");
  }, []);

  const handleCreateInvoice = useCallback(() => {
    setBillingSubTab("invoices");
    setActiveTab("billing");
  }, []);

  const handleCreateSubscription = useCallback(() => {
    setBillingSubTab("subscriptions");
    setActiveTab("billing");
  }, []);

  const handleWorkspaceChange = useCallback((nextWorkspace) => {
    setWorkspace(nextWorkspace);
    setShowDfwsClientSuccess(false);
    setPreselectedClient(null);
    setActiveTab((prev) =>
      prev === "groups" && nextWorkspace === "dfwsc_services" ? "clients" : prev
    );
  }, []);

  // ─── Unauthenticated state ───────────────────────────────────────────────

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

    // Default to Login if status is unknown/undetermined (e.g., API unreachable)
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

      <div className="bg-gray-800/80 p-1 rounded-xl border border-gray-700 flex max-w-sm mx-auto mb-6 shadow-inner">
        <button
          type="button"
          onClick={() => handleWorkspaceChange("dfwsc_services")}
          className={`flex-1 py-2 px-4 rounded-lg text-sm font-bold transition-all duration-200 ${
            isDfwscMode
              ? "bg-blue-600 text-white shadow-lg scale-[1.02]"
              : "text-gray-400 hover:text-gray-200"
          }`}
        >
          DFWSC Services
        </button>
        <button
          type="button"
          onClick={() => handleWorkspaceChange("client_portal")}
          className={`flex-1 py-2 px-4 rounded-lg text-sm font-bold transition-all duration-200 ${
            !isDfwscMode
              ? "bg-indigo-600 text-white shadow-lg scale-[1.02]"
              : "text-gray-400 hover:text-gray-200"
          }`}
        >
          Client Portal
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-700 mb-6">
        {visibleTabs.map((tab) => (
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
            <CreateClientForm
              showToast={showToast}
              workspace={workspace}
              onSuccess={isDfwscMode ? handleDfwscClientCreated : undefined}
            />
          ) : (
            <ImportStripeCustomer showToast={showToast} workspace={workspace} />
          )}

          <div className="mb-6">
            <h4 className="text-md font-semibold text-white mb-3">
              {isDfwscMode ? "DFWSC Client List" : "Portal Client List"}
            </h4>
            <ClientList showToast={showToast} workspace={workspace} />
          </div>
        </>
      )}

      {/* Groups tab */}
      {activeTab === "groups" && !isDfwscMode && (
        <GroupPanel showToast={showToast} workspace={workspace} />
      )}

      {/* Reports tab */}
      {activeTab === "reports" && <PaymentReports showToast={showToast} workspace={workspace} />}

      {/* Billing tab */}
      {activeTab === "billing" && (
        <BillingPanel
          showToast={showToast}
          workspace={workspace}
          isDfwscMode={isDfwscMode}
          initialSubTab={billingSubTab}
          preselectedClient={preselectedClient}
        />
      )}

      {/* DFWSC Client Success - Post-Create Next Steps */}
      {showDfwsClientSuccess && preselectedClient && activeTab !== "clients" && (
        <div className="mb-6 p-4 bg-green-900/20 border border-green-500/30 rounded-lg">
          <h4 className="text-lg font-semibold text-green-400 mb-4">
            Client Created: {preselectedClient.name}
          </h4>
          <p className="text-gray-300 mb-4">
            Would you like to create a billing record for this client?
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={handleCreateInvoice}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors font-medium"
            >
              Create One-Time Invoice
            </button>
            <button
              type="button"
              onClick={handleCreateSubscription}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-md transition-colors font-medium"
            >
              Create Subscription
            </button>
            <button
              type="button"
              onClick={handleBackToClients}
              className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded-md transition-colors font-medium"
            >
              Back to Clients
            </button>
          </div>
        </div>
      )}

      {/* Settings tab */}
      {activeTab === "settings" && <SettingsPanel showToast={showToast} />}

      <Toast show={toast.show} message={toast.message} type={toast.type} onClose={hideToast} />
    </div>
  );
}
