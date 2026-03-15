import { useCallback, useEffect, useState } from "react";
import logger from "../../utils/logger";

const API = import.meta.env.VITE_API_URL;

function StatusBadge({ status }) {
  const styles = {
    pending: "bg-yellow-800 text-yellow-200",
    paid: "bg-green-800 text-green-200",
    cancelled: "bg-red-800 text-red-200",
    active: "bg-green-800 text-green-200",
    paused: "bg-yellow-800 text-yellow-200",
    completed: "bg-blue-800 text-blue-200",
  };
  return (
    <span
      className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${styles[status] ?? "bg-gray-700 text-gray-200"}`}
    >
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

// ─── Invoices Sub-Tab ────────────────────────────────────────────────────────

function InvoicesTab({ clients, showToast, onSessionExpired }) {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Form state
  const [clientId, setClientId] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState("");

  const authHeader = () => {
    const token = sessionStorage.getItem("adminToken");
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  };

  const fetchInvoices = useCallback(async () => {
    const token = sessionStorage.getItem("adminToken");
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API}/invoices`, { headers: authHeader() });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          onSessionExpired?.();
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      setInvoices(await res.json());
    } catch (err) {
      logger.error("Error fetching invoices:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [onSessionExpired]);

  useEffect(() => {
    fetchInvoices();
  }, [fetchInvoices]);

  const handleCreate = useCallback(
    async (e) => {
      e.preventDefault();
      setFormError("");
      const amountCents = Math.round(parseFloat(amount) * 100);
      if (!clientId) return setFormError("Select a client.");
      if (Number.isNaN(amountCents) || amountCents <= 0)
        return setFormError("Enter a valid amount.");
      if (!description.trim()) return setFormError("Description is required.");

      setCreating(true);
      try {
        const res = await fetch(`${API}/invoices`, {
          method: "POST",
          headers: authHeader(),
          body: JSON.stringify({
            clientId,
            amountCents,
            description: description.trim(),
            dueDate: dueDate || null,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setInvoices((prev) => [data, ...prev]);
        setClientId("");
        setAmount("");
        setDescription("");
        setDueDate("");
        showToast?.("Invoice created and email sent.", "success");
      } catch (err) {
        logger.error("Error creating invoice:", err);
        setFormError(err.message);
      } finally {
        setCreating(false);
      }
    },
    [clientId, amount, description, dueDate, showToast]
  );

  const handleCancel = useCallback(
    async (id) => {
      try {
        const res = await fetch(`${API}/invoices/${id}`, {
          method: "PATCH",
          headers: authHeader(),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setInvoices((prev) => prev.map((inv) => (inv.id === id ? data : inv)));
        showToast?.("Invoice cancelled.", "success");
      } catch (err) {
        logger.error("Error cancelling invoice:", err);
        showToast?.(err.message, "error");
      }
    },
    [showToast]
  );

  const handleCopyLink = useCallback(
    (token) => {
      const url = `${window.location.origin}/pay/${token}`;
      navigator.clipboard.writeText(url).then(() => {
        showToast?.("Payment link copied.", "success");
      });
    },
    [showToast]
  );

  return (
    <div>
      {/* Create form */}
      <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
        <h4 className="text-md font-semibold text-white mb-3">New Invoice</h4>
        <form onSubmit={handleCreate} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="inv-client" className="block text-sm text-gray-300 mb-1">
              Client
            </label>
            <select
              id="inv-client"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={creating}
            >
              <option value="">Select client…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="inv-amount" className="block text-sm text-gray-300 mb-1">
              Amount ($)
            </label>
            <input
              id="inv-amount"
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 99.00"
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={creating}
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="inv-desc" className="block text-sm text-gray-300 mb-1">
              Description
            </label>
            <input
              id="inv-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Website maintenance — March 2026"
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={creating}
            />
          </div>
          <div>
            <label htmlFor="inv-due" className="block text-sm text-gray-300 mb-1">
              Due Date (optional)
            </label>
            <input
              id="inv-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={creating}
            />
          </div>
          <div className="flex items-end">
            {formError && (
              <p className="text-sm text-red-400 mr-3" role="alert">
                {formError}
              </p>
            )}
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-medium
                         transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creating ? "Creating..." : "Create Invoice"}
            </button>
          </div>
        </form>
      </div>

      {/* List */}
      <div className="flex justify-between items-center mb-3">
        <h4 className="text-md font-semibold text-white">Invoices</h4>
        <button
          type="button"
          onClick={fetchInvoices}
          className="text-sm bg-gray-700 hover:bg-gray-600 text-white py-1 px-3 rounded-md transition-colors"
        >
          Refresh
        </button>
      </div>

      {loading && (
        <div className="text-center py-8">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500" />
          <p className="mt-3 text-gray-300">Loading invoices...</p>
        </div>
      )}
      {error && <p className="text-red-400 text-sm py-4 text-center">{error}</p>}
      {!loading && !error && invoices.length === 0 && (
        <p className="text-gray-400 text-sm py-4 text-center">No invoices yet</p>
      )}

      {invoices.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-700">
            <thead>
              <tr>
                {["Client", "Description", "Amount", "Due", "Status", "Actions"].map((h) => (
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
              {invoices.map((inv) => (
                <tr key={inv.id} className="hover:bg-gray-700/50">
                  <td className="px-3 py-2 text-sm text-gray-200">{inv.clientName ?? "—"}</td>
                  <td className="px-3 py-2 text-sm text-gray-200 max-w-xs truncate">
                    {inv.description}
                  </td>
                  <td className="px-3 py-2 text-sm text-gray-200">
                    ${(inv.amountCents / 100).toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-sm text-gray-400">
                    {inv.dueDate
                      ? new Date(inv.dueDate).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-sm">
                    <StatusBadge status={inv.status} />
                  </td>
                  <td className="px-3 py-2 text-sm">
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => handleCopyLink(inv.paymentToken)}
                        className="px-2 py-1 rounded text-xs bg-gray-600 hover:bg-gray-500 text-white transition-colors"
                      >
                        Copy link
                      </button>
                      {inv.status === "pending" && (
                        <button
                          type="button"
                          onClick={() => handleCancel(inv.id)}
                          className="px-2 py-1 rounded text-xs bg-red-700 hover:bg-red-600 text-white transition-colors"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
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

// ─── Subscriptions Sub-Tab ───────────────────────────────────────────────────

function SubscriptionsTab({ clients, showToast, onSessionExpired }) {
  const [subs, setSubs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [expandedInvoices, setExpandedInvoices] = useState({});

  // Form state
  const [clientId, setClientId] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [interval, setInterval] = useState("monthly");
  const [totalPayments, setTotalPayments] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState("");

  const authHeader = () => {
    const token = sessionStorage.getItem("adminToken");
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  };

  const fetchSubs = useCallback(async () => {
    const token = sessionStorage.getItem("adminToken");
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API}/subscriptions`, { headers: authHeader() });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          onSessionExpired?.();
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      setSubs(await res.json());
    } catch (err) {
      logger.error("Error fetching subscriptions:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [onSessionExpired]);

  useEffect(() => {
    fetchSubs();
  }, [fetchSubs]);

  const handleCreate = useCallback(
    async (e) => {
      e.preventDefault();
      setFormError("");
      const amountCents = Math.round(parseFloat(amount) * 100);
      if (!clientId) return setFormError("Select a client.");
      if (Number.isNaN(amountCents) || amountCents <= 0)
        return setFormError("Enter a valid amount.");
      if (!description.trim()) return setFormError("Description is required.");

      const total = totalPayments ? parseInt(totalPayments, 10) : null;
      if (totalPayments && (Number.isNaN(total) || total <= 0))
        return setFormError("Total payments must be a positive integer.");

      setCreating(true);
      try {
        const res = await fetch(`${API}/subscriptions`, {
          method: "POST",
          headers: authHeader(),
          body: JSON.stringify({
            clientId,
            amountCents,
            description: description.trim(),
            interval,
            totalPayments: total,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setSubs((prev) => [data.subscription, ...prev]);
        setClientId("");
        setAmount("");
        setDescription("");
        setInterval("monthly");
        setTotalPayments("");
        showToast?.("Subscription created and first invoice sent.", "success");
      } catch (err) {
        logger.error("Error creating subscription:", err);
        setFormError(err.message);
      } finally {
        setCreating(false);
      }
    },
    [clientId, amount, description, interval, totalPayments, showToast]
  );

  const handleStatusChange = useCallback(
    async (id, status) => {
      try {
        const res = await fetch(`${API}/subscriptions/${id}`, {
          method: "PATCH",
          headers: authHeader(),
          body: JSON.stringify({ status }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setSubs((prev) => prev.map((s) => (s.id === id ? data : s)));
        showToast?.(`Subscription ${status}.`, "success");
      } catch (err) {
        logger.error("Error updating subscription:", err);
        showToast?.(err.message, "error");
      }
    },
    [showToast]
  );

  const handleViewInvoices = useCallback(
    async (id) => {
      if (expandedId === id) {
        setExpandedId(null);
        return;
      }
      try {
        const res = await fetch(`${API}/subscriptions/${id}`, { headers: authHeader() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setExpandedInvoices((prev) => ({ ...prev, [id]: data.invoices ?? [] }));
        setExpandedId(id);
      } catch (err) {
        logger.error("Error fetching subscription invoices:", err);
        showToast?.(err.message, "error");
      }
    },
    [expandedId, showToast]
  );

  return (
    <div>
      {/* Create form */}
      <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
        <h4 className="text-md font-semibold text-white mb-3">New Subscription</h4>
        <form onSubmit={handleCreate} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="sub-client" className="block text-sm text-gray-300 mb-1">
              Client
            </label>
            <select
              id="sub-client"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={creating}
            >
              <option value="">Select client…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="sub-amount" className="block text-sm text-gray-300 mb-1">
              Amount ($)
            </label>
            <input
              id="sub-amount"
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 150.00"
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={creating}
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="sub-desc" className="block text-sm text-gray-300 mb-1">
              Description
            </label>
            <input
              id="sub-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Monthly hosting plan"
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={creating}
            />
          </div>
          <div>
            <label htmlFor="sub-interval" className="block text-sm text-gray-300 mb-1">
              Billing Interval
            </label>
            <select
              id="sub-interval"
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={creating}
            >
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>
          <div>
            <label htmlFor="sub-total" className="block text-sm text-gray-300 mb-1">
              Total Payments (optional, blank = indefinite)
            </label>
            <input
              id="sub-total"
              type="number"
              min="1"
              step="1"
              value={totalPayments}
              onChange={(e) => setTotalPayments(e.target.value)}
              placeholder="e.g. 12"
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={creating}
            />
          </div>
          <div className="sm:col-span-2 flex items-center gap-3">
            {formError && (
              <p className="text-sm text-red-400" role="alert">
                {formError}
              </p>
            )}
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-medium
                         transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creating ? "Creating..." : "Create Subscription"}
            </button>
          </div>
        </form>
      </div>

      {/* List */}
      <div className="flex justify-between items-center mb-3">
        <h4 className="text-md font-semibold text-white">Subscriptions</h4>
        <button
          type="button"
          onClick={fetchSubs}
          className="text-sm bg-gray-700 hover:bg-gray-600 text-white py-1 px-3 rounded-md transition-colors"
        >
          Refresh
        </button>
      </div>

      {loading && (
        <div className="text-center py-8">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500" />
          <p className="mt-3 text-gray-300">Loading subscriptions...</p>
        </div>
      )}
      {error && <p className="text-red-400 text-sm py-4 text-center">{error}</p>}
      {!loading && !error && subs.length === 0 && (
        <p className="text-gray-400 text-sm py-4 text-center">No subscriptions yet</p>
      )}

      {subs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-700">
            <thead>
              <tr>
                {["Client", "Description", "Amount", "Progress", "Status", "Actions"].map((h) => (
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
              {subs.map((sub) => (
                <>
                  <tr key={sub.id} className="hover:bg-gray-700/50">
                    <td className="px-3 py-2 text-sm text-gray-200">{sub.clientName ?? "—"}</td>
                    <td className="px-3 py-2 text-sm text-gray-200 max-w-xs truncate">
                      {sub.description}
                    </td>
                    <td className="px-3 py-2 text-sm text-gray-200">
                      ${(sub.amountCents / 100).toFixed(2)} / {sub.interval}
                    </td>
                    <td className="px-3 py-2 text-sm text-gray-400">
                      {sub.totalPayments != null
                        ? `${sub.paymentsMade} / ${sub.totalPayments} payments`
                        : `${sub.paymentsMade} payments made`}
                    </td>
                    <td className="px-3 py-2 text-sm">
                      <StatusBadge status={sub.status} />
                    </td>
                    <td className="px-3 py-2 text-sm">
                      <div className="flex gap-2 flex-wrap">
                        {sub.status === "active" && (
                          <button
                            type="button"
                            onClick={() => handleStatusChange(sub.id, "paused")}
                            className="px-2 py-1 rounded text-xs bg-yellow-700 hover:bg-yellow-600 text-white transition-colors"
                          >
                            Pause
                          </button>
                        )}
                        {sub.status === "paused" && (
                          <button
                            type="button"
                            onClick={() => handleStatusChange(sub.id, "active")}
                            className="px-2 py-1 rounded text-xs bg-green-700 hover:bg-green-600 text-white transition-colors"
                          >
                            Resume
                          </button>
                        )}
                        {(sub.status === "active" || sub.status === "paused") && (
                          <button
                            type="button"
                            onClick={() => handleStatusChange(sub.id, "cancelled")}
                            className="px-2 py-1 rounded text-xs bg-red-700 hover:bg-red-600 text-white transition-colors"
                          >
                            Cancel
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleViewInvoices(sub.id)}
                          className="px-2 py-1 rounded text-xs bg-blue-700 hover:bg-blue-600 text-white transition-colors"
                        >
                          {expandedId === sub.id ? "Hide" : "Invoices"}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expandedId === sub.id && (
                    <tr className="bg-gray-800/50">
                      <td colSpan={6} className="px-4 py-3">
                        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                          Invoices ({(expandedInvoices[sub.id] ?? []).length})
                        </p>
                        {(expandedInvoices[sub.id] ?? []).length === 0 ? (
                          <p className="text-gray-500 text-sm italic">No invoices yet.</p>
                        ) : (
                          <div className="grid gap-1">
                            {(expandedInvoices[sub.id] ?? []).map((inv) => (
                              <div
                                key={inv.id}
                                className="flex justify-between items-center bg-gray-700/50 rounded px-3 py-2 text-sm"
                              >
                                <span className="text-gray-300">{inv.description}</span>
                                <div className="flex items-center gap-3">
                                  <span className="text-gray-400">
                                    ${(inv.amountCents / 100).toFixed(2)}
                                  </span>
                                  <StatusBadge status={inv.status} />
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── BillingPanel ────────────────────────────────────────────────────────────

const BILLING_TABS = [
  { id: "invoices", label: "Invoices" },
  { id: "subscriptions", label: "Subscriptions" },
];

export default function BillingPanel({ clients, showToast, onSessionExpired }) {
  const [activeTab, setActiveTab] = useState("invoices");

  return (
    <div>
      {/* Sub-tabs */}
      <div className="flex border-b border-gray-700 mb-6">
        {BILLING_TABS.map((tab) => (
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

      {activeTab === "invoices" && (
        <InvoicesTab clients={clients} showToast={showToast} onSessionExpired={onSessionExpired} />
      )}
      {activeTab === "subscriptions" && (
        <SubscriptionsTab
          clients={clients}
          showToast={showToast}
          onSessionExpired={onSessionExpired}
        />
      )}
    </div>
  );
}
