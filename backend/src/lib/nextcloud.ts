import CircuitBreaker from "opossum";

// Shared Nextcloud access as one service account (NEXTCLOUD_USERNAME with an app
// password). Nextcloud is optional: callers check getNextcloudConfig() and degrade
// when it is not configured. Calls go through a breaker of their own, so a
// Nextcloud outage never touches the Stripe or SMTP breakers the payment routes
// depend on.
//
// Errors never carry a request path or URL: WebDAV and CardDAV paths contain
// company names and contact ids. Every request has a fixed `label` (for example
// "webdav.mkcol") that is used in error messages and logs instead.

const NEXTCLOUD_REQUEST_TIMEOUT_MS = 8_000;

export interface NextcloudConfig {
  baseUrl: string;
  username: string;
  appPassword: string;
}

export type NextcloudConfigResult =
  | { ok: true; config: NextcloudConfig }
  | { ok: false; reason: "not_configured" | "invalid_base_url" };

export function getNextcloudConfig(env: NodeJS.ProcessEnv = process.env): NextcloudConfigResult {
  const baseUrl = env.NEXTCLOUD_BASE_URL?.trim();
  const username = env.NEXTCLOUD_USERNAME?.trim();
  const appPassword = env.NEXTCLOUD_APP_PASSWORD;
  if (!baseUrl || !username || !appPassword) return { ok: false, reason: "not_configured" };
  try {
    if (new URL(baseUrl).protocol !== "https:") return { ok: false, reason: "invalid_base_url" };
  } catch {
    return { ok: false, reason: "invalid_base_url" };
  }
  return { ok: true, config: { baseUrl: baseUrl.replace(/\/+$/, ""), username, appPassword } };
}

/** Nextcloud answered with a status the caller did not list as acceptable. */
export class NextcloudHttpError extends Error {
  constructor(
    readonly status: number,
    readonly label: string
  ) {
    super(`Nextcloud answered ${status} for ${label}`);
    this.name = "NextcloudHttpError";
  }
}

/** The request never got an HTTP answer (timeout or connection failure). */
export class NextcloudRequestError extends Error {
  constructor(
    readonly kind: "timeout" | "network",
    readonly label: string
  ) {
    super(`Nextcloud ${kind === "timeout" ? "timed out" : "could not be reached"} for ${label}`);
    this.name = "NextcloudRequestError";
  }
}

export class NextcloudCircuitOpenError extends Error {
  constructor() {
    super("Nextcloud circuit breaker is open");
    this.name = "NextcloudCircuitOpenError";
  }
}

export interface NextcloudRequest {
  method: string;
  /** Path below the base URL, already percent-encoded (see encodePathSegments). */
  path: string;
  /** Fixed, PII-free name for this call, used in errors and logs. */
  label: string;
  body?: string;
  headers?: Record<string, string>;
  /** Non-2xx statuses that are an expected answer rather than an error (e.g. 405 for MKCOL). */
  okStatuses?: number[];
}

export interface NextcloudResponse {
  status: number;
  body: string;
  /** The ETag response header, when the server sent one. */
  etag: string | null;
}

// A 4xx other than 401 means Nextcloud answered and the request was the problem
// (item missing, not shared with the service account). That must not open the
// breaker for every other call. 401 means the app password is wrong or revoked,
// which affects every call, so it counts.
function isCallerError(error: unknown): boolean {
  return (
    error instanceof NextcloudHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 401
  );
}

async function send(
  config: NextcloudConfig,
  request: NextcloudRequest
): Promise<NextcloudResponse> {
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}${request.path}`, {
      method: request.method,
      headers: {
        authorization: `Basic ${Buffer.from(`${config.username}:${config.appPassword}`).toString("base64")}`,
        "OCS-APIRequest": "true",
        accept: "application/json",
        ...request.headers,
      },
      body: request.body,
      signal: AbortSignal.timeout(NEXTCLOUD_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // The original error is dropped on purpose: undici errors can include the URL.
    const name = (error as { name?: unknown } | null)?.name;
    throw new NextcloudRequestError(
      name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
      request.label
    );
  }
  const body = await res.text();
  if (!res.ok && !request.okStatuses?.includes(res.status)) {
    throw new NextcloudHttpError(res.status, request.label);
  }
  return { status: res.status, body, etag: res.headers.get("etag") };
}

const breakerOptions = {
  timeout: NEXTCLOUD_REQUEST_TIMEOUT_MS + 2_000,
  resetTimeout: 30_000,
  volumeThreshold: 5,
  errorThresholdPercentage: 50,
  errorFilter: isCallerError,
};

const breaker = new CircuitBreaker(send, { name: "nextcloud", ...breakerOptions });

// The portal mirror (lib/portal-mirror-sync.ts) has a breaker of its own: a Tables outage or a
// backfill that trips it never blocks the lead, onboarding or contact syncs.
const mirrorBreaker = new CircuitBreaker(send, {
  name: "nextcloud-portal-mirror",
  ...breakerOptions,
});

// The billing mirror (lib/billing-mirror-sync.ts) has its own as well, so an outage seen by one
// mirror does not pause the other.
const billingMirrorBreaker = new CircuitBreaker(send, {
  name: "nextcloud-billing-mirror",
  ...breakerOptions,
});

export function nextcloudRequest(
  config: NextcloudConfig,
  request: NextcloudRequest
): Promise<NextcloudResponse> {
  return fire(breaker, config, request);
}

/** Same as nextcloudRequest, through the portal mirror's own breaker. */
export function portalMirrorRequest(
  config: NextcloudConfig,
  request: NextcloudRequest
): Promise<NextcloudResponse> {
  return fire(mirrorBreaker, config, request);
}

/** Same as nextcloudRequest, through the billing mirror's own breaker. */
export function billingMirrorRequest(
  config: NextcloudConfig,
  request: NextcloudRequest
): Promise<NextcloudResponse> {
  return fire(billingMirrorBreaker, config, request);
}

async function fire(
  via: CircuitBreaker<[NextcloudConfig, NextcloudRequest], NextcloudResponse>,
  config: NextcloudConfig,
  request: NextcloudRequest
): Promise<NextcloudResponse> {
  try {
    return await via.fire(config, request);
  } catch (error) {
    if (CircuitBreaker.isOurError(error as Error)) {
      // opossum's own timeout is reported like a request timeout; an open breaker fails fast.
      if ((error as { code?: unknown }).code === "ETIMEDOUT") {
        throw new NextcloudRequestError("timeout", request.label);
      }
      throw new NextcloudCircuitOpenError();
    }
    throw error;
  }
}

/** Percent-encodes each segment; segments must not contain "/". */
export function encodePathSegments(segments: string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

export function getNextcloudBreakerState() {
  return {
    open: breaker.opened,
    halfOpen: breaker.halfOpen,
    failures: breaker.stats.failures,
    rejects: breaker.stats.rejects,
  };
}

export function resetNextcloudBreakerForTests() {
  breaker.close();
  mirrorBreaker.close();
  billingMirrorBreaker.close();
}

export function openPortalMirrorBreakerForTests() {
  mirrorBreaker.open();
}

export function openNextcloudBreakerForTests() {
  breaker.open();
}
