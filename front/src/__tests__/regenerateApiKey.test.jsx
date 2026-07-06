import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RegenerateApiKey from "../pages/RegenerateApiKey";
import { renderWithProviders } from "../test/renderWithProviders";

// Mock the logger utility (matches coreFlows.test.jsx convention for OnboardClient)
vi.mock("../utils/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

// Spy on react-router-dom's useNavigate while keeping everything else (MemoryRouter,
// useLocation, ...) real. This gives us a direct assertion on the real hash-scrub seam:
// the `navigate(location.pathname, { replace: true })` call in RegenerateApiKey's effect.
const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Mock fetch API (matches coreFlows.test.jsx / addClientModal.test.jsx convention)
global.fetch = vi.fn();

describe("RegenerateApiKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch.mockClear();
  });

  it("extracts the token from the URL hash and enables the regenerate action", () => {
    renderWithProviders(<RegenerateApiKey />, {
      initialEntries: ["/regenerate-key#token=abc123"],
    });

    expect(screen.getByRole("button", { name: /regenerate api key/i })).toBeEnabled();
    expect(screen.queryByText(/no regeneration token found/i)).not.toBeInTheDocument();
  });

  it("scrubs the token from the URL hash after reading it", () => {
    renderWithProviders(<RegenerateApiKey />, {
      initialEntries: ["/regenerate-key#token=abc123"],
    });

    expect(mockNavigate).toHaveBeenCalledWith("/regenerate-key", { replace: true });
  });

  it("shows the returned API key and a copy-to-clipboard control on success", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ apiKey: "sk_live_new_key_123" }),
    });

    renderWithProviders(<RegenerateApiKey />, {
      initialEntries: ["/regenerate-key#token=abc123"],
    });

    fireEvent.click(screen.getByRole("button", { name: /regenerate api key/i }));

    await waitFor(() => {
      expect(screen.getByText("sk_live_new_key_123")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /copy to clipboard/i })).toBeInTheDocument();
  });

  it("removes the regenerate action from the DOM after a successful regeneration", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ apiKey: "sk_live_new_key_123" }),
    });

    renderWithProviders(<RegenerateApiKey />, {
      initialEntries: ["/regenerate-key#token=abc123"],
    });

    fireEvent.click(screen.getByRole("button", { name: /regenerate api key/i }));

    await waitFor(() => {
      expect(screen.getByText("sk_live_new_key_123")).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: /^regenerate api key$/i })).not.toBeInTheDocument();
  });

  it("shows the backend error message when the regeneration link is expired or invalid", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      headers: { get: () => "application/json" },
      json: async () => ({ error: "This regeneration link has expired." }),
    });

    renderWithProviders(<RegenerateApiKey />, {
      initialEntries: ["/regenerate-key#token=abc123"],
    });

    fireEvent.click(screen.getByRole("button", { name: /regenerate api key/i }));

    await waitFor(() => {
      expect(screen.getByText("This regeneration link has expired.")).toBeInTheDocument();
    });
  });

  it("shows a generic error message on an unexpected API/network failure", async () => {
    global.fetch.mockRejectedValueOnce(new Error("Failed to fetch"));

    renderWithProviders(<RegenerateApiKey />, {
      initialEntries: ["/regenerate-key#token=abc123"],
    });

    fireEvent.click(screen.getByRole("button", { name: /regenerate api key/i }));

    await waitFor(() => {
      expect(screen.getByText("Failed to fetch")).toBeInTheDocument();
    });
  });
});
