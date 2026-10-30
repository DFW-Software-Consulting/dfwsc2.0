import { useEffect } from "react";
import { createPortal } from "react-dom";

export const TOAST_TIMEOUT_MS = 5000;

const TOAST_STYLES = {
  success: "bg-green-700",
  error: "bg-red-700",
  warning: "bg-amber-700",
  info: "bg-blue-700",
};

export default function Toast({ show, message, type = "info", onClose }) {
  useEffect(() => {
    if (show && onClose) {
      const timer = setTimeout(onClose, TOAST_TIMEOUT_MS);
      return () => clearTimeout(timer);
    }
  }, [show, onClose]);

  if (!show) return null;

  const bgColor = TOAST_STYLES[type] || TOAST_STYLES.info;

  // Portaled to <body> so it layers above the sticky header and open dialogs.
  return createPortal(
    <div
      className={`fixed bottom-4 right-4 left-4 sm:left-auto sm:max-w-md px-6 py-3 rounded-md shadow-lg text-white font-medium z-[80] ${bgColor}`}
      role="alert"
      aria-live="polite"
    >
      <div className="flex items-center gap-3">
        <span className="min-w-0 break-words">{message}</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="ml-2 rounded text-white/80 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            aria-label="Close notification"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>
    </div>,
    document.body
  );
}
