import { useCallback, useState } from "react";
import { useInitiateClientOnboarding } from "../../hooks/useClients";
import { useGroups } from "../../hooks/useGroups";
import { validateEmail, validateName } from "../../utils/validation";
import BaseModal from "./shared/BaseModal";
import Button from "./shared/Button";
import ErrorMessage from "./shared/ErrorMessage";
import FormInput from "./shared/FormInput";

export default function AddClientModal({ onClose, showToast, workspace = "client_portal" }) {
  const { data: groups = [] } = useGroups(workspace);
  const initiateOnboardingMutation = useInitiateClientOnboarding();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [groupId, setGroupId] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = useCallback(
    (e) => {
      e.preventDefault();
      setError("");

      const nameErr = validateName(name);
      if (nameErr) {
        setError(nameErr);
        return;
      }

      const emailErr = validateEmail(email);
      if (emailErr) {
        setError(emailErr);
        return;
      }

      const body = {
        name: name.trim(),
        email: email.trim(),
        workspace,
        ...(groupId ? { groupId } : {}),
      };

      initiateOnboardingMutation.mutate(body, {
        onSuccess: () => {
          showToast?.("Client created — onboarding email sent", "success");
          onClose();
        },
        onError: (err) => setError(err.message),
      });
    },
    [name, email, groupId, workspace, initiateOnboardingMutation, onClose, showToast]
  );

  return (
    <BaseModal isOpen onClose={onClose} title="Add Client" titleId="add-client-title">
      <form onSubmit={handleSubmit} noValidate>
        <FormInput
          id="add-client-name"
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Client name"
          wrapperClassName="mb-4"
          disabled={initiateOnboardingMutation.isPending}
        />

        <FormInput
          id="add-client-email"
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="client@example.com"
          wrapperClassName="mb-4"
          disabled={initiateOnboardingMutation.isPending}
        />

        <div className="mb-5">
          <label
            htmlFor="add-client-group"
            className="block text-sm font-medium text-slate-700 dark:text-gray-300 mb-1 transition-colors"
          >
            Company (optional)
          </label>
          <select
            id="add-client-group"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            disabled={initiateOnboardingMutation.isPending}
            className="w-full rounded-md border border-slate-200 dark:border-gray-600 bg-white dark:bg-gray-900/50 px-3 py-2 text-slate-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-brand-500 dark:focus:ring-blue-500 focus:border-brand-500 dark:focus:border-blue-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">No company</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>

        <ErrorMessage message={error} className="mb-3" />

        <div className="flex justify-end gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={initiateOnboardingMutation.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" isLoading={initiateOnboardingMutation.isPending}>
            {initiateOnboardingMutation.isPending ? "Creating..." : "Create Client"}
          </Button>
        </div>
      </form>
    </BaseModal>
  );
}
