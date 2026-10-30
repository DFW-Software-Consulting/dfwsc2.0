import { useRef } from "react";
import { createPortal } from "react-dom";
import { useModalLayer } from "./useModalLayer";

const SIZE_CLASSES = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-5xl",
};

export default function BaseModal({ isOpen, onClose, title, titleId, size = "md", children }) {
  const backdropRef = useRef(null);
  const modalRef = useRef(null);

  useModalLayer({ isOpen, onClose, containerRef: modalRef });

  if (!isOpen) return null;

  const handleBackdropClick = (e) => {
    if (e.target === backdropRef.current) onClose();
  };

  // Portaled to <body> so the dialog escapes <main>'s stacking context and
  // always layers above the sticky site header.
  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled via document-level keydown listener in useModalLayer
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-[60] overflow-y-auto bg-black/60 backdrop-blur-sm p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="min-h-full flex items-start sm:items-center justify-center">
        <div
          ref={modalRef}
          tabIndex={-1}
          data-size={SIZE_CLASSES[size] ? size : "md"}
          className={`flex flex-col bg-page text-fg rounded-xl shadow-xl border border-line w-full min-w-0 max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-3rem)] transition-colors duration-300 ${SIZE_CLASSES[size] ?? SIZE_CLASSES.md}`}
        >
          <div className="flex shrink-0 justify-between items-start gap-4 px-6 pt-6 pb-4">
            <h3
              id={titleId}
              className="min-w-0 break-words text-lg font-semibold text-fg transition-colors"
            >
              {title}
            </h3>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded text-fg-muted hover:text-fg text-2xl leading-none transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              aria-label="Close"
            >
              &times;
            </button>
          </div>
          <div className="min-h-0 overflow-y-auto px-6 pb-6">{children}</div>
        </div>
      </div>
    </div>,
    document.body
  );
}
