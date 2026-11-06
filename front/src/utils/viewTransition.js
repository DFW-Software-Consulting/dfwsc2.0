// One place for the View Transitions API. `update` must apply its change to the DOM
// synchronously (the browser snapshots the page before and after it runs). Without API
// support, or with reduced motion, `update` runs plainly: the instant swap is the fallback.
//
// `className` is put on <html> for the length of the transition so index.css can scope
// its ::view-transition rules to this transition. `origin` (an element) makes the new
// view grow as a circle from that element's centre; clip-path is the only thing animated.

const REDUCED = "(prefers-reduced-motion: reduce)";

function canAnimate() {
  return (
    typeof document !== "undefined" &&
    typeof document.startViewTransition === "function" &&
    !(typeof window.matchMedia === "function" && window.matchMedia(REDUCED).matches)
  );
}

function circleReveal(origin) {
  const box = origin.getBoundingClientRect();
  const x = box.width ? box.left + box.width / 2 : window.innerWidth / 2;
  const y = box.height ? box.top + box.height / 2 : window.innerHeight / 2;
  const radius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y)
  );
  document.documentElement.animate(
    { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
    {
      duration: 520,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      pseudoElement: "::view-transition-new(root)",
    }
  );
}

// Latest run per class: an older transition that gets skipped must not strip the class a
// newer one still needs.
const latest = new Map();

export function runViewTransition(update, { className, origin } = {}) {
  if (!canAnimate()) {
    update();
    return;
  }
  const root = document.documentElement;
  const token = {};
  if (className) {
    latest.set(className, token);
    root.classList.add(className);
  }
  const transition = document.startViewTransition(update);
  if (origin)
    transition.ready.then(
      () => circleReveal(origin),
      () => {}
    );
  const cleanup = () => {
    if (className && latest.get(className) === token) {
      latest.delete(className);
      root.classList.remove(className);
    }
  };
  transition.finished.then(cleanup, cleanup);
}
