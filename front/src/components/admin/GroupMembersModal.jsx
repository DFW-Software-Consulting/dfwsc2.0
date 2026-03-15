import { useCallback, useEffect, useRef, useState } from "react";
import logger from "../../utils/logger";

export default function GroupMembersModal({
  group,
  onClose,
  showToast,
  onSessionExpired,
  onClientUpdated,
}) {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(false);
  const [actioningId, setActioningId] = useState(null);
  const [error, setError] = useState("");
  const modalRef = useRef(null);

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

  const fetchClients = useCallback(async () => {
    const token = sessionStorage.getItem("adminToken");
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/clients`, {
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
      setClients(await res.json());
    } catch (err) {
      logger.error("Error fetching clients:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [onSessionExpired]);

  useEffect(() => {
    fetchClients();
  }, [fetchClients]);

  const handleAction = useCallback(
    async (client, newGroupId) => {
      const token = sessionStorage.getItem("adminToken");
      if (!token) return;
      setActioningId(client.id);
      // Optimistic update
      setClients((prev) =>
        prev.map((c) => (c.id === client.id ? { ...c, groupId: newGroupId } : c))
      );
      try {
        const res = await fetch(`${import.meta.env.VITE_API_URL}/clients/${client.id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ groupId: newGroupId }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: "Failed to update client" }));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const updated = await res.json();
        setClients((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
        onClientUpdated?.(updated);
        showToast?.(
          newGroupId
            ? `${client.name} added to ${group.name}`
            : `${client.name} removed from ${group.name}`,
          "success"
        );
      } catch (err) {
        // Rollback
        setClients((prev) =>
          prev.map((c) => (c.id === client.id ? { ...c, groupId: client.groupId } : c))
        );
        logger.error("Error updating client group:", err);
        showToast?.(err.message, "error");
      } finally {
        setActioningId(null);
      }
    },
    [group.name, onClientUpdated, showToast]
  );

  const members = clients.filter((c) => c.groupId === group.id);
  const available = clients.filter((c) => c.groupId !== group.id);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled via document-level keydown listener
    <div
      ref={modalRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="group-members-title"
    >
      <div className="bg-gray-800 rounded-xl shadow-xl border border-gray-700 p-6 w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-5">
          <h3 id="group-members-title" className="text-lg font-semibold text-white">
            {group.name} — Members
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

        {loading && (
          <div className="text-center py-8">
            <div className="inline-block animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-blue-500" />
            <p className="mt-2 text-gray-400 text-sm">Loading clients...</p>
          </div>
        )}
        {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

        {!loading && (
          <>
            {/* Current members */}
            <div className="mb-6">
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                Current Members ({members.length})
              </h4>
              {members.length === 0 ? (
                <p className="text-gray-500 text-sm py-2">No members yet.</p>
              ) : (
                <table className="min-w-full divide-y divide-gray-700">
                  <thead>
                    <tr>
                      {["Name", "Email", ""].map((h) => (
                        <th
                          key={h}
                          className="px-3 py-2 text-left text-xs font-medium text-gray-400 uppercase tracking-wider"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700/50">
                    {members.map((c) => (
                      <tr key={c.id} className="hover:bg-gray-700/50">
                        <td className="px-3 py-2 text-sm text-gray-200">{c.name}</td>
                        <td className="px-3 py-2 text-sm text-gray-400">{c.email}</td>
                        <td className="px-3 py-2 text-sm text-right">
                          <button
                            type="button"
                            onClick={() => handleAction(c, null)}
                            disabled={actioningId === c.id}
                            className="px-3 py-1 rounded text-xs font-medium bg-red-600 hover:bg-red-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {actioningId === c.id ? "..." : "Remove"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Available clients */}
            <div>
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                Add Clients ({available.length})
              </h4>
              {available.length === 0 ? (
                <p className="text-gray-500 text-sm py-2">All clients are already in this group.</p>
              ) : (
                <table className="min-w-full divide-y divide-gray-700">
                  <thead>
                    <tr>
                      {["Name", "Email", "Group", ""].map((h) => (
                        <th
                          key={h}
                          className="px-3 py-2 text-left text-xs font-medium text-gray-400 uppercase tracking-wider"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700/50">
                    {available.map((c) => (
                      <tr key={c.id} className="hover:bg-gray-700/50">
                        <td className="px-3 py-2 text-sm text-gray-200">{c.name}</td>
                        <td className="px-3 py-2 text-sm text-gray-400">{c.email}</td>
                        <td className="px-3 py-2 text-sm text-gray-500">
                          {c.groupId ? "In another group" : "—"}
                        </td>
                        <td className="px-3 py-2 text-sm text-right">
                          <button
                            type="button"
                            onClick={() => handleAction(c, group.id)}
                            disabled={actioningId === c.id}
                            className="px-3 py-1 rounded text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {actioningId === c.id ? "..." : "Add"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
