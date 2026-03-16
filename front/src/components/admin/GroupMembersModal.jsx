import { useClients, usePatchClient } from "../../hooks/useClients";
import BaseModal from "./shared/BaseModal";
import Button from "./shared/Button";
import LoadingSpinner from "./shared/LoadingSpinner";

export default function GroupMembersModal({ group, onClose, showToast }) {
  const { data: clients = [], isLoading } = useClients();
  const patchClientMutation = usePatchClient();

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
    <BaseModal
      isOpen
      onClose={onClose}
      title={`${group.name} — Members`}
      titleId="group-members-title"
      size="lg"
    >
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
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={isActioning}
                            onClick={() => handleAction(c, null)}
                          >
                            {isActioning ? "..." : "Remove"}
                          </Button>
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
                          <Button
                            size="sm"
                            disabled={isActioning}
                            onClick={() => handleAction(c, group.id)}
                          >
                            {isActioning ? "..." : "Add"}
                          </Button>
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
    </BaseModal>
  );
}
