import { useRef } from "react";
import { createPortal } from "react-dom";
import { useModalLayer } from "./shared/useModalLayer";

export default function ConfirmModal({
  isOpen,
  title,
  message,
  onConfirm,
  onCancel,
  confirmText = "Confirm",
  cancelText = "Cancel",
  confirmVariant = "danger",
}) {
  const modalRef = useRef(null);
  const panelRef = useRef(null);
  const confirmButtonRef = useRef(null);

  useModalLayer({
    isOpen,
    onClose: onCancel,
    containerRef: panelRef,
    initialFocusRef: confirmButtonRef,
  });

  if (!isOpen) return null;

  const handleBackdropClick = (e) => {
    if (e.target === modalRef.current) {
      onCancel();
    }
  };

  const confirmButtonStyles = {
    danger: "bg-red-600 hover:bg-red-700 focus:ring-red-400",
    success: "bg-green-700 hover:bg-green-800 focus:ring-green-400",
    primary: "bg-brand-500 hover:bg-brand-600 focus:ring-brand-400",
  };

  // Portaled to <body> so it layers above the sticky header (see BaseModal).
  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled via document-level keydown listener in useModalLayer
    <div
      ref={modalRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      aria-describedby="modal-description"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="bg-card rounded-lg shadow-xl border border-line p-6 max-w-md w-full max-h-full overflow-y-auto focus:outline-none"
      >
        <h3 id="modal-title" className="text-lg font-semibold text-fg mb-2">
          {title}
        </h3>
        <p id="modal-description" className="text-fg-muted mb-6">
          {message}
        </p>
        <div className="flex flex-wrap justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 max-md:min-h-11 pointer-coarse:min-h-11 rounded-md border border-line bg-surface hover:border-line-strong text-fg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-focus"
          >
            {cancelText}
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            onClick={onConfirm}
            className={`px-4 py-2 max-md:min-h-11 pointer-coarse:min-h-11 rounded-md text-white font-medium transition-colors focus:outline-none focus:ring-2 ${confirmButtonStyles[confirmVariant]}`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
