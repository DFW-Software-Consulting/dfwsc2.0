import { useEffect } from "react";

/**
 * Sets document.title to `${title} - DFW Software Consulting` for the lifetime of the
 * mounted component. Pass a falsy title to skip (no-op).
 */
export function usePageTitle(title) {
  useEffect(() => {
    if (!title) return;
    document.title = `${title} - DFW Software Consulting`;
  }, [title]);
}
