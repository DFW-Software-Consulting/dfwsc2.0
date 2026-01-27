import { useEffect } from "react";

export const TOAST_TIMEOUT_MS = 5000;

const TOAST_STYLES = {
  success: "bg-green-600",
  error: "bg-red-600",
  warning: "bg-yellow-600",
  info: "bg-blue-600",
};

export default function Toast({ show, message, type = "info", onClose }) {
  useEffect(() => {
    if (show && onClose) {
      const timer = setTimeout(onClose, TOAST_TIMEOUT_MS);
      return () => clearTimeout(timer);
    }
  }, [show, message, type, onClose]);

  if (!show) return null;

  const bgColor = TOAST_STYLES[type] || TOAST_STYLES.info;

  return (
    <div
      className={`fixed bottom-4 right-4 px-6 py-3 rounded-md shadow-lg text-white font-medium z-50 ${bgColor}`}
      role="alert"
      aria-live="polite"
    >
      <div className="flex items-center gap-3">
        <span>{message}</span>
        {onClose && (
          <button
            onClick={onClose}
            className="ml-2 text-white/80 hover:text-white focus:outline-none"
            aria-label="Close notification"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
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
    </div>
  );
}
