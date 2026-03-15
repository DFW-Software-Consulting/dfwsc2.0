import { useCallback, useState } from "react";
import { useClients } from "../../hooks/useClients";
import { useCreateGroup, useGroups, usePatchGroup } from "../../hooks/useGroups";
import { validateFeeValue, validateUrl } from "../../utils/validation";
import GroupMembersModal from "./GroupMembersModal";
import BaseModal from "./shared/BaseModal";
import Button from "./shared/Button";
import ErrorMessage from "./shared/ErrorMessage";
import FeeConfigSection from "./shared/FeeConfigSection";
import FormInput from "./shared/FormInput";
import LoadingSpinner from "./shared/LoadingSpinner";
import StatusBadge from "./shared/StatusBadge";

function formatFee(group) {
  if (group.processingFeePercent != null) return `${group.processingFeePercent}%`;
  if (group.processingFeeCents != null)
    return `$${(group.processingFeeCents / 100).toFixed(2)} flat`;
  return "—";
}

// ─── Edit Group Modal ────────────────────────────────────────────────────────

function EditGroupModal({ group, onClose, showToast }) {
  const patchGroupMutation = usePatchGroup();

  const [name, setName] = useState(group.name);
  const [feeType, setFeeType] = useState(() => {
    if (group.processingFeePercent != null) return "percent";
    if (group.processingFeeCents != null) return "cents";
    return "none";
  });
  const [feeValue, setFeeValue] = useState(() => {
    if (group.processingFeePercent != null) return String(group.processingFeePercent);
    if (group.processingFeeCents != null) return String(group.processingFeeCents);
    return "";
  });
  const [successUrl, setSuccessUrl] = useState(group.paymentSuccessUrl ?? "");
  const [cancelUrl, setCancelUrl] = useState(group.paymentCancelUrl ?? "");
  const [error, setError] = useState("");

  const handleFeeTypeChange = useCallback((type) => {
    setFeeType(type);
    setFeeValue("");
    setError("");
  }, []);

  const handleSave = useCallback(() => {
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

    if (feeType !== "none") {
      const feeErr = validateFeeValue(feeValue, feeType);
      if (feeErr) {
        setError(feeErr);
        return;
      }
      if (feeType === "percent") {
        body.processingFeePercent = parseFloat(feeValue);
        body.processingFeeCents = null;
      } else {
        body.processingFeeCents = parseInt(feeValue, 10);
        body.processingFeePercent = null;
      }
    } else {
      body.processingFeePercent = null;
      body.processingFeeCents = null;
    }

    if (validateUrl(body.paymentSuccessUrl)) {
      setError("Success URL must be a valid HTTPS URL.");
      return;
    }
    if (validateUrl(body.paymentCancelUrl)) {
      setError("Cancel URL must be a valid HTTPS URL.");
      return;
    }

    patchGroupMutation.mutate(
      { id: group.id, body },
      {
        onSuccess: () => {
          showToast?.("Group updated successfully", "success");
          onClose();
        },
        onError: (err) => setError(err.message),
      }
    );
  }, [
    group.id,
    name,
    feeType,
    feeValue,
    successUrl,
    cancelUrl,
    onClose,
    showToast,
    patchGroupMutation,
  ]);

  return (
    <BaseModal isOpen onClose={onClose} title="Edit Group" titleId="edit-group-title">
      <FormInput
        id="edit-group-name"
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        wrapperClassName="mb-4"
      />

      <FeeConfigSection
        feeType={feeType}
        feeValue={feeValue}
        onFeeTypeChange={handleFeeTypeChange}
        onFeeValueChange={setFeeValue}
        hint="Clients in this group with no per-client fee set will inherit this fee."
        hintColor="gray"
        showHintAlways
        radioName="groupFeeType"
      />

      <FormInput
        id="edit-group-success-url"
        label="Default Payment Success URL"
        type="url"
        value={successUrl}
        onChange={(e) => setSuccessUrl(e.target.value)}
        placeholder="https://yoursite.com/thank-you"
        wrapperClassName="mb-4"
      />
      <FormInput
        id="edit-group-cancel-url"
        label="Default Payment Cancel URL"
        type="url"
        value={cancelUrl}
        onChange={(e) => setCancelUrl(e.target.value)}
        placeholder="https://yoursite.com/cancel"
        wrapperClassName="mb-5"
      />

      <ErrorMessage message={error} className="mb-3" />

      <div className="flex justify-end gap-3">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" isLoading={patchGroupMutation.isPending} onClick={handleSave}>
          {patchGroupMutation.isPending ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </BaseModal>
  );
}

// ─── Group Panel ─────────────────────────────────────────────────────────────

export default function GroupPanel({ showToast }) {
  const { data: groups = [], isLoading, isError, error, refetch } = useGroups();
  const { data: clients = [] } = useClients();
  const createGroupMutation = useCreateGroup();
  const patchGroupMutation = usePatchGroup();

  const [newGroupName, setNewGroupName] = useState("");
  const [editingGroup, setEditingGroup] = useState(null);
  const [managingGroup, setManagingGroup] = useState(null);
  const [expandedGroupId, setExpandedGroupId] = useState(null);

  const handleCreate = useCallback(
    (e) => {
      e.preventDefault();
      const name = newGroupName.trim();
      if (!name) return;
      createGroupMutation.mutate(
        { name },
        {
          onSuccess: (group) => {
            setNewGroupName("");
            showToast?.(`Group "${group.name}" created`, "success");
          },
          onError: (err) => showToast?.(err.message, "error"),
        }
      );
    },
    [newGroupName, createGroupMutation, showToast]
  );

  const handleToggleStatus = useCallback(
    (group) => {
      const newStatus = group.status === "active" ? "inactive" : "active";
      patchGroupMutation.mutate(
        { id: group.id, body: { status: newStatus } },
        {
          onSuccess: () =>
            showToast?.(`Group ${newStatus === "active" ? "activated" : "deactivated"}`, "success"),
          onError: (err) => showToast?.(err.message, "error"),
        }
      );
    },
    [patchGroupMutation, showToast]
  );

  const handleToggleExpand = useCallback((groupId) => {
    setExpandedGroupId((prev) => (prev === groupId ? null : groupId));
  }, []);

  const getGroupMembers = useCallback(
    (groupId) => clients.filter((c) => c.groupId === groupId),
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
            disabled={createGroupMutation.isPending}
          />
          <Button
            type="submit"
            disabled={createGroupMutation.isPending || !newGroupName.trim()}
            isLoading={createGroupMutation.isPending}
          >
            {createGroupMutation.isPending ? "Creating..." : "Create"}
          </Button>
        </form>
      </div>

      {/* List header */}
      <div className="flex justify-between items-center mb-3">
        <h4 className="text-md font-semibold text-white">Groups</h4>
        <button
          type="button"
          onClick={() => refetch()}
          className="text-sm bg-gray-700 hover:bg-gray-600 text-white py-1 px-3 rounded-md transition-colors"
        >
          Refresh
        </button>
      </div>

      {isLoading && <LoadingSpinner message="Loading groups..." />}
      {isError && <p className="text-red-400 text-sm py-4 text-center">{error?.message}</p>}
      {!isLoading && !isError && groups.length === 0 && (
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
                const isToggling =
                  patchGroupMutation.isPending && patchGroupMutation.variables?.id === g.id;
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
                        <StatusBadge status={g.status} />
                      </td>
                      <td className="px-3 py-2 text-sm text-gray-200">{formatFee(g)}</td>
                      <td className="px-3 py-2 text-sm text-gray-200">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-800 text-blue-200">
                          {members.length} {members.length === 1 ? "client" : "clients"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-sm">
                        <div className="flex gap-2">
                          <Button size="sm" onClick={() => setEditingGroup(g)}>
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="bg-purple-600 hover:bg-purple-700 text-white"
                            onClick={() => setManagingGroup(g)}
                          >
                            Manage
                          </Button>
                          <Button
                            size="sm"
                            variant={g.status === "active" ? "danger" : "success"}
                            disabled={isToggling}
                            onClick={() => handleToggleStatus(g)}
                          >
                            {isToggling ? "..." : g.status === "active" ? "Deactivate" : "Activate"}
                          </Button>
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
                                      <StatusBadge status={m.status} />
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
          showToast={showToast}
        />
      )}
      {managingGroup && (
        <GroupMembersModal
          group={managingGroup}
          onClose={() => setManagingGroup(null)}
          showToast={showToast}
        />
      )}
    </div>
  );
}
