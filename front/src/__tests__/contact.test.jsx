import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Contact from "../components/Contact";
import { renderWithProviders } from "../test/renderWithProviders";

global.fetch = vi.fn();

const fillRequiredFields = ({
  company = "Acme",
  name = " Ada Lovelace ",
  email = " ada@example.com ",
  message = " Build a portal ",
} = {}) => {
  fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: name } });
  fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/company/i), { target: { value: company } });
  fireEvent.change(screen.getByLabelText(/^message$/i), { target: { value: message } });
};

describe("Contact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits trimmed form data and confirms a successful submission", async () => {
    const company = "A".repeat(100);
    global.fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ ok: true }),
    });

    renderWithProviders(<Contact />);
    fillRequiredFields({ company: ` ${company} ` });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/contact"),
        expect.objectContaining({ method: "POST" })
      );
    });

    const [, options] = global.fetch.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
      company,
      message: "Build a portal",
      _hp: "",
    });
    expect(await screen.findByText(/thanks — we'll be in touch/i)).toBeInTheDocument();
  });

  it("blocks a company name longer than 100 characters before sending", async () => {
    renderWithProviders(<Contact />);
    fillRequiredFields({ company: "a".repeat(101) });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(await screen.findByText(/company must not exceed 100 characters/i)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("shows the direct-email fallback when the submission fails", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: { get: () => "application/json" },
      json: async () => ({ error: "Service unavailable" }),
    });

    renderWithProviders(<Contact />);
    fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(
      await screen.findByText(/something went wrong sending your message/i)
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "mail@dfwsc.com" })).toHaveAttribute(
      "href",
      "mailto:mail@dfwsc.com"
    );
  });

  it("clears an earlier success when a later submission begins and fails", async () => {
    let rejectRetry;
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({ ok: true }),
      })
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectRetry = reject;
          })
      );

    renderWithProviders(<Contact />);
    fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));
    expect(await screen.findByText(/thanks — we'll be in touch/i)).toBeInTheDocument();

    fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(screen.queryByText(/thanks — we'll be in touch/i)).not.toBeInTheDocument();
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    rejectRetry(new Error("Service unavailable"));

    expect(
      await screen.findByText(/something went wrong sending your message/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/thanks — we'll be in touch/i)).not.toBeInTheDocument();
  });
});
