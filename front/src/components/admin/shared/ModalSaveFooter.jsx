import Button from "./Button";
import ErrorMessage from "./ErrorMessage";

export default function ModalSaveFooter({ error, onClose, onSave, isPending, disabled }) {
  return (
    <>
      <ErrorMessage message={error} className="mb-3" />

      <div className="flex justify-end gap-3">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" isLoading={isPending} disabled={disabled} onClick={onSave}>
          {isPending ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </>
  );
}
