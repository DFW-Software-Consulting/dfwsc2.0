import { useCallback, useEffect, useRef, useState } from "react";
import logger from "../../utils/logger";
import GroupMembersModal from "./GroupMembersModal";

function formatFee(group) {
  if (group.processingFeePercent != null) return `${group.processingFeePercent}%`;
  if (group.processingFeeCents != null)
    return `$${(group.processingFeeCents / 100).toFixed(2)} flat`;
  return "—";
}

// ─── Edit Group Modal ────────────────────────────────────────────────────────

function EditGroupModal({ group, onClose, onSaved, showToast }) {
  const [name, setName] = useState(group.name);
  const [feeType, setFeeType] = useState("none");
  const [feeValue, setFeeValue] = useState("");
  const [successUrl, setSuccessUrl] = useState(group.paymentSuccessUrl ?? "");
  const [cancelUrl, setCancelUrl] = useState(group.paymentCancelUrl ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const modalRef = useRef(null);

  useEffect(() => {
    if (group.processingFeePercent != null) {
      setFeeType("percent");
      setFeeValue(String(group.processingFeePercent));
    } else if (group.processingFeeCents != null) {
      setFeeType("cents");
      setFeeValue(String(group.processingFeeCents));
    } else {
      setFeeType("none");
      setFeeValue("");
    }
  }, [group]);

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscape);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const handleBackdropClick = (e) => {
    if (e.target === modalRef.current) onClose();
  };

  const handleSave = useCallback(async () => {
    const token = sessionStorage.getItem("adminToken");
    if (!token) return;

    setError("");
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }

    const body = {
      name: trimmedName,
      paymentSuccessUrl: successUrl.trim() || null,
      paymentCancelUrl: cancelUrl.trim() || null,
    };

    if (feeType === "percent") {
      const v = parseFloat(feeValue);
      if (Number.isNaN(v) || v <= 0 || v > 100) {
        setError("Fee percent must be greater than 0 and at most 100.");
        return;
      }
      body.processingFeePercent = v;
      body.processingFeeCents = null;
    } else if (feeType === "cents") {
      const v = parseInt(feeValue, 10);
      if (Number.isNaN(v) || v < 0 || !Number.isInteger(v)) {
        setError("Fee must be a non-negative whole number of cents.");
        return;
      }
      body.processingFeeCents = v;
      body.processingFeePercent = null;
    } else {
      body.processingFeePercent = null;
      body.processingFeeCents = null;
    }

    if (body.paymentSuccessUrl && !body.paymentSuccessUrl.startsWith("https://")) {
      setError("Success URL must be a valid HTTPS URL.");
      return;
    }
    if (body.paymentCancelUrl && !body.paymentCancelUrl.startsWith("https://")) {
      setError("Cancel URL must be a valid HTTPS URL.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/groups/${group.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Failed to update group" }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const updated = await res.json();
      showToast?.("Group updated successfully", "success");
      onSaved?.(updated);
      onClose();
    } catch (err) {
      logger.error("Error updating group:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [group.id, name, feeType, feeValue, successUrl, cancelUrl, onClose, onSaved, showToast]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled via document-level keydown listener
    <div
      ref={modalRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-group-title"
    >
      <div className="bg-gray-800 rounded-xl shadow-xl border border-gray-700 p-6 w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-5">
          <h3 id="edit-group-title" className="text-lg font-semibold text-white">
            Edit Group
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-white text-2xl leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Name */}
        <div className="mb-4">
          <label htmlFor="edit-group-name" className="block text-sm font-medium text-gray-300 mb-1">
            Name
          </label>
          <input
            id="edit-group-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                       placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Processing fee */}
        <div className="mb-4">
          <label
            htmlFor="edit-group-fee-value"
            className="block text-sm font-medium text-gray-300 mb-2"
          >
            Processing Fee
          </label>
          <div className="flex flex-wrap gap-4 mb-2">
            {[
              { value: "none", label: "None" },
              { value: "percent", label: "Percent (%)" },
              { value: "cents", label: "Flat (cents)" },
            ].map(({ value, label }) => (
              <label
                key={value}
                className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer"
              >
                <input
                  type="radio"
                  name="groupFeeType"
                  value={value}
                  checked={feeType === value}
                  onChange={() => {
                    setFeeType(value);
                    setFeeValue("");
                    setError("");
                  }}
                  className="accent-blue-500"
                />
                {label}
              </label>
            ))}
          </div>
          {feeType !== "none" && (
            <input
              id="edit-group-fee-value"
              type="number"
              value={feeValue}
              onChange={(e) => setFeeValue(e.target.value)}
              placeholder={feeType === "percent" ? "e.g. 2.5" : "e.g. 50  (= $0.50)"}
              min="0"
              step={feeType === "percent" ? "0.01" : "1"}
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}
          <p className="mt-1.5 text-xs text-gray-400">
            Clients in this group with no per-client fee set will inherit this fee.
          </p>
        </div>

        {/* Redirect URLs */}
        <div className="mb-4">
          <label
            htmlFor="edit-group-success-url"
            className="block text-sm font-medium text-gray-300 mb-1"
          >
            Default Payment Success URL
          </label>
          <input
            id="edit-group-success-url"
            type="url"
            value={successUrl}
            onChange={(e) => setSuccessUrl(e.target.value)}
            placeholder="https://yoursite.com/thank-you"
            className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                       placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="mb-5">
          <label
            htmlFor="edit-group-cancel-url"
            className="block text-sm font-medium text-gray-300 mb-1"
          >
            Default Payment Cancel URL
          </label>
          <input
            id="edit-group-cancel-url"
            type="url"
            value={cancelUrl}
            onChange={(e) => setCancelUrl(e.target.value)}
            placeholder="https://yoursite.com/cancel"
            className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                       placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {error && (
          <p className="mb-3 text-sm text-red-400" role="alert">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 text-white font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={loading}
            className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Group Panel ─────────────────────────────────────────────────────────────

export default function GroupPanel({
  showToast,
  onSessionExpired,
  onGroupsChanged,
  onClientUpdated,
}) {
  const [groups, setGroups] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);
  const [managingGroup, setManagingGroup] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [expandedGroupId, setExpandedGroupId] = useState(null);

  const fetchGroups = useCallback(async () => {
    const token = sessionStorage.getItem("adminToken");
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/groups`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          sessionStorage.removeItem("adminToken");
          onSessionExpired?.();
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setGroups(data);
      onGroupsChanged?.(data);
    } catch (err) {
      logger.error("Error fetching groups:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [onSessionExpired, onGroupsChanged]);

  const fetchClients = useCallback(async () => {
    const token = sessionStorage.getItem("adminToken");
    if (!token) return;
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/clients`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      setClients(await res.json());
    } catch (err) {
      logger.error("Error fetching clients:", err);
    }
  }, []);

  useEffect(() => {
    fetchGroups();
    fetchClients();
  }, [fetchGroups, fetchClients]);

  const handleCreate = useCallback(
    async (e) => {
      e.preventDefault();
      const name = newGroupName.trim();
      if (!name) return;
      const token = sessionStorage.getItem("adminToken");
      setCreating(true);
      try {
        const res = await fetch(`${import.meta.env.VITE_API_URL}/groups`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: "Failed to create group" }));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const group = await res.json();
        const updated = [...groups, group];
        setGroups(updated);
        onGroupsChanged?.(updated);
        setNewGroupName("");
        showToast?.(`Group "${group.name}" created`, "success");
      } catch (err) {
        logger.error("Error creating group:", err);
        showToast?.(err.message, "error");
      } finally {
        setCreating(false);
      }
    },
    [newGroupName, groups, showToast, onGroupsChanged]
  );

  const handleToggleStatus = useCallback(
    async (group) => {
      const token = sessionStorage.getItem("adminToken");
      const newStatus = group.status === "active" ? "inactive" : "active";
      setTogglingId(group.id);
      const optimistic = groups.map((g) => (g.id === group.id ? { ...g, status: newStatus } : g));
      setGroups(optimistic);
      onGroupsChanged?.(optimistic);
      try {
        const res = await fetch(`${import.meta.env.VITE_API_URL}/groups/${group.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ status: newStatus }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast?.(`Group ${newStatus === "active" ? "activated" : "deactivated"}`, "success");
      } catch (err) {
        const rolled = groups.map((g) => (g.id === group.id ? { ...g, status: group.status } : g));
        setGroups(rolled);
        onGroupsChanged?.(rolled);
        showToast?.(err.message, "error");
      } finally {
        setTogglingId(null);
      }
    },
    [groups, showToast, onGroupsChanged]
  );

  const handleGroupSaved = useCallback(
    (updated) => {
      const next = groups.map((g) => (g.id === updated.id ? updated : g));
      setGroups(next);
      onGroupsChanged?.(next);
    },
    [groups, onGroupsChanged]
  );

  const handleToggleExpand = useCallback((groupId) => {
    setExpandedGroupId((prev) => (prev === groupId ? null : groupId));
  }, []);

  const getGroupMembers = useCallback(
    (groupId) => {
      return clients.filter((c) => c.groupId === groupId);
    },
    [clients]
  );

  return (
    <div>
      {/* Create form */}
      <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
        <h4 className="text-md font-semibold text-white mb-3">Create New Group</h4>
        <form onSubmit={handleCreate} className="flex gap-3">
          <input
            type="text"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            placeholder="Group name"
            className="flex-1 rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                       placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={creating}
          />
          <button
            type="submit"
            disabled={creating || !newGroupName.trim()}
            className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-medium
                       transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating ? "Creating..." : "Create"}
          </button>
        </form>
      </div>

      {/* List header */}
      <div className="flex justify-between items-center mb-3">
        <h4 className="text-md font-semibold text-white">Groups</h4>
        <button
          type="button"
          onClick={fetchGroups}
          className="text-sm bg-gray-700 hover:bg-gray-600 text-white py-1 px-3 rounded-md transition-colors"
        >
          Refresh
        </button>
      </div>

      {loading && (
        <div className="text-center py-8">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500" />
          <p className="mt-3 text-gray-300">Loading groups...</p>
        </div>
      )}
      {error && <p className="text-red-400 text-sm py-4 text-center">{error}</p>}
      {!loading && !error && groups.length === 0 && (
        <p className="text-gray-400 text-sm py-4 text-center">No groups yet</p>
      )}

      {groups.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-700">
            <thead>
              <tr>
                {["", "Name", "Status", "Fee", "Members", "Actions"].map((h) => (
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
              {groups.map((g) => {
                const members = getGroupMembers(g.id);
                const isExpanded = expandedGroupId === g.id;
                return (
                  <>
                    <tr key={g.id} className="hover:bg-gray-700/50">
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => handleToggleExpand(g.id)}
                          className="text-gray-400 hover:text-white transition-colors"
                          aria-label={isExpanded ? "Collapse" : "Expand"}
                        >
                          <svg
                            aria-hidden="true"
                            className={`w-4 h-4 transform transition-transform ${isExpanded ? "rotate-90" : ""}`}
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M9 5l7 7-7 7"
                            />
                          </svg>
                        </button>
                      </td>
                      <td className="px-3 py-2 text-sm text-gray-200">{g.name}</td>
                      <td className="px-3 py-2 text-sm">
                        <span
                          className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                            g.status === "active"
                              ? "bg-green-800 text-green-200"
                              : "bg-red-800 text-red-200"
                          }`}
                        >
                          {g.status.charAt(0).toUpperCase() + g.status.slice(1)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-sm text-gray-200">{formatFee(g)}</td>
                      <td className="px-3 py-2 text-sm text-gray-200">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-800 text-blue-200">
                          {members.length} {members.length === 1 ? "client" : "clients"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-sm">
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => setEditingGroup(g)}
                            className="px-3 py-1 rounded text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => setManagingGroup(g)}
                            className="px-3 py-1 rounded text-xs font-medium bg-purple-600 hover:bg-purple-700 text-white transition-colors"
                          >
                            Manage
                          </button>
                          <button
                            type="button"
                            onClick={() => handleToggleStatus(g)}
                            disabled={togglingId === g.id}
                            className={`px-3 py-1 rounded text-xs font-medium transition-colors disabled:opacity-50 ${
                              g.status === "active"
                                ? "bg-red-600 hover:bg-red-700 text-white"
                                : "bg-green-600 hover:bg-green-700 text-white"
                            }`}
                          >
                            {togglingId === g.id
                              ? "..."
                              : g.status === "active"
                                ? "Deactivate"
                                : "Activate"}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="bg-gray-800/50">
                        <td colSpan={6} className="px-3 py-4">
                          <div className="ml-4">
                            <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                              Clients in {g.name} ({members.length})
                            </h4>
                            {members.length === 0 ? (
                              <p className="text-gray-500 text-sm italic">
                                No clients in this group yet.
                              </p>
                            ) : (
                              <div className="grid gap-2">
                                {members.map((m) => (
                                  <div
                                    key={m.id}
                                    className="flex justify-between items-center bg-gray-700/50 rounded-md px-3 py-2"
                                  >
                                    <div>
                                      <p className="text-sm text-gray-200 font-medium">{m.name}</p>
                                      <p className="text-xs text-gray-400">{m.email}</p>
                                    </div>
                                    <div className="flex items-center gap-3">
                                      <span
                                        className={`text-xs px-2 py-1 rounded ${
                                          m.status === "active"
                                            ? "bg-green-900 text-green-300"
                                            : "bg-red-900 text-red-300"
                                        }`}
                                      >
                                        {m.status}
                                      </span>
                                      {m.stripeAccountId ? (
                                        <span
                                          className="text-xs text-blue-400"
                                          title="Stripe connected"
                                        >
                                          ✓ Connected
                                        </span>
                                      ) : (
                                        <span
                                          className="text-xs text-yellow-400"
                                          title="Not onboarded"
                                        >
                                          ⚠ Pending
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editingGroup && (
        <EditGroupModal
          group={editingGroup}
          onClose={() => setEditingGroup(null)}
          onSaved={handleGroupSaved}
          showToast={showToast}
        />
      )}
      {managingGroup && (
        <GroupMembersModal
          group={managingGroup}
          onClose={() => setManagingGroup(null)}
          showToast={showToast}
          onSessionExpired={onSessionExpired}
          onClientUpdated={onClientUpdated}
        />
      )}
    </div>
  );
}
