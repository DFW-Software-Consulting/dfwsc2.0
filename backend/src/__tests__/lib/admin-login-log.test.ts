import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkAdminLogin } from "../../lib/admin-login";
import { resetNextcloudBreakerForTests } from "../../lib/nextcloud";
import { loginEnv } from "../helpers/fake-nextcloud-login";
import { dump, expectNoPlanted, PLANTED_EMAIL, PLANTED_URL } from "../helpers/log-capture";

describe("admin login: Nextcloud failure logging", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, loginEnv());
    resetNextcloudBreakerForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  it("logs the error name only, never the message with a URL or user", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new TypeError(`connect failed ${PLANTED_URL} ${PLANTED_EMAIL}`), {
          code: "ECONNREFUSED",
        });
      })
    );
    const logger = { warn: vi.fn() };

    await expect(checkAdminLogin("jane", "pw", logger)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = logger.warn.mock.calls[0];
    expect(msg).toBe("Admin login unavailable: Nextcloud request failed");
    expect(fields).toMatchObject({ errName: "NextcloudRequestError" });
    expectNoPlanted(dump(logger.warn.mock.calls));
  });
});
