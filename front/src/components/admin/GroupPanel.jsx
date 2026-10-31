import { Fragment, useCallback, useState } from "react";
import { useClients } from "../../hooks/useClients";
import { useCreateGroup, useDeleteGroup, useGroups, usePatchGroup } from "../../hooks/useGroups";
import { validateFeeValue, validateUrl } from "../../utils/validation";
import ClientProfileView from "./ClientProfileView";
import ConfirmModal from "./ConfirmModal";
import AdminCard from "./shared/AdminCard";
import BaseModal from "./shared/BaseModal";
import Button from "./shared/Button";
import ErrorMessage from "./shared/ErrorMessage";
import FeeConfigSection from "./shared/FeeConfigSection";
import FormInput from "./shared/FormInput";
import LoadingSpinner from "./shared/LoadingSpinner";
import { getOnboardingState } from "./shared/onboardingState";
import RowActions from "./shared/RowActions";
import StatusBadge from "./shared/StatusBadge";
import TruncationNotice from "./shared/TruncationNotice";
import { useIsDesktop } from "./shared/useMinWidth";

function formatFee(group) {
  if (group.processingFeePercent != null) return `${group.processingFeePercent}%`;
  if (group.processingFeeCents != null)
    return `$${(group.processingFeeCents / 100).toFixed(2)} flat`;
  return "—";
}

function MemberCount({ count }) {
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-800 dark:text-blue-200">
      {count} {count === 1 ? "client" : "clients"}
    </span>
  );
}

