import { useMotionValue, useSpring } from "motion/react";
import { useEffect, useState } from "react";
import { useMotionAllowed } from "./useMotionAllowed.js";

const FINE_POINTER = "(pointer: fine)";
const SPRING = { stiffness: 220, damping: 24, mass: 0.6 };

function useFinePointer() {
  const [fine, setFine] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(FINE_POINTER);
    const update = () => setFine(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return fine;
}

/** Writes the cursor position (percent) as --mx/--my and returns [px, py] (0..1); null for non-mouse input. */
function trackPointer(event) {
  if (event.pointerType !== "mouse") return null;
  const box = event.currentTarget.getBoundingClientRect();
  const px = (event.clientX - box.left) / box.width;
  const py = (event.clientY - box.top) / box.height;
  event.currentTarget.style.setProperty("--mx", `${px * 100}%`);
  event.currentTarget.style.setProperty("--my", `${py * 100}%`);
  return [px, py];
}

/**
 * Props to spread on a card so the stylesheet can paint a spotlight at the cursor (see
 * `.studio-spot`): the handler writes --mx/--my imperatively, so it never fights a `style`
 * prop owned by a scroll effect. One call can serve a whole list of cards. Returns an empty
 * object (no handlers) for touch/coarse pointers and reduced motion.
 */
export function useSpotlight() {
  const allowed = useMotionAllowed();
  const fine = useFinePointer();
  if (!allowed || !fine) return {};
  return { onPointerMove: trackPointer };
}

/**
 * Props to spread on a card for a subtle 3D tilt that follows the mouse, plus the
 * spotlight position from `useSpotlight` (one bounding-box read per move). Returns an
 * empty object for touch/coarse pointers and reduced motion. Transform only, so nothing
 * shifts layout.
 */
export function useTilt(max = 4) {
  const spotlight = useSpotlight();
  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const rotateX = useSpring(rx, SPRING);
  const rotateY = useSpring(ry, SPRING);

  if (!spotlight.onPointerMove) return {};
  return {
    style: { rotateX, rotateY, transformPerspective: 1200 },
    onPointerMove(event) {
      const at = spotlight.onPointerMove(event);
      if (!at) return;
      ry.set((at[0] - 0.5) * 2 * max);
      rx.set(-(at[1] - 0.5) * 2 * max);
    },
    onPointerLeave() {
      rx.set(0);
      ry.set(0);
    },
  };
}
