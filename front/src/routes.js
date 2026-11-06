import { matchPath } from "react-router-dom";
import { lazyPage } from "./utils/lazyPage.js";

// Route table: path and lazy page component. App renders from it, and the client preloads
// the matched page before hydrating so Suspense never falls back over prerendered HTML.
export const routes = [
  { path: "/", Page: lazyPage(() => import("./pages/Home.jsx")) },
  { path: "/pricing", Page: lazyPage(() => import("./pages/Pricing.jsx")) },
  { path: "/team", Page: lazyPage(() => import("./pages/Team.jsx")) },
  { path: "/privacy", Page: lazyPage(() => import("./pages/Privacy.jsx")) },
  { path: "/onboard", Page: lazyPage(() => import("./pages/OnboardClient")) },
  { path: "/demos", Page: lazyPage(() => import("./pages/Demos.jsx")) },
  { path: "/admin", Page: lazyPage(() => import("./pages/AdminPage")) },
  { path: "/payment-success", Page: lazyPage(() => import("./pages/PaymentSuccess")) },
  { path: "/payment-cancel", Page: lazyPage(() => import("./pages/PaymentCancel")) },
  { path: "/onboarding-success", Page: lazyPage(() => import("./pages/OnboardingSuccess")) },
  { path: "/regenerate-key", Page: lazyPage(() => import("./pages/RegenerateApiKey")) },
  {
    path: "/request-key-regeneration",
    Page: lazyPage(() => import("./pages/RequestApiKeyRegeneration")),
  },
  { path: "*", Page: lazyPage(() => import("./pages/NotFound")) },
];

/** Start loading the page module for a pathname; resolves when it is ready. */
export function preloadRoute(pathname) {
  const route = routes.find(({ path }) => matchPath({ path, end: true }, pathname));
  return route ? route.Page.preload() : Promise.resolve();
}
