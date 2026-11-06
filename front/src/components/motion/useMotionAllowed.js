import { useReducedMotion } from "motion/react";
import { useIsClient } from "../../utils/useIsClient.js";

/**
 * Whether motion styles may be applied. False on the server and while hydrating, so the
 * prerendered HTML and the hydrating render are both plain, fully visible elements; it
 * flips to the real answer (motion allowed and not reduced) right after hydration.
 */
export function useMotionAllowed() {
  const isClient = useIsClient();
  const reduced = useReducedMotion();
  return isClient && !reduced;
}
