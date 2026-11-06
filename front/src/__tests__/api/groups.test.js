import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "../../api/client";
import { getGroups } from "../../api/groups";

describe("getGroups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends only the workspace when no limit is given", () => {
    getGroups("tok", "client_portal");

    expect(apiFetch).toHaveBeenCalledWith("/groups?workspace=client_portal", { token: "tok" });
  });

  it("adds the limit query parameter", () => {
    getGroups("tok", "client_portal", 100);

    expect(apiFetch).toHaveBeenCalledWith("/groups?workspace=client_portal&limit=100", {
      token: "tok",
    });
  });
});
