export const DEFAULT_TIMEOUT_MS = 15000;

export async function apiFetch(
  path,
  { token, method = "GET", body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}
) {
  try {
    const res = await fetch(`${import.meta.env.VITE_API_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      // No caller passes its own signal today; if one ever does, honor it as-is
      // instead of layering our timeout on top.
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
    const contentType = res.headers.get("content-type") || "";
    let data;
    if (contentType.includes("application/json")) {
      data = await res.json();
    } else {
      const text = await res.text();
      data = res.ok ? null : { error: text.slice(0, 200) || `HTTP ${res.status}` };
    }
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new Error("Request timed out. Please try again.");
    }
    throw err;
  }
}
