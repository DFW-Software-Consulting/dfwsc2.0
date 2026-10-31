// In-memory "how did they find us / what did they read" context for the contact form.
// Held in module state only: nothing is written to cookies, localStorage or sessionStorage.

// Public marketing routes only. Anything else (onboarding, admin, payment and key
// regeneration routes, unknown paths) is never recorded so tokens cannot leak into leads.
const PUBLIC_PATHS = new Set(["/", "/pricing", "/team", "/privacy"]);

const MAX_PAGES = 20;
const MAX_PATH = 200;
const MAX_HOST = 253;
const MAX_UTM = 100;
const MAX_SECONDS = 86400;
const UTM_KEYS = ["source", "medium", "campaign", "term", "content"];
const OWN_HOSTS = ["dfwsc.com", "localhost"];

let started = false;
let startedAt = 0;
let referrer;
let landingPath;
let utm;
let pages = [];

function allowedPath(pathname) {
  if (typeof pathname !== "string") return null;
  const path = pathname.split(/[?#]/)[0];
  const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (normalized.length > MAX_PATH || !PUBLIC_PATHS.has(normalized.toLowerCase())) return null;
  return normalized.toLowerCase();
}

function cleanText(value) {
  const cleaned = String(value)
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, "")
    .trim();
  // Truncate by code point so a surrogate pair is never split, then drop more code points
  // while the UTF-16 length is still over the limit (the backend's zod max counts UTF-16 units).
  const points = Array.from(cleaned).slice(0, MAX_UTM);
  while (points.join("").length > MAX_UTM) points.pop();
  return points.join("");
}

function externalReferrerHost(raw, currentHost) {
  if (!raw) return undefined;
  let host;
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
  const own = currentHost.toLowerCase().replace(/^www\./, "");
  if (!host || host.length > MAX_HOST || !/^[a-z0-9.-]+$/.test(host)) return undefined;
  if (host === own) return undefined;
  if (OWN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return undefined;
  return host;
}

export function recordPage(path) {
  const clean = allowedPath(path);
  if (!clean || pages[pages.length - 1] === clean) return;
  pages.push(clean);
  if (pages.length > MAX_PAGES) pages = pages.slice(-MAX_PAGES);
}

export function initVisitContext() {
  if (started) return;
  started = true;
  startedAt = Date.now();
  referrer = externalReferrerHost(document.referrer, window.location.hostname);
  landingPath = allowedPath(window.location.pathname) ?? undefined;

  // Campaign tags are only kept for a recordable landing page.
  if (!landingPath) return;
  const params = new URLSearchParams(window.location.search);
  const found = {};
  for (const key of UTM_KEYS) {
    const value = cleanText(params.get(`utm_${key}`) ?? "");
    if (value) found[key] = value;
  }
  if (Object.keys(found).length > 0) utm = found;
}

export function getVisitContext() {
  const context = {};
  if (referrer) context.referrer = referrer;
  if (landingPath) context.landingPath = landingPath;
  if (utm) context.utm = { ...utm };
  if (pages.length > 0) context.pages = [...pages];
  if (started) {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    context.secondsOnSite = Math.min(MAX_SECONDS, Math.max(0, seconds));
  }
  return context;
}
