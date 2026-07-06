import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import RequestApiKeyRegeneration from "../pages/RequestApiKeyRegeneration";
import { renderWithProviders } from "../test/renderWithProviders";

describe("RequestApiKeyRegeneration", () => {
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
});
