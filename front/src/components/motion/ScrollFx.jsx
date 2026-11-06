import { m, useReducedMotion, useScroll, useTransform } from "motion/react";
import { createContext, useContext, useRef } from "react";

// Scroll-linked motion for the marketing pages: transforms and opacity only, driven by
// scroll position (motion's useScroll + useTransform). Every helper renders a plain
// element under reduced motion, so nothing is offset or faded there. Entrances are
// authored to finish (identity, opacity 1) before the block is well inside the viewport.

/** Progress 0 when the element's top enters at the viewport bottom, 1 when it reaches 60% down. */
const ENTER = ["start end", "start 0.6"];
/** Progress 0 at the top of the page-level element, 1 when it has scrolled fully out. */
export const LEAVE = ["start start", "end start"];
/** Progress 0 as the element enters at the bottom, 0.5 centered, 1 as it leaves at the top. */
export const PASS = ["start end", "end start"];

const IN = [0, 1];
const ZERO = [0, 0];
const ONE = [1, 1];

/** A scroll-progress MotionValue for the element behind `ref`. */
export function useSectionProgress(ref, offset = ENTER) {
  return useScroll({ target: ref, offset }).scrollYProgress;
}

// fx channels: { y, x, scale, rotate, opacity }, each `[inputRange, outputRange]` over 0..1.
function useFxStyle(progress, fx) {
  const y = useTransform(progress, fx.y?.[0] ?? IN, fx.y?.[1] ?? ZERO);
  const scale = useTransform(progress, fx.scale?.[0] ?? IN, fx.scale?.[1] ?? ONE);
  const rotate = useTransform(progress, fx.rotate?.[0] ?? IN, fx.rotate?.[1] ?? ZERO);
  const opacity = useTransform(progress, fx.opacity?.[0] ?? IN, fx.opacity?.[1] ?? ONE);
  const style = {};
  if (fx.y) style.y = y;
  if (fx.scale) style.scale = scale;
  if (fx.rotate) style.rotate = rotate;
  if (fx.opacity) style.opacity = opacity;
  return style;
}

/**
 * Applies `fx` to its own element. Tracks its own position unless a shared `progress`
 * MotionValue is passed (e.g. the hero text and card share one).
 */
export function ScrollFx({ as = "div", progress, offset = ENTER, fx, ...props }) {
  const reduced = useReducedMotion();
  const ref = useRef(null);
  const own = useSectionProgress(ref, offset);
  const style = useFxStyle(progress ?? own, fx);
  const Tag = m[as];
  return <Tag ref={ref} {...props} {...(reduced ? {} : { style })} />;
}

const GroupContext = createContext(null);

/** Tracks its own scroll progress and shares it with <ScrollItem>/<ScrollLine> descendants. */
export function ScrollGroup({ as = "div", offset = ENTER, ...props }) {
  const ref = useRef(null);
  const progress = useSectionProgress(ref, offset);
  const Tag = m[as];
  return (
    <GroupContext.Provider value={progress}>
      <Tag ref={ref} {...props} />
    </GroupContext.Provider>
  );
}

/**
 * Staggered child of a <ScrollGroup>: slides up `y` px and fades in over a window of the
 * group's progress that starts later for higher `index`. The default windows end by 1.0
 * (the last item settles exactly when the group is 60% up the viewport). `min` raises
 * the starting opacity, and `step`/`span` override the window (the process steps).
 */
export function ScrollItem({
  as = "div",
  index = 0,
  count = 1,
  y = 48,
  min = 0,
  step = 0.3 / count,
  span = 0.7,
  ...props
}) {
  const progress = useContext(GroupContext);
  // Outside a <ScrollGroup> there is no progress to drive, so render a plain element.
  if (!progress) {
    const Plain = m[as];
    return <Plain {...props} />;
  }
  return (
    <TrackedScrollItem
      as={as}
      progress={progress}
      index={index}
      y={y}
      min={min}
      step={step}
      span={span}
      {...props}
    />
  );
}

function TrackedScrollItem({ as, progress, index, y, min, step, span, ...props }) {
  const reduced = useReducedMotion();
  const start = index * step;
  const end = start + span;
  const style = useFxStyle(progress, {
    y: y
      ? [
          [start, end],
          [y, 0],
        ]
      : undefined,
    opacity: [
      [start, start + span * 0.6],
      [min, 1],
    ],
  });
  const Tag = m[as];
  return <Tag {...props} {...(reduced ? {} : { style })} />;
}

/** The fill line of a process list. Static and full under reduced motion. */
function ScrollLine() {
  const reduced = useReducedMotion();
  const progress = useContext(GroupContext);
  const scaleX = useTransform(progress, IN, IN);
  return (
    <span className="studio-process-line" aria-hidden="true">
      <m.span
        className="studio-process-fill studio-process-fill-x"
        style={reduced ? undefined : { scaleX }}
      />
      <m.span
        className="studio-process-fill studio-process-fill-y"
        style={reduced ? undefined : { scaleY: scaleX }}
      />
    </span>
  );
}

/** Thin brand-blue page progress bar across the top of the navbar. */
export function ScrollProgressBar() {
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll();
  if (reduced) return null;
  return (
    <m.div
      className="studio-scroll-progress"
      aria-hidden="true"
      style={{ scaleX: scrollYProgress }}
    />
  );
}

const PROCESS = ["start 0.85", "end 0.6"];

/** Numbered steps (`[number, title, copy]`) under a line that fills as you scroll; steps light up in turn. */
export function ProcessGrid({ steps }) {
  return (
    <ScrollGroup className="studio-process-grid" offset={PROCESS}>
      <ScrollLine />
      {steps.map(([number, title, copy], index) => (
        <ScrollItem as="article" key={number} index={index} step={0.3} span={0.25} y={0} min={0.4}>
          <span>{number}</span>
          <h3>{title}</h3>
          <p>{copy}</p>
        </ScrollItem>
      ))}
    </ScrollGroup>
  );
}

/** Page heroes (Pricing, Team): the copy trails the scroll a little and fades as it leaves. */
export const PAGE_HERO = {
  y: [IN, [0, 60]],
  opacity: [
    [0.6, 1],
    [1, 0.4],
  ],
};

/** A single block that rises into place (default ENTER offset). */
export const RISE = {
  y: [IN, [48, 0]],
  opacity: [
    [0, 0.6],
    [0, 1],
  ],
};
