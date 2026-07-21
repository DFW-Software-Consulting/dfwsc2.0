import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RequestApiKeyRegeneration from "../pages/RequestApiKeyRegeneration";

const mockMutate = vi.fn();

vi.mock("../hooks/useApiKey", () => ({
  useRequestApiKeyRegeneration: () => ({
    mutate: (...args) => mockMutate(...args),
    isPending: false,
  }),
}));

describe("RequestApiKeyRegeneration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits the email and shows anti-enumeration success messaging", async () => {
    mockMutate.mockImplementation((email, callbacks) => callbacks.onSuccess());
    render(<RequestApiKeyRegeneration />);

    const emailInput = screen.getByLabelText(/email address/i);
    fireEvent.change(emailInput, { target: { value: "client@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /send regeneration link/i }));

    await waitFor(() => {
      expect(screen.getByText(/if an account with that email exists/i)).toBeInTheDocument();
    });

    expect(mockMutate).toHaveBeenCalledWith("client@example.com", expect.any(Object));
  });

  it("shows an error when the request fails instead of pretending success", async () => {
    mockMutate.mockImplementation((email, callbacks) =>
      callbacks.onError(new Error("Network error"))
    );
    render(<RequestApiKeyRegeneration />);

    const emailInput = screen.getByLabelText(/email address/i);
    fireEvent.change(emailInput, { target: { value: "client@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /send regeneration link/i }));

    await waitFor(() => {
      expect(screen.getByText(/unable to send the regeneration link/i)).toBeInTheDocument();
    });

    expect(screen.queryByText(/if an account with that email exists/i)).not.toBeInTheDocument();
  });

  it("shows a client-side validation error when email is empty", async () => {
    render(<RequestApiKeyRegeneration />);

    fireEvent.click(screen.getByRole("button", { name: /send regeneration link/i }));

    await waitFor(() => {
      expect(screen.getByText(/please enter your email address/i)).toBeInTheDocument();
    });

    expect(mockMutate).not.toHaveBeenCalled();
  });
});
