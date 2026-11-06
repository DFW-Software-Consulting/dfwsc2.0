import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodePathSegments,
  getNextcloudBreakerState,
  getNextcloudConfig,
  NextcloudCircuitOpenError,
  NextcloudHttpError,
  NextcloudRequestError,
  nextcloudRequest,
  resetNextcloudBreakerForTests,
} from "../../lib/nextcloud";

const config = {
  baseUrl: "https://cloud.test",
  username: "svc",
  appPassword: "secret-app-password",
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  resetNextcloudBreakerForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetNextcloudBreakerForTests();
});

describe("getNextcloudConfig", () => {
  it("is not configured without all three variables", () => {
    expect(getNextcloudConfig({})).toEqual({ ok: false, reason: "not_configured" });
    expect(
      getNextcloudConfig({ NEXTCLOUD_BASE_URL: "https://c.test", NEXTCLOUD_USERNAME: "u" })
    ).toEqual({ ok: false, reason: "not_configured" });
  });

  it("requires a valid https URL", () => {
    const creds = { NEXTCLOUD_USERNAME: "u", NEXTCLOUD_APP_PASSWORD: "p" };
    expect(getNextcloudConfig({ ...creds, NEXTCLOUD_BASE_URL: "http://c.test" })).toEqual({
      ok: false,
      reason: "invalid_base_url",
    });
    expect(getNextcloudConfig({ ...creds, NEXTCLOUD_BASE_URL: "not a url" })).toEqual({
      ok: false,
      reason: "invalid_base_url",
    });
  });

  it("trims the base URL and username", () => {
    expect(
      getNextcloudConfig({
        NEXTCLOUD_BASE_URL: " https://c.test/// ",
        NEXTCLOUD_USERNAME: " svc ",
        NEXTCLOUD_APP_PASSWORD: "p",
      })
    ).toEqual({
      ok: true,
      config: { baseUrl: "https://c.test", username: "svc", appPassword: "p" },
    });
  });
});

describe("nextcloudRequest", () => {
  it("sends basic auth and the OCS header, and returns status and body", async () => {
    fetchMock.mockResolvedValue(new Response("hello", { status: 201 }));
    const res = await nextcloudRequest(config, {
      method: "MKCOL",
      path: "/remote.php/dav/files/svc/x",
      label: "webdav.mkcol",
      headers: { depth: "0" },
    });
    expect(res).toEqual({ status: 201, body: "hello", etag: null });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://cloud.test/remote.php/dav/files/svc/x");
    expect(init.method).toBe("MKCOL");
    expect(init.headers.authorization).toBe(
      `Basic ${Buffer.from("svc:secret-app-password").toString("base64")}`
    );
    expect(init.headers["OCS-APIRequest"]).toBe("true");
    expect(init.headers.depth).toBe("0");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns statuses listed as ok instead of throwing", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 405 }));
    const res = await nextcloudRequest(config, {
      method: "MKCOL",
      path: "/x",
      label: "webdav.mkcol",
      okStatuses: [405],
    });
    expect(res.status).toBe(405);
  });

  it("names the label, never the path, in an HTTP error", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 403 }));
    const error = await nextcloudRequest(config, {
      method: "MKCOL",
      path: "/remote.php/dav/files/svc/Secret%20Company",
      label: "webdav.mkcol",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NextcloudHttpError);
    expect(error).toMatchObject({ status: 403, label: "webdav.mkcol" });
    expect((error as Error).message).toBe("Nextcloud answered 403 for webdav.mkcol");
  });

  it("drops the underlying error, which can contain the URL, on a network failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed: https://cloud.test/Secret Company"));
    const error = await nextcloudRequest(config, {
      method: "GET",
      path: "/Secret%20Company",
      label: "webdav.exists",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NextcloudRequestError);
    expect(error).toMatchObject({ kind: "network", label: "webdav.exists" });
    expect((error as Error).message).not.toContain("Secret");
    expect((error as Error).cause).toBeUndefined();
  });

  it("reports a timeout", async () => {
    fetchMock.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await expect(
      nextcloudRequest(config, { method: "GET", path: "/x", label: "forms.get_form" })
    ).rejects.toMatchObject({ kind: "timeout", label: "forms.get_form" });
  });

  it("does not open the breaker for caller errors such as 404", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 404 }));
    for (let i = 0; i < 20; i++) {
      await nextcloudRequest(config, { method: "GET", path: "/x", label: "t" }).catch(() => {});
    }
    expect(getNextcloudBreakerState().open).toBe(false);
  });

  it("opens the breaker on repeated 401s and then fails fast", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 401 }));
    for (let i = 0; i < 50 && !getNextcloudBreakerState().open; i++) {
      await nextcloudRequest(config, { method: "GET", path: "/x", label: "t" }).catch(() => {});
    }
    expect(getNextcloudBreakerState().open).toBe(true);
    fetchMock.mockClear();
    await expect(
      nextcloudRequest(config, { method: "GET", path: "/x", label: "t" })
    ).rejects.toBeInstanceOf(NextcloudCircuitOpenError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("encodePathSegments", () => {
  it("encodes each segment and joins them with /", () => {
    expect(encodePathSegments(["DFWSC Sales", "Leads", "A&B (2)", "50%"])).toBe(
      "DFWSC%20Sales/Leads/A%26B%20(2)/50%25"
    );
  });
});
