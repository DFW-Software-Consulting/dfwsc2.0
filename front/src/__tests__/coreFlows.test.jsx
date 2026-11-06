import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OnboardClient from "../pages/OnboardClient";
import { renderWithProviders } from "../test/renderWithProviders";

// Mock the hooks
vi.mock("../hooks/useGroups", () => ({
  useGroups: () => ({ data: [], isLoading: false, isError: false }),
}));

// Mock the logger utility
vi.mock("../utils/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

// Mock sessionStorage
const mockSessionStorage = (() => {
  let store = {};

  return {
    getItem: (key) => store[key] || null,
    setItem: (key, value) => {
      store[key] = value.toString();
    },
    removeItem: (key) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(window, "sessionStorage", {
  value: mockSessionStorage,
});

// Mock fetch API
global.fetch = vi.fn();

describe("OnboardClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch.mockClear();

    // Reset window.location
    delete window.location;
    window.location = {
      search: "",
      href: "http://localhost/",
      assign: vi.fn(),
    };
  });

  it("extracts token from URL hash and displays it in the input field", () => {
    Object.defineProperty(window, "location", {
      value: {
        search: "",
        href: "http://localhost/#token=test-token-123",
        assign: vi.fn(),
      },
      writable: true,
    });

    renderWithProviders(<OnboardClient />, {
      token: null,
      initialEntries: ["/#token=test-token-123"],
    });

    const tokenInput = screen.getByRole("textbox", { name: /onboarding token/i });
    expect(tokenInput).toBeInTheDocument();
    expect(tokenInput.value).toBe("test-token-123");
  });

  it("shows loading state when submitting token", async () => {
    global.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: true,
                headers: { get: () => "application/json" },
                json: async () => ({ url: "https://stripe.com/connect" }),
              }),
            100
          )
        )
    );

    renderWithProviders(<OnboardClient />, { token: null });

    const tokenInput = screen.getByRole("textbox", { name: /onboarding token/i });
    fireEvent.change(tokenInput, { target: { value: "test-token" } });

    const submitButton = screen.getByRole("button", { name: /continue to stripe setup/i });
    fireEvent.click(submitButton);

    expect(screen.getByText(/verifying token and redirecting\.\.\./i)).toBeInTheDocument();

    await waitFor(() => {
      expect(submitButton).toBeDisabled();
    });
  });

  it("shows error message when token is empty", async () => {
    renderWithProviders(<OnboardClient />, { token: null });

    const submitButton = screen.getByRole("button", { name: /continue to stripe setup/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/please enter your onboarding token/i)).toBeInTheDocument();
    });
  });

  it("rejects a non-https redirect URL and shows an error instead of navigating", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ url: "javascript:alert(1)" }),
    });

    renderWithProviders(<OnboardClient />, { token: null });

    const tokenInput = screen.getByRole("textbox", { name: /onboarding token/i });
    fireEvent.change(tokenInput, { target: { value: "test-token" } });

    const submitButton = screen.getByRole("button", { name: /continue to stripe setup/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/error: received an invalid redirect url/i)).toBeInTheDocument();
    });

    expect(window.location.href).toBe("http://localhost/");
  });

  it("rejects an http:// (non-https) redirect URL and shows an error instead of navigating", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ url: "http://example.com/onboard" }),
    });

    renderWithProviders(<OnboardClient />, { token: null });

    const tokenInput = screen.getByRole("textbox", { name: /onboarding token/i });
    fireEvent.change(tokenInput, { target: { value: "test-token" } });

    const submitButton = screen.getByRole("button", { name: /continue to stripe setup/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/error: received an invalid redirect url/i)).toBeInTheDocument();
    });

    expect(window.location.href).toBe("http://localhost/");
  });

  it("submits the token when the user presses Enter in the input", async () => {
    global.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: true,
                headers: { get: () => "application/json" },
                json: async () => ({ url: "https://stripe.com/connect" }),
              }),
            100
          )
        )
    );

    renderWithProviders(<OnboardClient />, { token: null });

    const tokenInput = screen.getByRole("textbox", { name: /onboarding token/i });
    await userEvent.type(tokenInput, "test-token{enter}");

    await waitFor(() => {
      expect(screen.getByText(/verifying token and redirecting/i)).toBeInTheDocument();
    });
  });
});
