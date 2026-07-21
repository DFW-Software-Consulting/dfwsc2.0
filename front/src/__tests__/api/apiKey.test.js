import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  apiFetch: vi.fn(),
}));

import { regenerateApiKey } from "../../api/apiKey";
import { apiFetch } from "../../api/client";

describe("regenerateApiKey", () => {
  it("POSTs the token in the request body, not the query string", async () => {
    apiFetch.mockResolvedValue({ apiKey: "new-secret-key" });

    await regenerateApiKey("one-time-token");

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith("/api-key/regenerate", {
      method: "POST",
      body: { token: "one-time-token" },
    });
  });

  it("returns the API key from the response", async () => {
    apiFetch.mockResolvedValue({ apiKey: "returned-key" });

    const result = await regenerateApiKey("token");

    expect(result.apiKey).toBe("returned-key");
  });
});
