import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False on the server and during hydration, true for every render after. Anything that
 * depends on the browser (stored theme, clock, motion preferences) reads this first so the
 * hydrating render matches the prerendered HTML, then settles on the real value.
 */
export function useIsClient() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
}
