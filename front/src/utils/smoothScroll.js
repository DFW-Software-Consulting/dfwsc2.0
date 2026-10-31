// Holds the active Lenis instance (marketing pages only) so scrollToSection can reuse
// the same easing as the mouse wheel without importing the library into the entry chunk.
let active = null;

export const getSmoothScroll = () => active;

export function setSmoothScroll(instance) {
  active = instance;
}

// Shared by the wheel (lerp) and programmatic scrolls so both feel the same.
export const SMOOTH_SCROLL_DURATION = 1.1;
