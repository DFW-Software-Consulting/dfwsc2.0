import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AddClientModal from "../components/admin/AddClientModal";
import { renderWithProviders } from "../test/renderWithProviders";

vi.mock("../hooks/useGroups", () => ({
  useGroups: () => ({
    data: [{ id: "group-1", name: "Acme Co" }],
    isLoading: false,
    isError: false,
  }),
}));

global.fetch = vi.fn();

describe("AddClientModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch.mockClear();
  });

  it("renders the form fields", () => {
    renderWithProviders(<AddClientModal onClose={vi.fn()} showToast={vi.fn()} />);

    expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/company \(optional\)/i)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Acme Co" })).toBeInTheDocument();
  });

  it("shows a validation error when submitting without a name or email", async () => {
    renderWithProviders(<AddClientModal onClose={vi.fn()} showToast={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /create client/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/name is required/i);
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("shows a validation error for an invalid email", async () => {
    renderWithProviders(<AddClientModal onClose={vi.fn()} showToast={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Jane Doe" } });
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: /create client/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/valid email/i);
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("submits to /onboard-client/initiate with the right body and shows a success toast", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ message: "Onboarding email sent successfully.", clientId: "client-1" }),
    });

    const onClose = vi.fn();
    const showToast = vi.fn();

    renderWithProviders(<AddClientModal onClose={onClose} showToast={showToast} />);

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Jane Doe" } });
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: "jane@example.com" } });
    fireEvent.change(screen.getByLabelText(/company \(optional\)/i), {
      target: { value: "group-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create client/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/onboard-client/initiate"),
        expect.objectContaining({ method: "POST" })
      );
    });

    const [, options] = global.fetch.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      name: "Jane Doe",
      email: "jane@example.com",
      workspace: "client_portal",
      groupId: "group-1",
    });

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith("Client created — onboarding email sent", "success");
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("surfaces a duplicate-email error from the API", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      headers: { get: () => "application/json" },
      json: async () => ({ error: "A client with this email already exists." }),
    });

    renderWithProviders(<AddClientModal onClose={vi.fn()} showToast={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Jane Doe" } });
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: "jane@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /create client/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/already exists/i);
    });
  });
});
