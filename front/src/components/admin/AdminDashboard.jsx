import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { useClients } from "../../hooks/useClients";
import AdminLogin from "./AdminLogin";
import AddClientModal from "./AddClientModal";
import AdminSetup from "./AdminSetup";
import BillingPanel from "./BillingPanel";
import ClientList from "./ClientList";
import ClientProfile from "./ClientProfile";
import GroupPanel from "./GroupPanel";
import ImportStripeCustomer from "./ImportStripeCustomer";
import InvoicesDuePanel from "./InvoicesDuePanel";
import PaymentReports from "./PaymentReports";
import SettingsPanel from "./SettingsPanel";
import Toast from "./Toast";
import StatusBadge from "./shared/StatusBadge";
import { useSetupStatus } from "../../hooks/useSetupStatus";

const DFWSC_TABS = [
  { id: "due", label: "Due" },
  { id: "clients", label: "Clients" },
  { id: "invoices", label: "Invoices" },
  { id: "settings", label: "Settings" },
];

const PORTAL_TABS = [
  { id: "clients", label: "Accounts" },
  { id: "groups", label: "Companies" },
  { id: "reports", label: "Reports" },
  { id: "invoices", label: "Invoices" },
  { id: "settings", label: "Settings" },
];

function paymentHealthForClient(client) {
  if (client.status === "inactive" || client.suspendedAt) return "canceled";
  return client.paymentStatus ?? "none";
}

