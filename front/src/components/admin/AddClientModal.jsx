import { useState } from "react";
import { useDfwscClient } from "../../hooks/useClients";
import { useCreateCrmClient } from "../../hooks/useCrmClients";
import BaseModal from "./shared/BaseModal";
import Button from "./shared/Button";
import FormInput from "./shared/FormInput";

export default function AddClientModal({ isOpen, onClose, onCreated, showToast }) {
  const createClientMutation = useDfwscClient();
  const createCrmMutation = useCreateCrmClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [workspace, setWorkspace] = useState("client_portal");
  const [error, setError] = useState("");

  const reset = () => {
    setName("");
    setEmail("");
    setPhone("");
    setWorkspace("client_portal");
    setError("");
  };

  const handleClose = () => {
    if (createClientMutation.isPending || createCrmMutation.isPending) return;
    reset();
    onClose();
  };

  const handleSubmit = () => {
    setError("");
    if (!name.trim() || !email.trim()) {
      setError("Name and email are required.");
      return;
    }

    const payload = {
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim() || undefined,
    };

    const mutation = workspace === "dfwsc" ? createCrmMutation : createClientMutation;

    mutation.mutate(payload, {
      onSuccess: (record) => {
        const label = workspace === "dfwsc" ? "Contact" : "Client";
        showToast?.(`${label} ${record.name} created.`, "success");
        onCreated?.(record);
        handleClose();
      },
      onError: (err) => {
        setError(err.message);
        showToast?.(err.message, "error");
      },
    });
  };

  const isSaving = createClientMutation.isPending || createCrmMutation.isPending;

  return (
    <BaseModal isOpen={isOpen} onClose={handleClose} title="Add Client" titleId="add-client" size="md">
      <div className="space-y-4">
        <FormInput
          id="add-client-name"
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme Inc"
          disabled={isSaving}
        />
        <FormInput
          id="add-client-email"
          type="email"
          label="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="billing@acme.com"
          disabled={isSaving}
        />
        <FormInput
          id="add-client-phone"
          type="tel"
          label="Phone (optional)"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+1 (555) 555-0100"
          disabled={isSaving}
        />
        <div>
          <label htmlFor="add-client-workspace" className="mb-1 block text-sm font-medium text-gray-300">
            Type
          </label>
          <select
            id="add-client-workspace"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={isSaving}
          >
            <option value="client_portal">Portal Client (Stripe Connect)</option>
            <option value="dfwsc">DFWSC Contact (Nextcloud)</option>
          </select>
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>

      <div className="mt-6 flex justify-end gap-3">
        <Button variant="secondary" onClick={handleClose} disabled={isSaving}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleSubmit} isLoading={isSaving}>
          Create {workspace === "dfwsc" ? "Contact" : "Client"}
        </Button>
      </div>
    </BaseModal>
  );
}