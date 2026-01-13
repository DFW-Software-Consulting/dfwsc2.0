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

                <div className="mb-6">
                  <h4 className="text-md font-semibold text-white mb-3">Client List</h4>

                  {clientsLoading ? (
                    <div className="text-center py-4">
                      <div className="inline-block animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-blue-500"></div>
                      <p className="mt-2 text-gray-300">Loading clients...</p>
                    </div>
                  ) : clientsError ? (
                    <div className="text-center py-4">
                      <p className="text-red-400">{clientsError}</p>
                      <button
                        onClick={fetchClients}
                        className="mt-2 text-sm bg-blue-600 hover:bg-blue-700 text-white py-1 px-3 rounded-md transition-colors"
                      >
                        Retry
                      </button>
                    </div>
                  ) : clients.length === 0 ? (
                    <div className="text-center py-4">
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
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
