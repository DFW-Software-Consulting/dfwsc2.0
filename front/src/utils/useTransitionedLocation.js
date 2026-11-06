import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { preloadRoute } from "../routes.js";
import { runViewTransition } from "./viewTransition.js";

// Marketing routes cross-fade into each other. Admin, onboarding and payment routes are
// left out and swap plainly, as before.
const ANIMATED = new Set(["/", "/pricing", "/team", "/privacy", "/demos"]);
// Longest the old page stays up waiting for the next page's chunk. Past it the swap happens
// anyway and Suspense shows its fallback, same as without transitions.
const MAX_WAIT_MS = 1500;

const animates = (from, to) => from !== to && ANIMATED.has(from) && ANIMATED.has(to);

/**
 * The location <Routes> should render. On a marketing-to-marketing navigation it holds the
 * old location until the new page's chunk is loaded (so the Suspense fallback never shows),
 * then swaps inside a view transition. A failed or stuck chunk load falls through to the
 * normal lazy/ErrorBoundary/preloadRecovery handling once the swap happens.
 */
export function useTransitionedLocation(location) {
  const [shown, setShown] = useState(location);
  const hold = animates(shown.pathname, location.pathname);

  // Everything else follows the router immediately (adjusted during render, like Navbar).
  if (!hold && shown !== location) setShown(location);

  useEffect(() => {
    if (!hold) return undefined;
    let cancelled = false;
    const wait = new Promise((resolve) => setTimeout(resolve, MAX_WAIT_MS));
    Promise.race([preloadRoute(location.pathname).catch(() => {}), wait]).then(() => {
      if (cancelled) return;
      runViewTransition(() => flushSync(() => setShown(location)), { className: "route-vt" });
    });
    return () => {
      cancelled = true;
    };
  }, [hold, location]);

  return hold ? shown : location;
}
