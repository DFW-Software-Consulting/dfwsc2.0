// In-memory stand-in for the two Nextcloud OCS provisioning calls the admin login makes:
//   GET /ocs/v2.php/cloud/user                  as the user (Basic auth with their credentials)
//   GET /ocs/v2.php/cloud/users/{id}/groups     as the service account
// Install it with vi.stubGlobal("fetch", vi.fn(fake.fetch)).

export const LOGIN_NC_BASE = "https://cloud.test";
export const LOGIN_NC_SERVICE_USER = "dfwsc-admin";
export const LOGIN_NC_SERVICE_PASSWORD = "service-app-password-for-tests";

export const loginEnv = (overrides: Record<string, string | undefined> = {}) => ({
  NEXTCLOUD_BASE_URL: LOGIN_NC_BASE,
  NEXTCLOUD_USERNAME: LOGIN_NC_SERVICE_USER,
  NEXTCLOUD_APP_PASSWORD: LOGIN_NC_SERVICE_PASSWORD,
  ...overrides,
});

export type RecordedLoginRequest = {
  method: string;
  host: string;
  /** Decoded path, query string included. */
  path: string;
  rawPath: string;
  user: string | null;
  password: string | null;
  ocsHeader: string | null;
};

type Fault = { match: (req: RecordedLoginRequest) => boolean; status?: number; timeout?: boolean };

export class FakeLoginNextcloud {
  readonly requests: RecordedLoginRequest[] = [];
  private users = new Map<string, { password: string; groups: string[]; loginNames: string[] }>();
  private faults: Fault[] = [];
  /** Body of the user answer, to simulate an unexpected response. */
  userBodyOverride: string | null = null;

  /** `loginNames` are extra names (e.g. an email address) Nextcloud accepts for this user. */
  addUser(id: string, password: string, groups: string[], loginNames: string[] = []) {
    this.users.set(id, { password, groups, loginNames });
  }

  fail(fault: Fault) {
    this.faults.push(fault);
  }

  get userChecks() {
    return this.requests.filter((r) => r.path.startsWith("/ocs/v2.php/cloud/user?"));
  }

  get groupChecks() {
    return this.requests.filter((r) => r.path.includes("/groups"));
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ])
    );
    const basic = /^Basic (.+)$/.exec(headers.authorization ?? "");
    const decoded = basic ? Buffer.from(basic[1], "base64").toString("utf8") : null;
    const split = decoded === null ? -1 : decoded.indexOf(":");
    const req: RecordedLoginRequest = {
      method: init.method ?? "GET",
      host: url.host,
      path: decodeURIComponent(url.pathname) + url.search,
      rawPath: url.pathname + url.search,
      user: decoded === null ? null : decoded.slice(0, split),
      password: decoded === null ? null : decoded.slice(split + 1),
      ocsHeader: headers["ocs-apirequest"] ?? null,
    };
    this.requests.push(req);

    const fault = this.faults.find((f) => f.match(req));
    if (fault) {
      if (fault.timeout) {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return new Response("", { status: fault.status ?? 500 });
    }

    const ocs = (data: unknown) =>
      new Response(JSON.stringify({ ocs: { meta: { status: "ok", statuscode: 200 }, data } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (url.pathname === "/ocs/v2.php/cloud/user") {
      const found = [...this.users.entries()].find(
        ([id, u]) => id === req.user || u.loginNames.includes(req.user ?? "")
      );
      if (!found || found[1].password !== req.password) return new Response("", { status: 401 });
      if (this.userBodyOverride !== null) return new Response(this.userBodyOverride);
      return ocs({ id: found[0], enabled: true });
    }

    const groups = /^\/ocs\/v2\.php\/cloud\/users\/([^/]+)\/groups$/.exec(url.pathname);
    if (groups) {
      if (req.user !== LOGIN_NC_SERVICE_USER || req.password !== LOGIN_NC_SERVICE_PASSWORD) {
        return new Response("", { status: 401 });
      }
      const user = this.users.get(decodeURIComponent(groups[1]));
      if (!user) return new Response("", { status: 404 });
      return ocs({ groups: user.groups });
    }
    return new Response("", { status: 404 });
  };
}
