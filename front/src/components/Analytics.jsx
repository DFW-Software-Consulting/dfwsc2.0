import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

const ANALYTICS_SRC = import.meta.env.VITE_ANALYTICS_SRC;
const ANALYTICS_DOMAIN = import.meta.env.VITE_ANALYTICS_DOMAIN;
const LOADER_SELECTOR = 'script[data-analytics-loader="dfwsc"]';

// Set once the admin area has been opened in this document. Analytics then stays off until
// a full reload, so a third-party script never shares a page with the admin session token.
let adminOpened = false;

const isAdminPath = (pathname) => pathname === "/admin" || pathname.startsWith("/admin/");

/**
 * Cookieless, Plausible-compatible analytics loader.
 * Complete no-op unless VITE_ANALYTICS_SRC is set — injects nothing and
 * makes no network calls in that case. Never hardcodes an analytics domain.
 *
 * Never loads on /admin or below: the third-party script has full page access and
 * the admin JWT lives in page memory. If the script is already running when the user
 * navigates client-side into /admin, the page is reloaded so it starts without it.
 */
export default function Analytics() {
  const { pathname } = useLocation();
  const admin = isAdminPath(pathname);
  // Removing the tag on cleanup does not undo what the script already did to the page.
  const injected = useRef(false);

  useEffect(() => {
    if (!ANALYTICS_SRC) return;

    if (admin) {
      adminOpened = true;
      // A script from an earlier marketing page cannot be unloaded; start over without it.
      if (injected.current || document.querySelector(LOADER_SELECTOR)) window.location.reload();
      return;
    }
    if (adminOpened) return;
    if (document.querySelector(LOADER_SELECTOR)) return;

    const script = document.createElement("script");
    script.src = ANALYTICS_SRC;
    script.defer = true;
    script.dataset.analyticsLoader = "dfwsc";
    if (ANALYTICS_DOMAIN) {
      script.dataset.domain = ANALYTICS_DOMAIN;
    }
    document.head.appendChild(script);
    injected.current = true;

    return () => {
      script.remove();
    };
  }, [admin]);

  return null;
}
