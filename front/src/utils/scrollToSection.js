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
  const elementTop = element.getBoundingClientRect().top + window.scrollY;
  const targetPosition = Math.max(elementTop - headerOffset, 0);

  // The CSS reduced-motion rule doesn't reach JS-requested smooth scrolling.
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: targetPosition, behavior: reduceMotion ? "auto" : "smooth" });
  return true;
}
