import { useCallback, useState } from "react";
import { useClients, usePatchClient } from "../../hooks/useClients";
import { usePatchGroup } from "../../hooks/useGroups";
import { validateFeeValue, validateUrl } from "../../utils/validation";
import EditClientModal from "./EditClientModal";
import BaseModal from "./shared/BaseModal";
import Button from "./shared/Button";
import ErrorMessage from "./shared/ErrorMessage";
import FeeConfigSection from "./shared/FeeConfigSection";
import FormInput from "./shared/FormInput";
import StatusBadge from "./shared/StatusBadge";

export default function ClientProfileView({ group, onClose, showToast }) {
  const { data: allClients = [] } = useClients();
  const patchGroupMutation = usePatchGroup();
  const patchClientMutation = usePatchClient();

  const [groupName, setGroupName] = useState(group.name);
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

  const [editingClient, setEditingClient] = useState(null);

  const members = allClients.filter((c) => c.groupId === group.id);
  const available = allClients.filter((c) => !c.groupId);

  const handleFeeTypeChange = useCallback((type) => {
    setFeeType(type);
    setFeeValue("");
    setError("");
  }, []);

  const handleSaveGroup = useCallback(() => {
    setError("");
    const trimmedName = groupName.trim();
    if (!trimmedName) return setError("Company name is required.");

    const body = {
      name: trimmedName,
      paymentSuccessUrl: successUrl.trim() || null,
      paymentCancelUrl: cancelUrl.trim() || null,
    };

    if (feeType !== "none") {
      const feeErr = validateFeeValue(feeValue, feeType);
      if (feeErr) return setError(feeErr);

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

    if (validateUrl(body.paymentSuccessUrl))
      return setError("Success URL must be a valid HTTPS URL.");
    if (validateUrl(body.paymentCancelUrl))
      return setError("Cancel URL must be a valid HTTPS URL.");

    patchGroupMutation.mutate(
      { id: group.id, body },
      {
        onSuccess: () => showToast?.("Company profile updated", "success"),
        onError: (err) => setError(err.message),
      }
    );
  }, [
    group.id,
    groupName,
    feeType,
    feeValue,
    successUrl,
    cancelUrl,
    patchGroupMutation,
    showToast,
  ]);

  const handleToggleClientStatus = (client) => {
    const newStatus = client.status === "active" ? "inactive" : "active";
    patchClientMutation.mutate(
      { id: client.id, body: { status: newStatus } },
      {
        onSuccess: () =>
          showToast?.(`Account ${newStatus === "active" ? "activated" : "deactivated"}`, "success"),
        onError: (err) => showToast?.(err.message, "error"),
      }
    );
  };

  const handleLinkAccount = (client) => {
    patchClientMutation.mutate(
      { id: client.id, body: { groupId: group.id } },
      {
        onSuccess: () => showToast?.(`${client.name} linked to ${group.name}`, "success"),
        onError: (err) => showToast?.(err.message, "error"),
      }
    );
  };

  const handleUnlinkAccount = (client) => {
    patchClientMutation.mutate(
      { id: client.id, body: { groupId: null } },
      {
        onSuccess: () => showToast?.(`${client.name} unlinked from company profile`, "success"),
        onError: (err) => showToast?.(err.message, "error"),
      }
    );
  };

  return (
    <BaseModal
      isOpen
      onClose={onClose}
      title={`Client Profile: ${group.name}`}
      titleId="client-profile-title"
      size="xl"
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column: Company Settings */}
        <div className="lg:col-span-1 space-y-6">
          <div className="p-4 bg-gray-800/50 rounded-lg border border-gray-700">
            <h4 className="text-sm font-semibold text-white mb-4 uppercase tracking-wider">
              Company Settings
            </h4>

            <FormInput
              id="prof-group-name"
              label="Company Name"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              wrapperClassName="mb-4"
            />

            <FeeConfigSection
              feeType={feeType}
              feeValue={feeValue}
              onFeeTypeChange={handleFeeTypeChange}
              onFeeValueChange={setFeeValue}
              hint="Shared fee for all accounts in this company (unless overridden)."
              hintColor="gray"
              showHintAlways
              radioName="profileGroupFeeType"
            />

            <FormInput
              id="prof-group-success-url"
              label="Default Success URL"
              type="url"
              value={successUrl}
              onChange={(e) => setSuccessUrl(e.target.value)}
              placeholder="https://yoursite.com/thank-you"
              wrapperClassName="mb-4"
            />
            <FormInput
              id="prof-group-cancel-url"
              label="Default Cancel URL"
              type="url"
              value={cancelUrl}
              onChange={(e) => setCancelUrl(e.target.value)}
              placeholder="https://yoursite.com/cancel"
              wrapperClassName="mb-5"
            />

            <ErrorMessage message={error} className="mb-3" />

            <Button
              variant="primary"
              className="w-full"
              isLoading={patchGroupMutation.isPending}
              onClick={handleSaveGroup}
            >
              {patchGroupMutation.isPending ? "Saving..." : "Save Company Info"}
            </Button>
          </div>
        </div>

        {/* Right Column: Linked Accounts (Stripe Connections) */}
        <div className="lg:col-span-2 space-y-6">
          <div className="p-4 bg-gray-800/50 rounded-lg border border-gray-700">
            <div className="flex justify-between items-center mb-4">
              <h4 className="text-sm font-semibold text-white uppercase tracking-wider">
                Linked Accounts ({members.length})
              </h4>
            </div>

            {members.length === 0 ? (
              <div className="py-10 text-center border-2 border-dashed border-gray-700 rounded-lg">
                <p className="text-gray-500 italic">
                  No Stripe accounts linked to this company yet.
                </p>
                <p className="text-xs text-gray-600 mt-1">
                  Add accounts below to manage them together.
                </p>
              </div>
            ) : (
              <div className="space-y-3 mb-8">
                {members.map((client) => (
                  <div
                    key={client.id}
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 bg-gray-700/30 rounded-lg border border-gray-700 hover:border-gray-600 transition-colors"
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold text-gray-100">{client.name}</span>
                        <StatusBadge status={client.status} />
                      </div>
                      <p className="text-xs text-gray-400 font-mono mb-2">{client.email}</p>

                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        <div className="flex items-center gap-1.5 text-xs">
                          <span className="text-gray-500">Fee:</span>
                          <span className="text-gray-300">
                            {client.processingFeePercent != null
                              ? `${client.processingFeePercent}%`
                              : client.processingFeeCents != null
                                ? `$${(client.processingFeeCents / 100).toFixed(2)}`
                                : "Inherited"}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 text-xs">
                          <span className="text-gray-500">Stripe ID:</span>
                          <code className="text-blue-400 bg-blue-400/10 px-1 rounded">
                            {client.stripeAccountId || "Not Connected"}
                          </code>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-blue-400 hover:bg-blue-400/10"
                        onClick={() => setEditingClient(client)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-yellow-400 hover:bg-yellow-400/10"
                        onClick={() => handleUnlinkAccount(client)}
                        isLoading={
                          patchClientMutation.isPending &&
                          patchClientMutation.variables?.id === client.id &&
                          patchClientMutation.variables?.body.groupId === null
                        }
                      >
                        Unlink
                      </Button>
                      <Button
                        size="sm"
                        variant={client.status === "active" ? "ghost" : "success"}
                        className={
                          client.status === "active" ? "text-red-400 hover:bg-red-400/10" : ""
                        }
                        onClick={() => handleToggleClientStatus(client)}
                        isLoading={
                          patchClientMutation.isPending &&
                          patchClientMutation.variables?.id === client.id &&
                          patchClientMutation.variables?.body.status !== undefined
                        }
                      >
                        {client.status === "active" ? "Deactivate" : "Activate"}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Link Existing Accounts */}
            {available.length > 0 && (
              <div className="mt-8 border-t border-gray-700 pt-6">
                <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
                  Add Independent Accounts to Company
                </h4>
                <div className="space-y-2">
                  {available.map((c) => (
                    <div
                      key={c.id}
                      className="flex items-center justify-between p-2 bg-gray-900/30 rounded border border-gray-800"
                    >
                      <div>
                        <span className="text-sm text-gray-300 font-medium">{c.name}</span>
                        <span className="text-xs text-gray-500 ml-2">({c.email})</span>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => handleLinkAccount(c)}
                        isLoading={
                          patchClientMutation.isPending &&
                          patchClientMutation.variables?.id === c.id &&
                          patchClientMutation.variables?.body.groupId === group.id
                        }
                      >
                        Add to Profile
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {editingClient && (
        <EditClientModal
          client={editingClient}
          onClose={() => setEditingClient(null)}
          showToast={showToast}
        />
      )}
    </BaseModal>
  );
}
