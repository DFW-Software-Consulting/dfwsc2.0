import { domAnimation, LazyMotion, m } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
import { ScrollProgressBar } from "./ScrollFx.jsx";
import SmoothScroll from "./SmoothScroll.jsx";
import { useMotionAllowed } from "./useMotionAllowed.js";

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

const useIsoLayoutEffect = typeof window === "undefined" ? () => {} : useLayoutEffect;

const inViewport = (element) => {
  const rect = element?.getBoundingClientRect();
  return Boolean(rect) && rect.top < window.innerHeight && rect.bottom > 0;
};

/**
 * `[Tag, animated, ref]`: with `animated` false, render Tag without any animation props.
 *
 * Elements that first render while hydrating prerendered HTML are already on screen as
 * plain, final-state markup. When motion switches on, those that are in the viewport (or
 * are `mount` reveals) stay plain so nothing visible vanishes and fades back in; only
 * content below the fold gets the scroll reveal. Elements mounted later (client-side
 * navigation) animate as usual.
 */
function useMotionTag(as, mount = false) {
  const allowed = useMotionAllowed();
  const supported = allowed && typeof IntersectionObserver !== "undefined";
  const ref = useRef(null);
  const wasHydrating = useRef(!allowed);
  const [animated, setAnimated] = useState(supported);

  useIsoLayoutEffect(() => {
    if (!supported) {
      setAnimated(false);
    } else if (wasHydrating.current) {
      wasHydrating.current = false;
      setAnimated(!(mount || inViewport(ref.current)));
    } else {
      setAnimated(true);
    }
  }, [supported, mount]);

  return [m[as], animated, ref];
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
  const [Tag, animated, ref] = useMotionTag(as, mount);
  if (!animated) return <Tag key="plain" ref={ref} {...props} />;
  const target = { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE, delay } };
  return (
    <Tag
      key="animated"
      ref={ref}
      {...props}
      initial={{ opacity: 0, y }}
      {...(mount ? { animate: target } : { whileInView: target, viewport: VIEWPORT })}
    />
  );
}

/** Container that staggers its <RevealItem> children. */
export function RevealGroup({ as = "div", stagger = 0.08, mount = false, ...props }) {
  const [Tag, animated, ref] = useMotionTag(as, mount);
  if (!animated) return <Tag key="plain" ref={ref} {...props} />;
  const variants = {
    hidden: {},
    show: { transition: { staggerChildren: stagger, delayChildren: 0.05 } },
  };
  return (
    <Tag
      key="animated"
      ref={ref}
      {...props}
      variants={variants}
      initial="hidden"
      {...(mount ? { animate: "show" } : { whileInView: "show", viewport: VIEWPORT })}
    />
  );
}

export function RevealItem({ as = "div", y = OFFSET, ...props }) {
  const [Tag, animated, ref] = useMotionTag(as);
  if (!animated) return <Tag key="plain" ref={ref} {...props} />;
  return (
    <Tag
      key="animated"
      ref={ref}
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
  const [Tag, animated, ref] = useMotionTag(as, true);
  if (!animated || skipFirst) return <Tag key={id} ref={ref} {...props} />;
  return (
    <Tag
      key={id}
      ref={ref}
      {...props}
      initial={{ opacity: 0, x: 14 }}
      animate={{ opacity: 1, x: 0, transition: { duration: 0.4, ease: EASE } }}
    />
  );
}
