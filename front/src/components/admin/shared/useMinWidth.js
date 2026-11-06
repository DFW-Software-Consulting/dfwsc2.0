import { useSyncExternalStore } from "react";

// Tailwind's md breakpoint. Tables render at or above it, stacked cards below it.
const MD_QUERY = "(min-width: 768px)";

function subscribe(onChange) {
  const mql = window.matchMedia(MD_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

const getSnapshot = () => window.matchMedia(MD_QUERY).matches;
// No matchMedia (jsdom, SSR) means the full table layout.
const getServerSnapshot = () => true;

/** True at >= 768px. Falls back to true where matchMedia is unavailable. */
export function useIsDesktop() {
  const supported = typeof window !== "undefined" && typeof window.matchMedia === "function";
  return useSyncExternalStore(
    supported ? subscribe : () => () => {},
    supported ? getSnapshot : getServerSnapshot,
    getServerSnapshot
  );
}
