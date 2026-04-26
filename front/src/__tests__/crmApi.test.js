import { beforeEach, describe, expect, it, vi } from "vitest";
import { convertToClient, createLead } from "../api/crm";
import { apiFetch } from "../api/client";

vi.mock("../api/client", () => ({
  apiFetch: vi.fn(),
}));

describe("crm api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts workspace-scoped create lead requests", async () => {
    apiFetch.mockResolvedValueOnce({ id: "lead_1" });

    await createLead("token_1", "dfwsc_services", {
      name: "DFWSC Lead",
      email: "lead@example.com",
      nextAction: "Follow up",
    });

    expect(apiFetch).toHaveBeenCalledWith("/crm/leads", {
      token: "token_1",
      method: "POST",
      body: {
        workspace: "dfwsc_services",
        name: "DFWSC Lead",
        email: "lead@example.com",
        nextAction: "Follow up",
      },
    });
  });

  it("posts workspace-scoped convert requests", async () => {
    apiFetch.mockResolvedValueOnce({ id: "client_1", status: "active" });

    await convertToClient("token_2", "dfwsc_services", "lead_42");

    expect(apiFetch).toHaveBeenCalledWith("/crm/leads/lead_42/convert", {
      token: "token_2",
      method: "POST",
      body: { workspace: "dfwsc_services" },
    });
  });
});
