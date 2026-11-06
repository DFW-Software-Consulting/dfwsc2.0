import { useEffect } from "react";

const ANALYTICS_SRC = import.meta.env.VITE_ANALYTICS_SRC;
const ANALYTICS_DOMAIN = import.meta.env.VITE_ANALYTICS_DOMAIN;

/**
 * Cookieless, Plausible-compatible analytics loader.
 * Complete no-op unless VITE_ANALYTICS_SRC is set — injects nothing and
 * makes no network calls in that case. Never hardcodes an analytics domain.
 */
export default function Analytics() {
  useEffect(() => {
    if (!ANALYTICS_SRC) return;
    if (document.querySelector(`script[data-analytics-loader="dfwsc"]`)) return;

    const script = document.createElement("script");
    script.src = ANALYTICS_SRC;
    script.defer = true;
    script.dataset.analyticsLoader = "dfwsc";
    if (ANALYTICS_DOMAIN) {
      script.dataset.domain = ANALYTICS_DOMAIN;
    }
    document.head.appendChild(script);

    return () => {
      script.remove();
    };
  }, []);

  return null;
}
