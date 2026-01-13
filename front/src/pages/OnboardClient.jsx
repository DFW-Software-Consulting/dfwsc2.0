import { useState, useEffect } from "react";

export default function OnboardClient() {
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  // Admin state
  const [adminUsername, setAdminUsername] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminError, setAdminError] = useState("");
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [adminLoading, setAdminLoading] = useState(false);

  // Client list state
  const [clients, setClients] = useState([]);
  const [clientsLoading, setClientsLoading] = useState(false);
  const [clientsError, setClientsError] = useState("");

  // Create client state
  const [newClientName, setNewClientName] = useState("");
  const [newClientEmail, setNewClientEmail] = useState("");
  const [createClientLoading, setCreateClientLoading] = useState(false);
  const [createClientError, setCreateClientError] = useState("");
  const [createdClientInfo, setCreatedClientInfo] = useState(null);
  const [copySuccess, setCopySuccess] = useState("");

  // Toast notifications
  const [toast, setToast] = useState({ show: false, message: "", type: "" });

  useEffect(() => {
    document.title = "Client Stripe Onboarding";
    const urlParams = new URLSearchParams(window.location.search);
    const tokenFromUrl = urlParams.get("token");
    if (tokenFromUrl) setToken(tokenFromUrl);

    // Check if admin is already logged in
    const storedToken = sessionStorage.getItem('adminToken');
    if (storedToken) {
      setIsLoggedIn(true);
    }
  }, []);

  useEffect(() => {
    if (isLoggedIn) {
      fetchClients();
    }
  }, [isLoggedIn]);

  const fetchClients = async () => {
    const token = sessionStorage.getItem('adminToken');
    if (!token) {
      setIsLoggedIn(false);
      return;
    }

    setClientsLoading(true);
    setClientsError("");

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/v1/clients`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          // Unauthorized - clear token and log out
          sessionStorage.removeItem('adminToken');
          setIsLoggedIn(false);
          throw new Error('Session expired. Please log in again.');
        }

        const errorData = await res.json().catch(() => ({ error: 'Failed to fetch clients' }));
        throw new Error(errorData.error || `HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();
      setClients(data);
    } catch (err) {
      console.error('Error fetching clients:', err);
      setClientsError(err.message);
    } finally {
      setClientsLoading(false);
    }
  };

  const handleCreateClient = async (e) => {
    e.preventDefault();
    if (!newClientName.trim() || !newClientEmail.trim()) {
      setCreateClientError("Name and email are required");
      return;
    }

    setCreateClientLoading(true);
    setCreateClientError("");
    setCreatedClientInfo(null);

    try {
      const token = sessionStorage.getItem('adminToken');
      const res = await fetch(`${import.meta.env.VITE_API_URL}/v1/accounts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: newClientName.trim(),
          email: newClientEmail.trim(),
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'Failed to create client' }));
        throw new Error(errorData.error || `HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();
      setCreatedClientInfo(data);
      setNewClientName("");
      setNewClientEmail("");

      // Show success message
      showToast(`Client ${data.name} created successfully!`, "success");

      // Refresh the client list
      await fetchClients();
    } catch (err) {
      console.error('Error creating client:', err);
      setCreateClientError(err.message);
      showToast(`Error creating client: ${err.message}`, "error");
    } finally {
      setCreateClientLoading(false);
    }
  };

  const showToast = (message, type = "info") => {
    setToast({ show: true, message, type });
    setTimeout(() => {
      setToast({ show: false, message: "", type: "" });
    }, 5000);
  };

  const copyToClipboard = async (text, type) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`${type} copied to clipboard!`, "success");
    } catch (err) {
      console.error(`Failed to copy ${type}:`, err);
      showToast(`Failed to copy ${type}`, "error");
    }
  };

  const updateClientStatus = async (clientId, currentStatus) => {
    const token = sessionStorage.getItem('adminToken');
    if (!token) {
      setIsLoggedIn(false);
      return;
    }

    // Optimistic update: immediately update the UI
    const newStatus = currentStatus === 'active' ? 'inactive' : 'active';
    setClients(prevClients =>
      prevClients.map(client =>
        client.id === clientId ? { ...client, status: newStatus } : client
      )
    );

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/v1/clients/${clientId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          status: newStatus,
        }),
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          // Unauthorized - clear token and log out
          sessionStorage.removeItem('adminToken');
          setIsLoggedIn(false);
          throw new Error('Session expired. Please log in again.');
        } else if (res.status === 404) {
          throw new Error('Client not found');
        }

        const errorData = await res.json().catch(() => ({ error: 'Failed to update client status' }));
        throw new Error(errorData.error || `HTTP ${res.status}: ${res.statusText}`);
      }

      // Success - status is already updated optimistically
    } catch (err) {
      console.error('Error updating client status:', err);

      // Rollback: revert the optimistic update
      setClients(prevClients =>
        prevClients.map(client =>
          client.id === clientId ? { ...client, status: currentStatus } : client
        )
      );

      // Show error to user
      showToast(`Error updating client status: ${err.message}`, "error");
    }
  };

  const handleSubmit = async () => {
    if (!token) {
      setMessage("Please enter your onboarding token.");
      return;
    }
    setLoading(true);
    setMessage("Verifying token and redirecting...");

    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/v1/onboard-client?token=${encodeURIComponent(token)}`,
        {
          headers: {
            Accept: "application/json",
            "ngrok-skip-browser-warning": "true",
          },
        }
      );

      const contentType = res.headers.get("content-type") || "";
      const isJson = contentType.includes("application/json");

      if (!res.ok) {
        // Try to read error details
        const errPayload = isJson ? await res.json().catch(() => ({})) : await res.text();
        const errText =
          typeof errPayload === "string"
            ? errPayload.slice(0, 200) // show a snippet if it's HTML
            : errPayload.error || errPayload.message || `HTTP ${res.status}`;
        throw new Error(errText);
      }

      // OK, but make sure it's JSON
      if (!isJson) {
        const text = await res.text();
        throw new Error(`Expected JSON but got: ${text.slice(0, 200)}…`);
      }

      const data = await res.json();
      if (!data?.url) {
        throw new Error("API did not return a 'url' field.");
      }

      setMessage("Redirecting to Stripe...");
      window.location.href = data.url;
    } catch (err) {
      console.error("Onboarding error:", err);
      setMessage(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleAdminLogin = async (e) => {
    e.preventDefault();
    setAdminLoading(true);
    setAdminError("");

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/v1/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: adminUsername,
          password: adminPassword,
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'Invalid credentials' }));
        throw new Error(errorData.error || 'Login failed');
      }

      const data = await res.json();
      if (data.token) {
        sessionStorage.setItem('adminToken', data.token);
        setIsLoggedIn(true);
        setAdminUsername('');
        setAdminPassword('');
      } else {
        throw new Error('Login response did not contain token');
      }
    } catch (err) {
      console.error('Admin login error:', err);
      setAdminError(err.message || 'Login failed');
    } finally {
      setAdminLoading(false);
    }
  };

  const handleLogout = () => {
    sessionStorage.removeItem('adminToken');
    setIsLoggedIn(false);
    setAdminError('');
  };

  const isError = message.startsWith("Error");

  return (
    <section
      className="min-h-[90vh] flex items-center justify-center
                 bg-gradient-to-b from-gray-900 via-gray-800 to-gray-900
                 text-gray-100 p-4"
    >
      <div className="w-full max-w-6xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Client Token Entry Section */}
          <div className="bg-gray-800/60 backdrop-blur-md p-8 rounded-2xl shadow-xl border border-gray-700">
            <h1 className="text-3xl font-bold text-center mb-4 text-white">
              Stripe Account Setup
            </h1>

            <p className="text-center text-gray-300 mb-8">
              Please enter the onboarding token provided by{" "}
              <span className="text-blue-400 font-semibold">
                DFW Software Consulting
              </span>{" "}
              to set up your Stripe account.
            </p>

            <div className="mb-6">
              <label
                htmlFor="onboardingToken"
                className="block text-sm font-semibold text-gray-200 mb-2"
              >
                Onboarding Token
              </label>
              <input
                id="onboardingToken"
                type="text"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Enter your token"
                className="block w-full rounded-md border border-gray-600 bg-gray-900/50
                           px-3 py-2 text-gray-100 placeholder-gray-500 shadow-sm
                           focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <button
              onClick={handleSubmit}
              disabled={loading}
              className="mt-6 w-full rounded-md bg-blue-600 hover:bg-blue-700
                         text-white font-semibold py-2 px-4 shadow-lg
                         transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-blue-400
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "Processing..." : "Continue to Stripe Setup"}
            </button>

            {message && (
              <p
                className={`mt-4 text-center text-sm ${isError ? "text-red-400" : "text-blue-400"
                  }`}
              >
                {message}
              </p>
            )}
          </div>

          {/* Admin Section */}
          <div className="bg-gray-800/60 backdrop-blur-md p-8 rounded-2xl shadow-xl border border-gray-700">
            <h2 className="text-2xl font-bold text-center mb-4 text-white">
              {isLoggedIn ? "Admin Dashboard" : "Admin Login"}
            </h2>

            {!isLoggedIn ? (
              <form onSubmit={handleAdminLogin}>
                <div className="mb-4">
                  <label
                    htmlFor="adminUsername"
                    className="block text-sm font-semibold text-gray-200 mb-2"
                  >
                    Username
                  </label>
                  <input
                    id="adminUsername"
                    type="text"
                    value={adminUsername}
                    onChange={(e) => setAdminUsername(e.target.value)}
                    placeholder="Enter admin username"
                    className="block w-full rounded-md border border-gray-600 bg-gray-900/50
                               px-3 py-2 text-gray-100 placeholder-gray-500 shadow-sm
                               focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    required
                  />
                </div>

                <div className="mb-6">
                  <label
                    htmlFor="adminPassword"
                    className="block text-sm font-semibold text-gray-200 mb-2"
                  >
                    Password
                  </label>
                  <input
                    id="adminPassword"
                    type="password"
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    placeholder="Enter admin password"
                    className="block w-full rounded-md border border-gray-600 bg-gray-900/50
                               px-3 py-2 text-gray-100 placeholder-gray-500 shadow-sm
                               focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    required
                  />
                </div>

                <button
                  type="submit"
                  disabled={adminLoading}
                  className="w-full rounded-md bg-green-600 hover:bg-green-700
                             text-white font-semibold py-2 px-4 shadow-lg
                             transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-green-400
                             disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {adminLoading ? "Logging in..." : "Log In"}
                </button>

                {adminError && (
                  <p className="mt-4 text-center text-sm text-red-400">
                    {adminError}
                  </p>
                )}
              </form>
            ) : (
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

                {/* Create Client Form */}
                <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
                  <h4 className="text-md font-semibold text-white mb-3">Create New Client</h4>

                  <form onSubmit={handleCreateClient}>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                      <div>
                        <label
                          htmlFor="newClientName"
                          className="block text-sm font-medium text-gray-300 mb-1"
                        >
                          Client Name
                        </label>
                        <input
                          id="newClientName"
                          type="text"
                          value={newClientName}
                          onChange={(e) => setNewClientName(e.target.value)}
                          placeholder="Enter client name"
                          className="w-full rounded-md border border-gray-600 bg-gray-900/50
                                     px-3 py-2 text-gray-100 placeholder-gray-500
                                     focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          disabled={createClientLoading}
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="newClientEmail"
                          className="block text-sm font-medium text-gray-300 mb-1"
                        >
                          Client Email
                        </label>
                        <input
                          id="newClientEmail"
                          type="email"
                          value={newClientEmail}
                          onChange={(e) => setNewClientEmail(e.target.value)}
                          placeholder="Enter client email"
                          className="w-full rounded-md border border-gray-600 bg-gray-900/50
                                     px-3 py-2 text-gray-100 placeholder-gray-500
                                     focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          disabled={createClientLoading}
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={createClientLoading || !newClientName.trim() || !newClientEmail.trim()}
                      className="w-full md:w-auto rounded-md bg-blue-600 hover:bg-blue-700
                                 text-white font-semibold py-2 px-4 shadow-lg
                                 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-blue-400
                                 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {createClientLoading ? "Creating..." : "Create Client"}
                    </button>

                    {createClientError && (
                      <p className="mt-2 text-sm text-red-400">{createClientError}</p>
                    )}
                  </form>

                  {/* Display created client info */}
                  {createdClientInfo && (
                    <div className="mt-4 p-4 bg-gray-800/50 rounded-lg border border-gray-600">
                      <h5 className="font-semibold text-green-400 mb-2">Client Created Successfully!</h5>

                      <div className="mb-3">
                        <p className="text-sm text-gray-300 mb-1"><strong>Onboarding Token:</strong></p>
                        <div className="flex items-center">
                          <code className="flex-1 bg-gray-900/50 text-green-300 p-2 rounded break-all mr-2">
                            {createdClientInfo.onboardingToken}
                          </code>
                          <button
                            onClick={() => copyToClipboard(createdClientInfo.onboardingToken, 'Token')}
                            className="text-sm bg-gray-700 hover:bg-gray-600 text-white py-1 px-3 rounded transition-colors"
                          >
                            Copy
                          </button>
                        </div>
                      </div>

                      <div>
                        <p className="text-sm text-gray-300 mb-1"><strong>Onboarding URL:</strong></p>
                        <div className="flex items-center">
                          <code className="flex-1 bg-gray-900/50 text-blue-300 p-2 rounded break-all mr-2">
                            {createdClientInfo.onboardingUrlHint}
                          </code>
                          <button
                            onClick={() => copyToClipboard(createdClientInfo.onboardingUrlHint, 'URL')}
                            className="text-sm bg-gray-700 hover:bg-gray-600 text-white py-1 px-3 rounded transition-colors"
                          >
                            Copy
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {copySuccess && (
                    <div className="mt-2 text-sm text-green-400">{copySuccess}</div>
                  )}
                </div>

                {/* Client List */}
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

                  {clientsLoading ? (
                    <div className="text-center py-8">
                      <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500"></div>
                      <p className="mt-3 text-gray-300">Loading clients...</p>
                    </div>
                  ) : clientsError ? (
                    <div className="text-center py-4">
                      <p className="text-red-400">{clientsError}</p>
                      <button
                        onClick={fetchClients}
                        className="mt-3 text-sm bg-blue-600 hover:bg-blue-700 text-white py-1 px-3 rounded-md transition-colors"
                      >
                        Retry
                      </button>
                    </div>
                  ) : clients.length === 0 ? (
                    <div className="text-center py-8">
                      <p className="text-gray-300">No clients yet</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="min-w-full divide-y divide-gray-700">
                        <thead>
                          <tr>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">Name</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">Email</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">Status</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">Stripe Account</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-800">
                          {clients.map((client) => (
                            <tr key={client.id} className="hover:bg-gray-700/50">
                              <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-200">{client.name}</td>
                              <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-200">{client.email}</td>
                              <td className="px-3 py-2 whitespace-nowrap text-sm">
                                <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                                  client.status === 'active'
                                    ? 'bg-green-800 text-green-200'
                                    : 'bg-red-800 text-red-200'
                                }`}>
                                  {client.status.charAt(0).toUpperCase() + client.status.slice(1)}
                                </span>
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-200">
                                {client.stripeAccountId || 'N/A'}
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap text-sm">
                                <button
                                  onClick={() => updateClientStatus(client.id, client.status)}
                                  className={`px-3 py-1 rounded text-xs font-medium ${
                                    client.status === 'active'
                                      ? 'bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 disabled:cursor-not-allowed'
                                      : 'bg-green-600 hover:bg-green-700 text-white disabled:opacity-50 disabled:cursor-not-allowed'
                                  }`}
                                  title={`${client.status === 'active' ? 'Deactivate' : 'Activate'} client`}
                                >
                                  {client.status === 'active' ? 'Deactivate' : 'Activate'}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Toast notifications */}
                {toast.show && (
                  <div className={`fixed bottom-4 right-4 px-6 py-3 rounded-md shadow-lg text-white font-medium z-50 ${
                    toast.type === 'success' ? 'bg-green-600' :
                    toast.type === 'error' ? 'bg-red-600' :
                    toast.type === 'warning' ? 'bg-yellow-600' : 'bg-blue-600'
                  }`}>
                    {toast.message}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
