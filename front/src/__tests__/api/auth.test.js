import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  apiFetch: vi.fn(() => Promise.resolve({})),
}));

import { confirmBootstrap } from "../../api/auth";
import { apiFetch } from "../../api/client";

describe("confirmBootstrap", () => {
  it("sends the JWT as a Bearer token, not an X-Setup-Token header", async () => {
    const body = { username: "admin", password: "supersecretpassword" };

    await confirmBootstrap(body, "jwt");

    expect(apiFetch).toHaveBeenCalledWith("/auth/confirm-bootstrap", {
      token: "jwt",
      method: "POST",
      body,
    });

    const [, options] = apiFetch.mock.calls[0];
    expect(options.headers).toBeUndefined();
  });
});
