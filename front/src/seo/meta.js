// Single source of truth for per-route page metadata. Used by the client head manager
// (<Seo />) on every navigation and by the build-time prerender, so the HTML a crawler
// receives and the head the browser maintains cannot drift apart.

export const SITE_URL = "https://dfwsc.com";
export const SITE_NAME = "DFW Software Consulting";
export const THEME_COLOR = "#2c6daf";
export const OG_IMAGE = `${SITE_URL}/DFWSC-Logo-HorizWordmarkPNG.png`;

const DEFAULT_DESCRIPTION =
  "Your development team for websites, custom software, and simpler workflows. Based in Dallas–Fort Worth, working with small businesses everywhere.";

const publicPage = (title, description) => ({ title, description, indexable: true });
const privatePage = (title) => ({
  title: `${title} - ${SITE_NAME}`,
  description: DEFAULT_DESCRIPTION,
  indexable: false,
});

/** Routes that are crawlable and appear in the sitemap. */
export const PUBLIC_ROUTES = {
  "/": publicPage(
    `Custom Software & Web Development in Dallas–Fort Worth | ${SITE_NAME}`,
    DEFAULT_DESCRIPTION
  ),
  "/pricing": publicPage(
    `Website Hosting & Dev Retainer Pricing | ${SITE_NAME}`,
    "Hosting and maintenance plans from $40 to $200 a month, plus quoted projects and a custom dev retainer. See exactly what each plan includes."
  ),
  "/team": publicPage(
    `Our Team: Software Developers in Dallas–Fort Worth | ${SITE_NAME}`,
    "Meet the small team behind DFW Software Consulting: full-stack, DevOps, and network engineers who build and run software for small businesses."
  ),
  "/privacy": publicPage(
    `Privacy Policy | ${SITE_NAME}`,
    "How DFW Software Consulting handles your information: what the contact form collects, how visit context is used, and what we never do. No analytics or tracking cookies."
  ),
  "/docs": publicPage(
    `Payment API Documentation | ${SITE_NAME}`,
    "Developer reference for the DFWSC payment platform: create a payment, redirect to Stripe Checkout, and confirm the result from your backend."
  ),
};

/** Portal and utility routes: served as the SPA shell and kept out of search indexes. */
const PRIVATE_ROUTES = {
  "/admin": privatePage("Admin"),
  "/demos": privatePage("Sample Sites"),
  "/onboard": privatePage("Client Onboarding"),
  "/payment-success": privatePage("Payment Status"),
  "/payment-cancel": privatePage("Payment Canceled"),
  "/onboarding-success": privatePage("Onboarding Complete"),
  "/regenerate-key": privatePage("Regenerate API Key"),
  "/request-key-regeneration": privatePage("Regenerate API Key"),
};

export const NOT_FOUND_META = privatePage("Page Not Found");

/** Head of the unrendered SPA shell: generic, and never indexed. */
export const SHELL_META = { ...privatePage("Portal"), title: SITE_NAME };

/** Pathnames handled by nginx as the SPA shell (kept in sync with front/nginx.conf). */
export const PRIVATE_PATHS = Object.keys(PRIVATE_ROUTES);

/** Normalise a pathname to the key used above: lower case, no trailing slash. */
export function normalizePath(pathname) {
  const path = pathname.toLowerCase().replace(/\/+$/, "");
  return path === "" ? "/" : path;
}

/** The metadata for a pathname, or the (noindex) not-found metadata for unknown paths. */
export function resolveMeta(pathname) {
  const path = normalizePath(pathname);
  return PUBLIC_ROUTES[path] ?? PRIVATE_ROUTES[path] ?? NOT_FOUND_META;
}

export function canonicalUrl(pathname) {
  const path = normalizePath(pathname);
  return path === "/" ? `${SITE_URL}/` : `${SITE_URL}${path}`;
}
