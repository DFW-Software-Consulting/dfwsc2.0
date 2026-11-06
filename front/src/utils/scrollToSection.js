import { getSmoothScroll } from "./smoothScroll.js";

export function scrollToSection(id) {
  if (typeof window === "undefined" || !id) {
    return false;
  }

  const element = document.getElementById(id);
  if (!element) {
    return false;
  }

  const header = document.querySelector("header");
  const headerOffset = header ? header.offsetHeight : 0;

  // The CSS reduced-motion rule doesn't reach JS-requested smooth scrolling.
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  // Marketing pages run Lenis (never under reduced motion): use it so buttons and wheel match.
  const smooth = reduceMotion ? null : getSmoothScroll();
  if (smooth) {
    // Lenis already subtracts the element's CSS scroll-margin-top, so add it back.
    const margin = Number.parseFloat(getComputedStyle(element).scrollMarginTop) || 0;
    smooth.scrollTo(element, { offset: margin - headerOffset });
    return true;
  }

  const elementTop = element.getBoundingClientRect().top + window.scrollY;
  const targetPosition = Math.max(elementTop - headerOffset, 0);
  window.scrollTo({ top: targetPosition, behavior: reduceMotion ? "auto" : "smooth" });
  return true;
}

export function scrollToTop() {
  if (typeof window === "undefined") {
    return;
  }

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const smooth = reduceMotion ? null : getSmoothScroll();
  if (smooth) {
    smooth.scrollTo(0);
    return;
  }

  window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
}
