import { useMotionValue, useSpring } from "motion/react";
import { useEffect, useState } from "react";
import { useMotionAllowed } from "./useMotionAllowed.js";

const FINE_POINTER = "(pointer: fine)";
const SPRING = { stiffness: 220, damping: 24, mass: 0.6 };

/**
 * Props to spread on a card for a subtle 3D tilt that follows the mouse. The same handler
 * writes --mx/--my (percent) so the stylesheet can paint a spotlight/glare at the cursor.
 * Returns an empty object (no tilt, no handlers) for touch/coarse pointers and reduced
 * motion. Transform only, so nothing shifts layout.
 */
export function useTilt(max = 4) {
  const allowed = useMotionAllowed();
  const [fine, setFine] = useState(false);
  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const rotateX = useSpring(rx, SPRING);
  const rotateY = useSpring(ry, SPRING);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(FINE_POINTER);
    const update = () => setFine(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  if (!allowed || !fine) return {};
  return {
    style: { rotateX, rotateY, transformPerspective: 1200 },
    onPointerMove(event) {
      if (event.pointerType !== "mouse") return;
      const box = event.currentTarget.getBoundingClientRect();
      const px = (event.clientX - box.left) / box.width;
      const py = (event.clientY - box.top) / box.height;
      ry.set((px - 0.5) * 2 * max);
      rx.set(-(py - 0.5) * 2 * max);
      event.currentTarget.style.setProperty("--mx", `${px * 100}%`);
      event.currentTarget.style.setProperty("--my", `${py * 100}%`);
    },
    onPointerLeave() {
      rx.set(0);
      ry.set(0);
    },
  };
}
