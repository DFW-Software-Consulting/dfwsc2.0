// Redirect URLs for the client-facing Connect onboarding link come from the calling app, and
// Stripe sends the user's browser there afterwards, so each one is checked against an allowlist of
// origins an admin stored on the client (clients.connect_redirect_origins).

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isAcceptableScheme(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
}

/**
 * Canonical form of an allowlist entry, or null when it is not a bare origin: https only (plain
 * http only for localhost), no credentials, no path, query or fragment.
 */
export function normalizeRedirectOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!isAcceptableScheme(url)) return null;
  if (url.username || url.password) return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;
  return url.origin;
}

/** True when `value` is an absolute https (or localhost http) URL whose origin is allowlisted. */
export function isAllowedRedirectUrl(value: string, allowedOrigins: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!isAcceptableScheme(url)) return false;
  if (url.username || url.password) return false;
  return allowedOrigins.includes(url.origin);
}
