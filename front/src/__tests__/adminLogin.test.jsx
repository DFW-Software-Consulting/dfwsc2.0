import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { login } from "../api/auth";
import AdminLogin from "../components/admin/AdminLogin";
import { renderWithProviders } from "../test/renderWithProviders";

vi.mock("../api/auth", () => ({ login: vi.fn() }));

function apiError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function submit(username = "jc", password = "pw") {
  await userEvent.type(screen.getByLabelText("Username"), username);
  await userEvent.type(screen.getByLabelText("Password"), password);
  await userEvent.click(screen.getByRole("button", { name: "Log In" }));
}

describe("AdminLogin", () => {
  beforeEach(() => {
    vi.mocked(login).mockReset();
  });

  it("explains that the sign-in is a Nextcloud one, and the two-factor caveat", () => {
    renderWithProviders(<AdminLogin />, { token: null });

    expect(screen.getByText("Sign in with your Nextcloud account")).toBeInTheDocument();
    expect(
      screen.getByText("Accounts with two-factor login need a Nextcloud app password")
    ).toBeInTheDocument();
  });

  it("sends the trimmed username and the password as typed", async () => {
    vi.mocked(login).mockResolvedValue({ token: "t", expiresIn: "1h" });
    renderWithProviders(<AdminLogin />, { token: null });

    await submit("  jc  ", "pw");

    await waitFor(() => expect(login).toHaveBeenCalledWith({ username: "jc", password: "pw" }));
  });

  it("does not call the API without a password", async () => {
    renderWithProviders(<AdminLogin />, { token: null });

    await userEvent.type(screen.getByLabelText("Username"), "jc");
    await userEvent.click(screen.getByRole("button", { name: "Log In" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Password is required");
    expect(login).not.toHaveBeenCalled();
  });

  it("shows the generic message for a wrong password (401)", async () => {
    vi.mocked(login).mockRejectedValue(apiError(401, "Invalid credentials"));
    renderWithProviders(<AdminLogin />, { token: null });

    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid credentials");
  });

  it("shows the not-authorized message for a valid account outside the groups (403)", async () => {
    vi.mocked(login).mockRejectedValue(
      apiError(403, "This Nextcloud account isn't authorized for the admin panel")
    );
    renderWithProviders(<AdminLogin />, { token: null });

    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This Nextcloud account isn't authorized for the admin panel"
    );
  });

  it("falls back to the 403 wording when the API sends no message", async () => {
    vi.mocked(login).mockRejectedValue(apiError(403, ""));
    renderWithProviders(<AdminLogin />, { token: null });

    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This Nextcloud account isn't authorized for the admin panel"
    );
  });

  it("shows the unavailable message when Nextcloud cannot be reached (503)", async () => {
    vi.mocked(login).mockRejectedValue(apiError(503, "Admin login is unavailable"));
    renderWithProviders(<AdminLogin />, { token: null });

    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent("Admin login is unavailable");
  });

  it("falls back to the 503 wording when the API sends no message", async () => {
    vi.mocked(login).mockRejectedValue(apiError(503, ""));
    renderWithProviders(<AdminLogin />, { token: null });

    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent("Admin login is unavailable");
  });

  it("keeps the token in memory only", async () => {
    vi.mocked(login).mockResolvedValue({ token: "secret-jwt", expiresIn: "1h" });
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    renderWithProviders(<AdminLogin />, { token: null });

    await submit();

    await waitFor(() => expect(login).toHaveBeenCalled());
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
});
