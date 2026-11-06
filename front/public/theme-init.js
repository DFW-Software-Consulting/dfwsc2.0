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

// Stale-asset rescue. After a deploy a prerendered <link>/<script> under /assets/ can fail
// (a 404 kept by a browser or CDN), and if the main bundle fails no app code runs at all.
// This file is unhashed and always revalidated, so it is the one place that still runs.
// error events on link/script do not bubble, hence the capture phase. Same guard key and
// 30s window as src/utils/preloadRecovery.js: refetch bypassing the cache, reload once.
window.addEventListener(
  "error",
  function (event) {
    var el = event.target;
    var url = el && (el.tagName === "SCRIPT" ? el.src : el.tagName === "LINK" ? el.href : "");
    if (!url || url.indexOf(location.origin + "/assets/") !== 0) return;
    try {
      var last = Number(sessionStorage.getItem("preload-reloaded-at")) || 0;
      if (Date.now() - last < 30000) return;
      sessionStorage.setItem("preload-reloaded-at", String(Date.now()));
    } catch (e) {
      return;
    }
    // Tell the app (isRecovering() in src/utils/preloadRecovery.js) so its ErrorBoundary
    // stays blank: this error reaches us before a lazy import() rejects.
    window.__dfwscRecovering = true;
    var reloaded = false;
    var reload = function () {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    };
    fetch(url, { cache: "reload" }).then(reload, reload);
    setTimeout(reload, 5000);
  },
  true
);
