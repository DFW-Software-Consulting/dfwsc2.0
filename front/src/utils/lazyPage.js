import { lazy } from "react";

// When a preload error is suppressed (see preloadRecovery.js) Vite's helper
// resolves the import with undefined instead of rejecting. React's lazy would
// throw reading .default off it, so stay suspended until the reload lands.
export function lazyPage(load) {
  return lazy(() => load().then((mod) => mod ?? new Promise(() => {})));
}
