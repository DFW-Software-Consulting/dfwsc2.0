import { getNextcloudConfig, type NextcloudConfig, nextcloudRequest } from "./nextcloud";
import { transportErrorFields } from "./safe-error-log";

// Admin panel login is checked against Nextcloud:
//   1. the user's own credentials (HTTP Basic) against GET /ocs/v2.php/cloud/user, which also
//      returns the canonical user id;
//   2. that id's groups, read as the Nextcloud service account (NEXTCLOUD_USERNAME), which is a
//      Nextcloud admin and so may list any user's groups.
// The user's password is sent only to NEXTCLOUD_BASE_URL, in the Basic header of step 1. It is
// never logged or stored, and nothing in this module puts it in an error.

const DEFAULT_ADMIN_NEXTCLOUD_GROUPS = ["dfwsc-admins", "managers"];

export type AdminLoginResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid_credentials" | "not_authorized" | "unavailable" };

/** ADMIN_NEXTCLOUD_GROUPS: comma-separated Nextcloud group ids; blank or unset means the default. */
export function parseAdminGroups(value: string | undefined): string[] {
  const groups = (value ?? "")
    .split(",")
    .map((group) => group.trim())
    .filter(Boolean);
  return groups.length > 0 ? groups : DEFAULT_ADMIN_NEXTCLOUD_GROUPS;
}

// Control characters cannot appear in a Nextcloud user id, and ":" would shift the split between
// user and password in the Basic header (Nextcloud would read a different user name).
function isPlausibleUsername(username: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  return username.length > 0 && !/[:\u0000-\u001f\u007f]/.test(username);
}

function readUserId(body: string): string | null {
  try {
    const id = (JSON.parse(body) as { ocs?: { data?: { id?: unknown } } }).ocs?.data?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function readGroups(body: string): string[] | null {
  try {
    const groups = (JSON.parse(body) as { ocs?: { data?: { groups?: unknown } } }).ocs?.data
      ?.groups;
    return Array.isArray(groups) ? groups.filter((g): g is string => typeof g === "string") : null;
  } catch {
    return null;
  }
}

/** Never throws: any Nextcloud trouble is `unavailable`. */
export async function checkAdminLogin(
  username: string,
  password: string,
  logger: { warn: (obj: object, msg: string) => void }
): Promise<AdminLoginResult> {
  const configured = getNextcloudConfig();
  if (!configured.ok) {
    logger.warn({ reason: configured.reason }, "Admin login unavailable: Nextcloud not configured");
    return { ok: false, reason: "unavailable" };
  }
  const service = configured.config;
  if (!isPlausibleUsername(username)) return { ok: false, reason: "invalid_credentials" };

  try {
    // 401/403 here are the user's answer, not a Nextcloud fault: okStatuses keeps them from
    // being thrown, so they never count against the shared circuit breaker.
    const asUser: NextcloudConfig = { ...service, username, appPassword: password };
    const me = await nextcloudRequest(asUser, {
      method: "GET",
      path: "/ocs/v2.php/cloud/user?format=json",
      label: "login.user",
      okStatuses: [401, 403],
    });
    if (me.status === 401 || me.status === 403) return { ok: false, reason: "invalid_credentials" };
    const userId = readUserId(me.body);
    if (!userId) {
      logger.warn({}, "Admin login unavailable: unexpected Nextcloud user response");
      return { ok: false, reason: "unavailable" };
    }

    const groupsResponse = await nextcloudRequest(service, {
      method: "GET",
      path: `/ocs/v2.php/cloud/users/${encodeURIComponent(userId)}/groups?format=json`,
      label: "login.groups",
    });
    const groups = readGroups(groupsResponse.body);
    if (!groups) {
      logger.warn({}, "Admin login unavailable: unexpected Nextcloud groups response");
      return { ok: false, reason: "unavailable" };
    }

    const allowed = parseAdminGroups(process.env.ADMIN_NEXTCLOUD_GROUPS);
    return groups.some((group) => allowed.includes(group))
      ? { ok: true, userId }
      : { ok: false, reason: "not_authorized" };
  } catch (error) {
    // Only identifiers are logged: the message can carry a URL, user or response body.
    logger.warn(transportErrorFields(error), "Admin login unavailable: Nextcloud request failed");
    return { ok: false, reason: "unavailable" };
  }
}
