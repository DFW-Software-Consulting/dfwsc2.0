import { useState } from "react";
import { useDfwscClient } from "../../hooks/useClients";
import BaseModal from "./shared/BaseModal";
import Button from "./shared/Button";
import FormInput from "./shared/FormInput";

export default function AddClientModal({ isOpen, onClose, onCreated, showToast }) {
  const createClientMutation = useDfwscClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");

  const reset = () => {
    setName("");
    setEmail("");
    setPhone("");
    setError("");
  };

  const handleClose = () => {
    if (createClientMutation.isPending) return;
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

    createClientMutation.mutate(payload, {
      onSuccess: (record) => {
        showToast?.(`Client ${record.name} created.`, "success");
        onCreated?.(record);
        handleClose();
      },
      onError: (err) => {
        setError(err.message);
        showToast?.(err.message, "error");
      },
    });
  };

  const isSaving = createClientMutation.isPending;

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
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>

      <div className="mt-6 flex justify-end gap-3">
        <Button variant="secondary" onClick={handleClose} disabled={isSaving}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleSubmit} isLoading={isSaving}>
          Create Client
        </Button>
      </div>
    </BaseModal>
  );
}
