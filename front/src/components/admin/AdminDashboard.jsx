import { useState, useEffect, useCallback } from "react";
import Toast from "./Toast";
import AdminLogin from "./AdminLogin";
import AdminSetup from "./AdminSetup";
import CreateClientForm from "./CreateClientForm";
import ClientList from "./ClientList";
import GroupPanel from "./GroupPanel";
import PaymentReports from "./PaymentReports";
import logger from "../../utils/logger";

const TABS = [
  { id: "clients", label: "Clients" },
  { id: "groups", label: "Groups" },
  { id: "reports", label: "Reports" },
];

export default function AdminDashboard() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [setupAllowed, setSetupAllowed] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("clients");

  const [clients, setClients] = useState([]);
  const [clientsLoading, setClientsLoading] = useState(false);
  const [clientsError, setClientsError] = useState("");

  const [groups, setGroups] = useState([]);

  const [toast, setToast] = useState({ show: false, message: "", type: "" });

  const showToast = useCallback((message, type = "info") => {
    setToast({ show: true, message, type });
  }, []);

  const hideToast = useCallback(() => {
    setToast({ show: false, message: "", type: "" });
  }, []);

  const fetchClients = useCallback(async () => {
    const token = sessionStorage.getItem("adminToken");
    if (!token) {
      showToast("Session expired. You have been logged out.", "warning");
      setIsLoggedIn(false);
      return;
    }

    setClientsLoading(true);
    setClientsError("");

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/clients`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          sessionStorage.removeItem("adminToken");
          showToast("Session expired. You have been logged out.", "warning");
          setIsLoggedIn(false);
          throw new Error("Session expired. Please log in again.");
        }
        const errorData = await res
          .json()
          .catch(() => ({ error: "Failed to fetch clients" }));
        throw new Error(errorData.error || `HTTP ${res.status}: ${res.statusText}`);
      }

      setClients(await res.json());
    } catch (err) {
      logger.error("Error fetching clients:", err);
      setClientsError(err.message);
    } finally {
      setClientsLoading(false);
    }
  }, [showToast]);

  const checkSetupStatus = useCallback(async () => {
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/auth/setup/status`);
      if (res.ok) {
        const data = await res.json();
        setSetupAllowed(data.setupAllowed);
      }
    } catch (err) {
      logger.error("Error checking setup status:", err);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    const storedToken = sessionStorage.getItem("adminToken");
    if (storedToken) {
      setIsLoggedIn(true);
      setStatusLoading(false);
      fetchClients();
    } else {
      checkSetupStatus();
    }
  }, [fetchClients, checkSetupStatus]);

  const handleSetupComplete = useCallback(() => {
    setSetupAllowed(false);
    checkSetupStatus();
  }, [checkSetupStatus]);

  const handleLoginSuccess = useCallback(() => {
    setIsLoggedIn(true);
    fetchClients();
  }, [fetchClients]);

  const handleLogout = useCallback(() => {
    sessionStorage.removeItem("adminToken");
    setIsLoggedIn(false);
    setClients([]);
    setClientsError("");
    setGroups([]);
    setActiveTab("clients");
  }, []);

  const handleClientCreated = useCallback(() => {
    fetchClients();
  }, [fetchClients]);

  const handleStatusChange = useCallback((clientId, newStatus) => {
    setClients((prev) =>
      prev.map((c) => (c.id === clientId ? { ...c, status: newStatus } : c)),
    );
  }, []);

  const handleClientUpdated = useCallback((updated) => {
    setClients((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  }, []);

  const handleGroupsChanged = useCallback((updatedGroups) => {
    setGroups(updatedGroups);
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
    return (
      <>
        {setupAllowed ? (
          <AdminSetup onSetupComplete={handleSetupComplete} showToast={showToast} />
        ) : (
          <AdminLogin onLoginSuccess={handleLoginSuccess} showToast={showToast} />
        )}
        <Toast
          show={toast.show}
          message={toast.message}
          type={toast.type}
          onClose={hideToast}
        />
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
          <CreateClientForm
            onClientCreated={handleClientCreated}
            showToast={showToast}
          />
          <div className="mb-6">
            <div className="flex justify-between items-center mb-3">
              <h4 className="text-md font-semibold text-white">Client List</h4>
              <button
                onClick={fetchClients}
                className="text-sm bg-gray-700 hover:bg-gray-600 text-white py-1 px-3 rounded-md transition-colors"
              >
                Refresh
              </button>
            </div>
            <ClientList
              clients={clients}
              groups={groups}
              onStatusChange={handleStatusChange}
              onClientUpdated={handleClientUpdated}
              showToast={showToast}
              onSessionExpired={handleLogout}
              loading={clientsLoading}
              error={clientsError}
              onRefresh={fetchClients}
            />
          </div>
        </>
      )}

      {/* Groups tab */}
      {activeTab === "groups" && (
        <GroupPanel
          showToast={showToast}
          onSessionExpired={handleLogout}
          onGroupsChanged={handleGroupsChanged}
          onClientUpdated={handleClientUpdated}
        />
      )}

      {/* Reports tab */}
      {activeTab === "reports" && (
        <PaymentReports
          clients={clients}
          groups={groups}
          showToast={showToast}
          onSessionExpired={handleLogout}
        />
      )}

      <Toast
        show={toast.show}
        message={toast.message}
        type={toast.type}
        onClose={hideToast}
      />
    </div>
  );
}
