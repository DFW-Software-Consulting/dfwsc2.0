const STORAGE_KEY = "preload-reloaded-at";
const RELOAD_INTERVAL_MS = 10_000;

// A deploy removes the old hashed chunks, so a tab opened before it fails to
// import the next lazy route. Reload to pick up the new index.html, but at most
// once per interval so a chunk that stays missing cannot cause a reload loop.
export function handlePreloadError(event) {
  const last = Number(sessionStorage.getItem(STORAGE_KEY));
  if (Date.now() - last < RELOAD_INTERVAL_MS) return;
  // Only suppress the error when we reload; otherwise let the real one propagate.
  event.preventDefault();
  sessionStorage.setItem(STORAGE_KEY, String(Date.now()));
  window.location.reload();
}
