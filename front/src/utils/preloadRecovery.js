const STORAGE_KEY = "preload-reloaded-at";
const RECOVERY_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 5_000;

const CHUNK_ERROR_PATTERN =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i;

export function isChunkLoadError(error) {
  const message = typeof error === "string" ? error : error?.message;
  return typeof message === "string" && CHUNK_ERROR_PATTERN.test(message);
}

// Pulls the failed asset URL out of the browser's message, e.g. "Failed to fetch
// dynamically imported module: https://x/assets/Demos-abc.js" or "Unable to preload CSS
// for /assets/x.css". Returns null when there is none (Safari's message has no URL).
export function extractAssetUrl(error) {
  const message = typeof error === "string" ? error : error?.message;
  if (typeof message !== "string") return null;
  const match = message.match(/(?:https?:\/\/[^\s'")]+|\/assets\/[^\s'")]+)/);
  return match ? match[0] : null;
}

// A deploy replaces the hashed chunks, and a 404 for one can sit in the browser's HTTP
// cache (older nginx configs let Cloudflare add a 4h max-age to it). Re-fetch the asset
// with cache: "reload" to overwrite any poisoned entry, then reload the page once.
async function refetchAndReload(url) {
  try {
    if (url) {
      await fetch(url, { cache: "reload", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    }
  } catch {
    // Offline or timed out: reload anyway, the guard prevents a loop.
  }
  window.location.reload();
}

// Starts one recovery per interval (tracked in sessionStorage so it survives the reload).
// Returns true when a recovery was started, false when one already ran recently, in which
// case the caller should show the real error.
export function startRecovery(error) {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(STORAGE_KEY)) || 0;
  } catch {
    return false;
  }
  if (Date.now() - last < RECOVERY_INTERVAL_MS) return false;
  try {
    sessionStorage.setItem(STORAGE_KEY, String(Date.now()));
  } catch {
    return false;
  }
  refetchAndReload(extractAssetUrl(error));
  return true;
}

export function handlePreloadError(event) {
  // Only suppress the error when we recover; otherwise let the real one propagate.
  if (startRecovery(event.payload)) event.preventDefault();
}
