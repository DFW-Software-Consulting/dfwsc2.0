import { useEffect, useLayoutEffect, useRef } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Open modal layers, oldest first. Only the last entry reacts to Escape/Tab,
// and the body stays scroll-locked until the stack is empty.
const layers = [];
let savedBodyOverflow = "";

function lockBody() {
  if (layers.length === 1) {
    savedBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
}

function unlockBody() {
  if (layers.length === 0) document.body.style.overflow = savedBodyOverflow;
}

/**
 * Shared modal behavior: stack-aware Escape, Tab/Shift+Tab focus trap,
 * reference-counted body scroll lock, and focus restore on close or unmount.
 * Focus moves to `initialFocusRef` (or the container) after open.
 */
export function useModalLayer({ isOpen, onClose, containerRef, initialFocusRef }) {
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!isOpen) return;
    const layer = {};
    const previousFocus = document.activeElement;
    layers.push(layer);
    lockBody();

    const timer = setTimeout(() => {
      (initialFocusRef?.current ?? containerRef.current)?.focus();
    }, 0);

    const handleKeyDown = (e) => {
      if (layers[layers.length - 1] !== layer) return;
      if (e.key === "Escape") {
        onCloseRef.current?.();
        return;
      }
      if (e.key !== "Tab") return;
      const container = containerRef.current;
      if (!container) return;
      const focusable = container.querySelectorAll(FOCUSABLE);
      if (focusable.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!container.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === container)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    // Runs on close *and* on unmount: callers like ClientProfileView render the
    // modal with `isOpen` always true and unmount it to close.
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", handleKeyDown);
      const index = layers.indexOf(layer);
      if (index !== -1) layers.splice(index, 1);
      unlockBody();
      // Skip openers that were removed along with this modal (e.g. a button inside
      // a parent modal closing in the same commit) so focus isn't dropped to <body>.
      if (previousFocus?.isConnected) previousFocus.focus?.();
    };
  }, [isOpen, containerRef, initialFocusRef]);
}
