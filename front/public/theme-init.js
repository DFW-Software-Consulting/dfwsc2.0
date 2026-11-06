// Blocking script (CSP forbids inline): sets the theme class on <html> before first paint so
// dark-theme visitors never see the light prerendered page. Mirrors readTheme() in
// src/contexts/ThemeContext.jsx: stored choice first, then the OS preference.
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem("theme");
  } catch (e) {
    // Storage blocked: fall back to the OS preference.
  }
  if (!theme) {
    try {
      theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch (e) {
      theme = "light";
    }
  }
  var root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(theme);
})();
