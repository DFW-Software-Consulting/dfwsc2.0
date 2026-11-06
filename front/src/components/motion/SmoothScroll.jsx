import Lenis from "lenis";
import "lenis/dist/lenis.css";
import { useEffect } from "react";
import { SMOOTH_SCROLL_DURATION, setSmoothScroll } from "../../utils/smoothScroll.js";

// Wheel/trackpad smoothing for the marketing pages only. Mounted by MotionRoot, so it
// exists only while Home, Pricing or Team is on screen and is destroyed on unmount;
// admin and portal routes keep native scrolling. It is off under reduced motion (and
// follows the setting live). Touch stays native (Lenis' default `syncTouch: false`), and
// it scrolls the real document, so keyboard, focus, find-in-page and window.scrollTo work.

const REDUCED = "(prefers-reduced-motion: reduce)";

export default function SmoothScroll() {
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(REDUCED);
    let lenis = null;

    const stop = () => {
      if (!lenis) return;
      setSmoothScroll(null);
      lenis.destroy();
      lenis = null;
    };
    const start = () => {
      if (lenis) return;
      lenis = new Lenis({
        autoRaf: true,
        lerp: 0.1,
        duration: SMOOTH_SCROLL_DURATION,
        // In-page links (#services) glide too; the sections' CSS scroll-margin-top clears the navbar.
        anchors: true,
      });
      setSmoothScroll(lenis);
    };
    const sync = () => (query.matches ? stop() : start());

    sync();
    query.addEventListener("change", sync);
    return () => {
      query.removeEventListener("change", sync);
      stop();
    };
  }, []);

  return null;
}
