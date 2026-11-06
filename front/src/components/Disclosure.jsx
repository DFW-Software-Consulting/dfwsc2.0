import { useLayoutEffect, useRef } from "react";

/**
 * The one expand/collapse control for the marketing pages (allowances, team bios, FAQ,
 * privacy). A native <details>/<summary>: keyboard and screen-reader support come from the
 * browser, and the content is in the HTML (and the prerender) whether or not it is open.
 * `summary` can be text or a heading element. The open animation is CSS only
 * (`.studio-disclosure` in studio.css: opacity/transform on the body, a rotating chevron),
 * and only runs once the visitor has toggled it (data-animate), never for an open-on-load one.
 *
 * Pass a stable `id` when the disclosure sits under a Reveal helper below the fold: those
 * remount their subtree once after hydration (see useMotionTag), which would drop a
 * <details> the visitor already opened (even in the prerendered HTML, before any JS). On
 * unmount the open state is parked in a module map keyed by `id`; the next mount with that
 * id takes it back before paint (unclaimed entries are dropped on the next tick). Nothing is read at render time, so SSR and the hydrating
 * render are unchanged.
 */
const parked = new Map();
const useIsoLayoutEffect = typeof window === "undefined" ? () => {} : useLayoutEffect;

const markToggled = (event) => {
  event.currentTarget.parentElement.dataset.animate = "";
};

export default function Disclosure({ summary, children, className = "", open = false, id }) {
  const ref = useRef(null);
  useIsoLayoutEffect(() => {
    const details = ref.current;
    if (!id || !details) return undefined;
    if (parked.delete(id)) details.open = true;
    return () => {
      if (!details.open) return;
      parked.set(id, true);
      // A remount restores it in the same commit; anything still parked after that was a
      // real unmount (navigation), so drop it.
      setTimeout(() => parked.delete(id), 0);
    };
  }, [id]);
  return (
    <details ref={ref} className={`studio-disclosure ${className}`.trim()} open={open || undefined}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: <summary> is natively interactive; the click only tags the element so the open animation skips open-on-load. */}
      <summary onClick={markToggled}>{summary}</summary>
      <div className="studio-disclosure-body">{children}</div>
    </details>
  );
}