function DfwscClientsPanel({ onSelectClient, onAddClient }) {
  const { data: clients = [], isLoading, isError, error } = useClients({ workspace: "dfwsc_services" });
  const [statusFilter, setStatusFilter] = useState("all");

  const lifecycleCounts = useMemo(() => {
    return clients.reduce(
      (acc, client) => {
        if (client.status === "lead") {
          acc.lead += 1;
        } else if (client.status === "inactive") {
          acc.inactive += 1;
        } else {
          acc.client += 1;
        }
        acc.total += 1;
        return acc;
      },
      { total: 0, lead: 0, client: 0, inactive: 0 }
    );
  }, [clients]);

  const rows = useMemo(() => {
    const scoped =
      statusFilter === "all" ? clients : clients.filter((client) => client.status === statusFilter);
    return [...scoped].sort((a, b) => a.name.localeCompare(b.name));
  }, [clients, statusFilter]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-md font-semibold text-white">Clients</h4>
        <button
          type="button"
          onClick={onAddClient}
          className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Add Client
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setStatusFilter("all")}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
            statusFilter === "all" ? "bg-blue-600 text-white" : "bg-gray-700 text-gray-200 hover:bg-gray-600"
          }`}
        >
          All ({lifecycleCounts.total})
        </button>
        <button
          type="button"
          onClick={() => setStatusFilter("lead")}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
            statusFilter === "lead" ? "bg-purple-700 text-white" : "bg-gray-700 text-gray-200 hover:bg-gray-600"
          }`}
        >
          Leads ({lifecycleCounts.lead})
        </button>
        <button
          type="button"
          onClick={() => setStatusFilter("active")}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
            statusFilter === "active" ? "bg-emerald-700 text-white" : "bg-gray-700 text-gray-200 hover:bg-gray-600"
          }`}
        >
          Clients ({lifecycleCounts.client})
        </button>
        <button
          type="button"
          onClick={() => setStatusFilter("inactive")}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
            statusFilter === "inactive" ? "bg-rose-700 text-white" : "bg-gray-700 text-gray-200 hover:bg-gray-600"
          }`}
        >
          Inactive ({lifecycleCounts.inactive})
        </button>
      </div>

      {isLoading && <p className="text-sm text-gray-400">Loading clients...</p>}
      {isError && <p className="text-sm text-red-400">{error?.message}</p>}

      {!isLoading && !isError && rows.length === 0 && (
        <p className="text-sm text-gray-400">No clients yet.</p>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-700">
            <thead>
              <tr>
                {["Client", "Email", "Health", "Status"].map((h) => (
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
              {rows.map((client) => (
                <tr
                  key={client.id}
                  className="cursor-pointer hover:bg-gray-700/40"
                  onClick={() => onSelectClient(client.id)}
                >
                  <td className="px-3 py-2 text-sm text-blue-400">{client.name}</td>
                  <td className="px-3 py-2 text-sm text-gray-200">{client.email}</td>
                  <td className="px-3 py-2 text-sm">
                    <StatusBadge status={paymentHealthForClient(client)} />
                  </td>
                  <td className="px-3 py-2 text-sm">
                    <StatusBadge status={client.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

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

  const [workspace, setWorkspace] = useState("dfwsc_services");
  const [activeTab, setActiveTab] = useState("due");
  const [selectedClientId, setSelectedClientId] = useState(null);
  const [previousTab, setPreviousTab] = useState("due");
  const [showAddClientModal, setShowAddClientModal] = useState(false);
  const [billingSubTab, setBillingSubTab] = useState("invoices");
  const [preselectedClient, setPreselectedClient] = useState(null);
  const [toast, setToast] = useState({ show: false, message: "", type: "" });

  const isDfwscMode = workspace === "dfwsc_services";
  const tabs = isDfwscMode ? DFWSC_TABS : PORTAL_TABS;

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
    setActiveTab("due");
    setSelectedClientId(null);
  }, [logout]);

  const openClientProfile = useCallback(
    (clientId) => {
      setPreviousTab(activeTab);
      setSelectedClientId(clientId);
    },
    [activeTab]
  );

  const closeClientProfile = useCallback(() => {
    setSelectedClientId(null);
    setActiveTab(previousTab);
  }, [previousTab]);

  const handleWorkspaceChange = useCallback((nextWorkspace) => {
    setWorkspace(nextWorkspace);
    setSelectedClientId(null);
    setShowAddClientModal(false);
    setPreselectedClient(null);
    setActiveTab(nextWorkspace === "dfwsc_services" ? "due" : "clients");
  }, []);

  const handleCreateInvoiceFromProfile = useCallback((client) => {
    setPreselectedClient(client);
    setBillingSubTab("invoices");
    setSelectedClientId(null);
    setActiveTab("invoices");
  }, []);

  const handleCreateSubscriptionFromProfile = useCallback((client) => {
    setPreselectedClient(client);
    setBillingSubTab("subscriptions");
    setSelectedClientId(null);
    setActiveTab("invoices");
  }, []);

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

      <div className="bg-gray-800/80 p-1 rounded-xl border border-gray-700 flex max-w-xl mx-auto mb-6 shadow-inner gap-1">
        <button
          type="button"
          onClick={() => handleWorkspaceChange("dfwsc_services")}
          className={`flex-1 py-2 px-4 rounded-lg text-sm font-bold transition-all duration-200 ${
            isDfwscMode ? "bg-blue-600 text-white shadow-lg scale-[1.02]" : "text-gray-400 hover:text-gray-200"
          }`}
        >
          DFWSC Services
        </button>
        <button
          type="button"
          onClick={() => handleWorkspaceChange("client_portal")}
          className={`flex-1 py-2 px-4 rounded-lg text-sm font-bold transition-all duration-200 ${
            workspace === "client_portal"
              ? "bg-indigo-600 text-white shadow-lg scale-[1.02]"
              : "text-gray-400 hover:text-gray-200"
          }`}
        >
          Client Portal
        </button>
      </div>

      {!selectedClientId && (
        <div className="flex border-b border-gray-700 mb-6">
          {tabs.map((tab) => (
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
      )}

      {isDfwscMode && selectedClientId && (
        <ClientProfile
          clientId={selectedClientId}
          workspace="dfwsc_services"
          onBack={closeClientProfile}
          onCreateInvoice={handleCreateInvoiceFromProfile}
          onCreateSubscription={handleCreateSubscriptionFromProfile}
          showToast={showToast}
        />
      )}

      {isDfwscMode && !selectedClientId && activeTab === "due" && (
        <InvoicesDuePanel showToast={showToast} onSelectClient={openClientProfile} />
      )}

      {isDfwscMode && !selectedClientId && activeTab === "clients" && (
        <DfwscClientsPanel
          onSelectClient={openClientProfile}
          onAddClient={() => setShowAddClientModal(true)}
        />
      )}

      {activeTab === "invoices" && (
        <BillingPanel
          showToast={showToast}
          workspace={workspace}
          isDfwscMode={isDfwscMode}
          initialSubTab={billingSubTab}
          preselectedClient={preselectedClient}
        />
      )}

      {!isDfwscMode && activeTab === "clients" && (
        <>
          <div className="flex gap-4 mb-4">
            <ImportStripeCustomer showToast={showToast} workspace={workspace} />
          </div>
          <ClientList showToast={showToast} workspace={workspace} />
        </>
      )}

      {!isDfwscMode && activeTab === "groups" && (
        <GroupPanel showToast={showToast} workspace={workspace} />
      )}

      {!isDfwscMode && activeTab === "reports" && (
        <PaymentReports showToast={showToast} workspace={workspace} />
      )}

      {activeTab === "settings" && <SettingsPanel showToast={showToast} />}

      <AddClientModal
        isOpen={showAddClientModal}
        onClose={() => setShowAddClientModal(false)}
        onCreated={(client) => {
          setPreselectedClient(client);
          setShowAddClientModal(false);
        }}
        showToast={showToast}
      />

      <Toast show={toast.show} message={toast.message} type={toast.type} onClose={hideToast} />
    </div>
  );
}
