import { useState, useEffect, useCallback } from "react";
import Toast from "./Toast";
import AdminLogin from "./AdminLogin";
import CreateClientForm from "./CreateClientForm";
import ClientList from "./ClientList";

export default function AdminDashboard() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [clients, setClients] = useState([]);
  const [clientsLoading, setClientsLoading] = useState(false);
  const [clientsError, setClientsError] = useState("");
  const [toast, setToast] = useState({ show: false, message: "", type: "" });

  useEffect(() => {
    const storedToken = sessionStorage.getItem("adminToken");
    if (storedToken) {
      setIsLoggedIn(true);
    }
  }, []);

  useEffect(() => {
    if (isLoggedIn) {
      fetchClients();
    }
  }, [isLoggedIn]);

  const showToast = useCallback((message, type = "info") => {
    setToast({ show: true, message, type });
  }, []);

  const hideToast = useCallback(() => {
    setToast({ show: false, message: "", type: "" });
  }, []);

  const fetchClients = useCallback(async () => {
    const token = sessionStorage.getItem("adminToken");
    if (!token) {
      setIsLoggedIn(false);
      return;
    }

    setClientsLoading(true);
    setClientsError("");

    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/v1/clients`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          sessionStorage.removeItem("adminToken");
          setIsLoggedIn(false);
          throw new Error("Session expired. Please log in again.");
        }

        const errorData = await res
          .json()
          .catch(() => ({ error: "Failed to fetch clients" }));
        throw new Error(
          errorData.error || `HTTP ${res.status}: ${res.statusText}`
        );
      }

      const data = await res.json();
      setClients(data);
    } catch (err) {
      console.error("Error fetching clients:", err);
      setClientsError(err.message);
    } finally {
      setClientsLoading(false);
    }
  }, []);

  const handleLoginSuccess = useCallback(() => {
    setIsLoggedIn(true);
  }, []);

  const handleLogout = useCallback(() => {
    sessionStorage.removeItem("adminToken");
    setIsLoggedIn(false);
    setClients([]);
    setClientsError("");
  }, []);

  const handleClientCreated = useCallback(() => {
    fetchClients();
  }, [fetchClients]);

  const handleStatusChange = useCallback((clientId, newStatus) => {
    setClients((prevClients) =>
      prevClients.map((client) =>
        client.id === clientId ? { ...client, status: newStatus } : client
      )
    );
  }, []);

  if (!isLoggedIn) {
    return (
      <>
        <AdminLogin onLoginSuccess={handleLoginSuccess} showToast={showToast} />
        <Toast
          show={toast.show}
          message={toast.message}
          type={toast.type}
          onClose={hideToast}
        />
      </>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-lg font-semibold text-white">Welcome, Admin!</h3>
        <button
          onClick={handleLogout}
          className="text-sm bg-red-600 hover:bg-red-700 text-white py-1 px-3 rounded-md transition-colors"
        >
          Logout
        </button>
      </div>

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
          onStatusChange={handleStatusChange}
          showToast={showToast}
          onSessionExpired={handleLogout}
          loading={clientsLoading}
          error={clientsError}
          onRefresh={fetchClients}
        />
      </div>

      <Toast
        show={toast.show}
        message={toast.message}
        type={toast.type}
        onClose={hideToast}
      />
    </div>
  );
}
