import { useEffect, useRef } from "react";
import { useClients, usePatchClient } from "../../hooks/useClients";
import LoadingSpinner from "./shared/LoadingSpinner";

export default function GroupMembersModal({ group, onClose, showToast }) {
  const { data: clients = [], isLoading } = useClients();
  const patchClientMutation = usePatchClient();
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

  const handleAction = (client, newGroupId) => {
    patchClientMutation.mutate(
      { id: client.id, body: { groupId: newGroupId } },
      {
        onSuccess: () => {
          showToast?.(
            newGroupId
              ? `${client.name} added to ${group.name}`
              : `${client.name} removed from ${group.name}`,
            "success"
          );
        },
        onError: (err) => showToast?.(err.message, "error"),
      }
    );
  };

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

        {isLoading && <LoadingSpinner size="sm" message="Loading clients..." />}

        {!isLoading && (
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
                    {members.map((c) => {
                      const isActioning =
                        patchClientMutation.isPending && patchClientMutation.variables?.id === c.id;
                      return (
                        <tr key={c.id} className="hover:bg-gray-700/50">
                          <td className="px-3 py-2 text-sm text-gray-200">{c.name}</td>
                          <td className="px-3 py-2 text-sm text-gray-400">{c.email}</td>
                          <td className="px-3 py-2 text-sm text-right">
                            <button
                              type="button"
                              onClick={() => handleAction(c, null)}
                              disabled={isActioning}
                              className="px-3 py-1 rounded text-xs font-medium bg-red-600 hover:bg-red-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {isActioning ? "..." : "Remove"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
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
                    {available.map((c) => {
                      const isActioning =
                        patchClientMutation.isPending && patchClientMutation.variables?.id === c.id;
                      return (
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
                              disabled={isActioning}
                              className="px-3 py-1 rounded text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {isActioning ? "..." : "Add"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
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
