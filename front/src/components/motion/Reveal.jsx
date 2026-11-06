import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import { ScrollProgressBar } from "./ScrollFx.jsx";
import SmoothScroll from "./SmoothScroll.jsx";

// Shared motion helpers for the marketing pages only (Home, Pricing, Team).
// Everything is opacity/transform so nothing shifts layout. Content is never left
// hidden: without IntersectionObserver or with reduced motion, every helper renders a
// plain element in its final state and no hidden "initial" style is applied. That check
// (useMotionTag) is the only reduced-motion gate, so no MotionConfig is needed.

const EASE = [0.22, 1, 0.36, 1];
const OFFSET = 16;
// "some" fires as soon as any pixel is visible, so blocks taller than the viewport still reveal.
// The bottom margin starts a reveal slightly before the block enters view, so fast touch
// flings don't land on blank, still-hidden content.
const VIEWPORT = { once: true, amount: "some", margin: "0px 0px 15% 0px" };

/** `[Tag, animated]`: with `animated` false, render Tag without any animation props. */
function useMotionTag(as) {
  const reduced = useReducedMotion();
  return [m[as], !reduced && typeof IntersectionObserver !== "undefined"];
}

export function MotionRoot({ children }) {
  return (
    <LazyMotion features={domAnimation} strict>
      <SmoothScroll />
      <ScrollProgressBar />
      {children}
    </LazyMotion>
  );
}

/** Fade up once when scrolled into view. `mount` animates on load instead (hero). */
export function Reveal({ as = "div", delay = 0, y = OFFSET, mount = false, ...props }) {
  const [Tag, animated] = useMotionTag(as);
  if (!animated) return <Tag {...props} />;
  const target = { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE, delay } };
  return (
    <Tag
      {...props}
      initial={{ opacity: 0, y }}
      {...(mount ? { animate: target } : { whileInView: target, viewport: VIEWPORT })}
    />
  );
}

/** Container that staggers its <RevealItem> children. */
export function RevealGroup({ as = "div", stagger = 0.08, mount = false, ...props }) {
  const [Tag, animated] = useMotionTag(as);
  if (!animated) return <Tag {...props} />;
  const variants = {
    hidden: {},
    show: { transition: { staggerChildren: stagger, delayChildren: 0.05 } },
  };
  return (
    <Tag
      {...props}
      variants={variants}
      initial="hidden"
      {...(mount ? { animate: "show" } : { whileInView: "show", viewport: VIEWPORT })}
    />
  );
}

export function RevealItem({ as = "div", y = OFFSET, ...props }) {
  const [Tag, animated] = useMotionTag(as);
  if (!animated) return <Tag {...props} />;
  return (
    <Tag
      {...props}
      variants={{
        hidden: { opacity: 0, y },
        show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } },
      }}
    />
  );
}

/** Re-plays a short slide/fade whenever `id` changes (tab content). `skipFirst` skips the first render. */
export function Swap({ as = "div", id, skipFirst = false, ...props }) {
  const [Tag, animated] = useMotionTag(as);
  if (!animated || skipFirst) return <Tag key={id} {...props} />;
  return (
    <Tag
      key={id}
      {...props}
      initial={{ opacity: 0, x: 14 }}
      animate={{ opacity: 1, x: 0, transition: { duration: 0.4, ease: EASE } }}
    />
  );
}
