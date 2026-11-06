/**
 * The one expand/collapse control for the marketing pages (allowances, team bios, FAQ,
 * privacy). A native <details>/<summary>: keyboard and screen-reader support come from the
 * browser, and the content is in the HTML (and the prerender) whether or not it is open.
 * `summary` can be text or a heading element. The open animation is CSS only
 * (`.studio-disclosure` in studio.css: opacity/transform on the body, a rotating chevron),
 * and only runs once the visitor has toggled it (data-animate), never for an open-on-load one.
 */
const markToggled = (event) => {
  event.currentTarget.parentElement.dataset.animate = "";
};

export default function Disclosure({ summary, children, className = "", open = false }) {
  return (
    <details className={`studio-disclosure ${className}`.trim()} open={open || undefined}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: <summary> is natively interactive; the click only tags the element so the open animation skips open-on-load. */}
      <summary onClick={markToggled}>{summary}</summary>
      <div className="studio-disclosure-body">{children}</div>
    </details>
  );
}
