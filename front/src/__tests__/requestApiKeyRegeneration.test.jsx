import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RequestApiKeyRegeneration from "../pages/RequestApiKeyRegeneration";
import { renderWithProviders } from "../test/renderWithProviders";

// Mock the logger utility (matches coreFlows.test.jsx convention)
vi.mock("../utils/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

// Mock fetch API (matches coreFlows.test.jsx / addClientModal.test.jsx convention)
global.fetch = vi.fn();

describe("RequestApiKeyRegeneration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch.mockClear();
  });

  it("renders the email input and submit control", () => {
    renderWithProviders(<RequestApiKeyRegeneration />);

    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send regeneration link/i })).toBeInTheDocument();
  });

  it("shows an error when the email is empty", async () => {
    renderWithProviders(<RequestApiKeyRegeneration />, { token: null });

    fireEvent.click(screen.getByRole("button", { name: /send regeneration link/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/email is required/i);
    });
  });

  it("shows an error for an invalid email format instead of submitting", async () => {
    renderWithProviders(<RequestApiKeyRegeneration />, { token: null });

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "not-an-email" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send regeneration link/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/valid email address/i);
    });

    expect(screen.queryByText(/regeneration link has been sent/i)).not.toBeInTheDocument();
  });

  it("submits the email to the API and shows a confirmation message on success", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ message: "ok" }),
    });

    renderWithProviders(<RequestApiKeyRegeneration />);

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send regeneration link/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api-key/regenerate-request"),
        expect.objectContaining({ method: "POST" })
      );
    });

    const [, options] = global.fetch.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ email: "user@example.com" });

    await waitFor(() => {
      expect(screen.getByText(/if an account with that email exists/i)).toBeInTheDocument();
    });
  });

  // Reality check (see final report): RequestApiKeyRegeneration.jsx's onError handler sets
  // the exact same `submitted` state as onSuccess (with only a logger.error call added) —
  // this intentionally avoids leaking whether an email exists in the system. There is no
  // separate "error message" in the UI for this page, so this test asserts the true
  // behavior (same confirmation message) rather than a distinct error message.
  it("shows the same confirmation message when the API call fails, without leaking that it failed", async () => {
    global.fetch.mockRejectedValueOnce(new Error("Network error"));

    renderWithProviders(<RequestApiKeyRegeneration />);

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send regeneration link/i }));

    await waitFor(() => {
      expect(screen.getByText(/if an account with that email exists/i)).toBeInTheDocument();
    });
  });
});
