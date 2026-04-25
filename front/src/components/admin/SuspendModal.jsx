import { useState } from "react";
import BaseModal from "./shared/BaseModal";
import Button from "./shared/Button";
import FormInput from "./shared/FormInput";

export default function SuspendModal({ isOpen, clientName, onConfirm, onClose }) {
  const [reason, setReason] = useState("");

  const handleConfirm = () => {
    onConfirm(reason.trim() || undefined);
    setReason("");
  };

  const handleClose = () => {
    setReason("");
    onClose();
  };

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={handleClose}
      title={`Suspend "${clientName}"?`}
      titleId="suspend-modal-title"
      size="sm"
    >
      <p className="text-gray-300 mb-4 text-sm">
        This sets their account to inactive. You can reinstate at any time.
      </p>
      <FormInput
        id="suspend-reason"
        label="Reason (optional)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="e.g. Overdue invoice — 30 days past due"
      />
      <div className="flex justify-end gap-3 mt-6">
        <Button variant="secondary" onClick={handleClose}>
          Cancel
        </Button>
        <Button variant="danger" onClick={handleConfirm}>
          Suspend
        </Button>
      </div>
    </BaseModal>
  );
}
