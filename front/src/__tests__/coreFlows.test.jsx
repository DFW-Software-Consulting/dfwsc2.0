import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CreateClientForm from "../components/admin/CreateClientForm";
import OnboardClient from "../pages/OnboardClient";
import { renderWithProviders } from "../test/renderWithProviders";

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

  it("extracts token from URL parameters and displays it in the input field", () => {
    Object.defineProperty(window, "location", {
      value: {
        search: "?token=test-token-123",
        href: "http://localhost/?token=test-token-123",
        assign: vi.fn(),
      },
      writable: true,
    });

    renderWithProviders(<OnboardClient />, { token: null });

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
});

describe("CreateClientForm", () => {
  const mockShowToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockShowToast.mockClear();
    global.fetch.mockClear();
  });

  it("validates required fields and shows error messages", async () => {
    renderWithProviders(<CreateClientForm showToast={mockShowToast} />);

    const nameInput = screen.getByRole("textbox", { name: /client name/i });
    await userEvent.type(nameInput, "Test Client");

    const emailInput = screen.getByRole("textbox", { name: /client email/i });
    await userEvent.type(emailInput, "test@example.com");

    await waitFor(() => {
      const submitButton = screen.getByRole("button", { name: /create client/i });
      expect(submitButton).not.toBeDisabled();
    });

    await userEvent.clear(nameInput);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const form = document.querySelector("form");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText(/client name is required/i)).toBeInTheDocument();
    });
  });

  it("validates email format", async () => {
    renderWithProviders(<CreateClientForm showToast={mockShowToast} />);

    const nameInput = screen.getByRole("textbox", { name: /client name/i });
    await userEvent.type(nameInput, "Test Client");

    const emailInput = screen.getByRole("textbox", { name: /client email/i });
    await userEvent.type(emailInput, "valid@email.com");

    await waitFor(() => {
      const submitButton = screen.getByRole("button", { name: /create client/i });
      expect(submitButton).not.toBeDisabled();
    });

    await userEvent.clear(emailInput);
    await userEvent.type(emailInput, "invalid-email");

    await new Promise((resolve) => setTimeout(resolve, 10));

    const form = document.querySelector("form");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText(/please enter a valid email address/i)).toBeInTheDocument();
    });
  });

  it("successfully creates a client with valid inputs", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({
        id: "client-123",
        name: "Test Client",
        email: "test@example.com",
        onboardingToken: "token-abc-123",
        onboardingUrlHint: "https://example.com/onboard?token=token-abc-123",
      }),
    });

    renderWithProviders(<CreateClientForm showToast={mockShowToast} />, {
      token: "admin-token",
    });

    const nameInput = screen.getByRole("textbox", { name: /client name/i });
    fireEvent.change(nameInput, { target: { value: "Test Client" } });

    const emailInput = screen.getByRole("textbox", { name: /client email/i });
    fireEvent.change(emailInput, { target: { value: "test@example.com" } });

    const submitButton = screen.getByRole("button", { name: /create client/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/client created successfully!/i)).toBeInTheDocument();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/accounts"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer admin-token",
        }),
        body: JSON.stringify({
          name: "Test Client",
          email: "test@example.com",
        }),
      })
    );

    expect(mockShowToast).toHaveBeenCalledWith(
      "Client Test Client created successfully!",
      "success"
    );
  });
});
