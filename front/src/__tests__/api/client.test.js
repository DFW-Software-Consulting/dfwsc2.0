import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "../../api/client";

describe("apiFetch", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it("rejects with a timed-out message when the request exceeds timeoutMs", async () => {
    global.fetch.mockImplementation(
      (_url, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => {
            reject(opts.signal.reason ?? new DOMException("aborted", "TimeoutError"));
          });
        })
    );

    await expect(apiFetch("/slow", { timeoutMs: 10 })).rejects.toThrow(
      "Request timed out. Please try again."
    );
  });

  it("still resolves normally when the request succeeds well within the timeout", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ hello: "world" }),
    });

    await expect(apiFetch("/ok", { timeoutMs: 10000 })).resolves.toEqual({ hello: "world" });
  });
});
