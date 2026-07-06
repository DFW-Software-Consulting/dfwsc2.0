import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  apiFetch: vi.fn(),
}));

import { regenerateApiKey, requestApiKeyRegeneration } from "../../api/apiKey";
import { apiFetch } from "../../api/client";

describe("apiKey API module", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({});
  });

  describe("regenerateApiKey", () => {
    it("sends a POST with the regeneration token in the JSON body", async () => {
      await regenerateApiKey("token-abc-123");

      expect(apiFetch).toHaveBeenCalledWith("/api-key/regenerate", {
        method: "POST",
        body: { token: "token-abc-123" },
      });
    });

    it("propagates a rejection from apiFetch unchanged", async () => {
      const apiError = new Error("This regeneration link has expired.");
      apiFetch.mockRejectedValueOnce(apiError);

      await expect(regenerateApiKey("expired-token")).rejects.toBe(apiError);
    });
  });

  describe("requestApiKeyRegeneration", () => {
    it("sends a POST with the email in the JSON body to the regenerate-request endpoint", async () => {
      await requestApiKeyRegeneration("user@example.com");

      expect(apiFetch).toHaveBeenCalledWith("/api-key/regenerate-request", {
        method: "POST",
        body: { email: "user@example.com" },
      });
    });

    it("propagates a rejection from apiFetch unchanged", async () => {
      const apiError = new Error("Network error");
      apiFetch.mockRejectedValueOnce(apiError);

      await expect(requestApiKeyRegeneration("user@example.com")).rejects.toBe(apiError);
    });
  });
});