function ExpandToggle({ isExpanded, onClick, name }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={isExpanded}
      className="-m-2 inline-flex size-11 shrink-0 items-center justify-center rounded text-fg-muted hover:text-fg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-focus md:m-0 md:size-8 pointer-coarse:size-11"
      aria-label={`${isExpanded ? "Collapse" : "Expand"}${name ? ` ${name}` : ""}`}
    >
      <svg
        aria-hidden="true"
        className={`w-4 h-4 transform transition-transform ${isExpanded ? "rotate-90" : ""}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
      </svg>
    </button>
  );
}

function MemberList({ group, members }) {
  return (
    <div className="md:ml-4">
      <h4 className="text-xs font-semibold text-fg-muted uppercase tracking-wider mb-3">
        Clients in {group.name} ({members.length})
      </h4>
      {members.length === 0 ? (
        <p className="text-fg-muted text-sm italic">No clients in this group yet.</p>
      ) : (
        <ul className="grid gap-2">
          {members.map((m) => (
            <li
              key={m.id}
              className="flex flex-col gap-2 rounded-md border border-line bg-card px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="text-sm text-fg font-medium [overflow-wrap:anywhere]">{m.name}</p>
                <p className="text-xs text-fg-muted [overflow-wrap:anywhere]">{m.email}</p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <StatusBadge status={m.status} />
                {getOnboardingState(m) === "ready" ? (
                  <span
                    className="text-xs text-brand-700 dark:text-brand-300"
                    title="Stripe connected"
                  >
                    ✓ Connected
                  </span>
                ) : getOnboardingState(m) === "in_progress" ? (
                  <span
                    className="text-xs text-yellow-800 dark:text-yellow-400"
                    title="Stripe onboarding started but not finished"
                  >
                    ⚠ In progress
                  </span>
                ) : (
                  <span
                    className="text-xs text-yellow-800 dark:text-yellow-400"
                    title="Not onboarded"
                  >
                    ⚠ Pending
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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

export default function GroupPanel({ showToast, workspace = "client_portal" }) {
  const isDesktop = useIsDesktop();
  const { data: groups = [], isLoading, isError, error, refetch } = useGroups(workspace);
  const { data: clients = [] } = useClients({ workspace });
  const createGroupMutation = useCreateGroup();
  const patchGroupMutation = usePatchGroup();
  const deleteGroupMutation = useDeleteGroup();

  const [newGroupName, setNewGroupName] = useState("");
  const [editingGroup, setEditingGroup] = useState(null);
  const [managingGroup, setManagingGroup] = useState(null);
  const [expandedGroupId, setExpandedGroupId] = useState(null);
  const [deleteGroup, setDeleteGroup] = useState(null);

  const handleCreate = useCallback(
    (e) => {
      e.preventDefault();
      const name = newGroupName.trim();
      if (!name) return;
      createGroupMutation.mutate(
        { name, workspace },
        {
          onSuccess: (group) => {
            setNewGroupName("");
            showToast?.(`Group "${group.name}" created`, "success");
          },
          onError: (err) => showToast?.(err.message, "error"),
        }
      );
    },
    [newGroupName, createGroupMutation, showToast, workspace]
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

  const handleConfirmDelete = useCallback(() => {
    if (!deleteGroup) return;
    deleteGroupMutation.mutate(deleteGroup.id, {
      onSuccess: () => {
        showToast?.(`Group "${deleteGroup.name}" deleted`, "success");
        setDeleteGroup(null);
      },
      onError: (err) => showToast?.(err.message, "error"),
    });
  }, [deleteGroup, deleteGroupMutation, showToast]);

  const getActions = (g) => {
    const isToggling = patchGroupMutation.isPending && patchGroupMutation.variables?.id === g.id;
    const isDeleting = deleteGroupMutation.isPending && deleteGroupMutation.variables === g.id;
    const isActive = g.status === "active";
    return [
      { key: "edit", label: "Edit", primary: true, onClick: () => setEditingGroup(g) },
      { key: "profile", label: "View Profile", onClick: () => setManagingGroup(g) },
      {
        key: "toggle",
        label: isToggling ? "..." : isActive ? "Deactivate" : "Activate",
        variant: isActive ? "danger" : "secondary",
        disabled: isToggling,
        onClick: () => handleToggleStatus(g),
      },
      {
        key: "delete",
        label: isDeleting ? "..." : "Delete",
        variant: "danger",
        disabled: isDeleting,
        onClick: () => setDeleteGroup(g),
      },
    ];
  };

  return (
    <div>
      {/* Create form */}
      <div className="mb-6 p-4 bg-surface border border-line rounded-lg">
        <h4 className="text-md font-semibold text-fg mb-3">Create New Company</h4>
        <form onSubmit={handleCreate} className="flex flex-wrap gap-3">
          <input
            type="text"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            placeholder="Company name"
            aria-label="Company name"
            className="min-w-0 flex-1 basis-48 rounded-md border border-line bg-card px-3 py-2 text-fg
                       placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-focus"
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
      <div className="flex flex-wrap justify-between items-center gap-2 mb-3">
        <h4 className="text-md font-semibold text-fg">Client Companies</h4>
        <Button size="sm" variant="secondary" onClick={() => refetch()}>
          Refresh
        </Button>
      </div>

      {isLoading && <LoadingSpinner message="Loading groups..." />}
      {isError && (
        <p className="text-red-700 dark:text-red-400 text-sm py-4 text-center">{error?.message}</p>
      )}
      {!isLoading && !isError && groups.length === 0 && (
        <p className="text-fg-muted text-sm py-4 text-center">No groups yet</p>
      )}

      <TruncationNotice shown={groups.length} total={groups.pagination?.total} noun="companies" />
      {clients.pagination && clients.length < clients.pagination.total && (
        <p className="text-xs text-yellow-800 dark:text-yellow-400 pb-2 text-center">
          Member counts only include the {clients.length} clients loaded.
        </p>
      )}

      {groups.length > 0 && !isDesktop && (
        <ul className="grid gap-3" data-testid="admin-cards">
          {groups.map((g) => {
            const members = getGroupMembers(g.id);
            const isExpanded = expandedGroupId === g.id;
            return (
              <AdminCard
                key={g.id}
                title={g.name}
                leading={
                  <ExpandToggle
                    isExpanded={isExpanded}
                    name={g.name}
                    onClick={() => handleToggleExpand(g.id)}
                  />
                }
                fields={[
                  { label: "Status", value: <StatusBadge status={g.status} /> },
                  { label: "Fee", value: formatFee(g) },
                  { label: "Members", value: <MemberCount count={members.length} /> },
                ]}
                actions={<RowActions mode="card" actions={getActions(g)} />}
              >
                {isExpanded && (
                  <div className="mt-4 rounded-md bg-surface/60 p-3">
                    <MemberList group={g} members={members} />
                  </div>
                )}
              </AdminCard>
            );
          })}
        </ul>
      )}

      {groups.length > 0 && isDesktop && (
        <div className="scroll-shade-x overflow-x-auto">
          <table className="min-w-full divide-y divide-line">
            <thead>
              <tr>
                {["", "Name", "Status", "Fee", "Members", "Actions"].map((h) => (
                  <th
                    key={h}
                    className="px-3 py-2 text-left text-xs font-medium text-fg-muted uppercase tracking-wider"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {groups.map((g) => {
                const members = getGroupMembers(g.id);
                const isExpanded = expandedGroupId === g.id;
                return (
                  <Fragment key={g.id}>
                    <tr className="hover:bg-surface">
                      <td className="px-3 py-2">
                        <ExpandToggle
                          isExpanded={isExpanded}
                          onClick={() => handleToggleExpand(g.id)}
                        />
                      </td>
                      <td className="px-3 py-2 text-sm text-fg">{g.name}</td>
                      <td className="px-3 py-2 text-sm">
                        <StatusBadge status={g.status} />
                      </td>
                      <td className="px-3 py-2 text-sm text-fg">{formatFee(g)}</td>
                      <td className="px-3 py-2 text-sm text-fg">
                        <MemberCount count={members.length} />
                      </td>
                      <td className="px-3 py-2 text-sm">
                        <RowActions actions={getActions(g)} />
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="bg-surface/60">
                        <td colSpan={6} className="px-3 py-4">
                          <MemberList group={g} members={members} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
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
          workspace={workspace}
        />
      )}
      {managingGroup && (
        <ClientProfileView
          group={managingGroup}
          onClose={() => setManagingGroup(null)}
          showToast={showToast}
          workspace={workspace}
        />
      )}
      <ConfirmModal
        isOpen={!!deleteGroup}
        title="Delete Group"
        message={`Are you sure you want to delete "${deleteGroup?.name ?? "this group"}"? Clients in this group will remain but no longer belong to a group.`}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteGroup(null)}
        confirmText="Delete"
        cancelText="Cancel"
        confirmVariant="danger"
      />
    </div>
  );
}
