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
  fireEvent.change(screen.getByLabelText(/^company or project$/i), { target: { value: company } });
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
    const confirmation = await screen.findByText(/thanks — we'll be in touch/i);
    expect(confirmation).toHaveAttribute("aria-live", "polite");
    expect(confirmation).toHaveFocus();
    expect(screen.queryByRole("button", { name: /send message/i })).not.toBeInTheDocument();
  });

  it("requires every visible field and ties errors to inputs", async () => {
    renderWithProviders(<Contact />);
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    for (const [label, msg] of [
      [/^name$/i, /name is required/i],
      [/^email$/i, /email is required/i],
      [/^company or project$/i, /company or project is required/i],
      [/^message$/i, /message is required/i],
    ]) {
      const input = screen.getByLabelText(label);
      expect(input).toHaveAttribute("aria-invalid", "true");
      const err = document.getElementById(input.getAttribute("aria-describedby"));
      expect(err).toHaveTextContent(msg);
    }
    expect(screen.getByLabelText(/^name$/i)).toHaveFocus();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("disables inputs and shows Sending... while pending", async () => {
    global.fetch.mockImplementationOnce(() => new Promise(() => {}));
    renderWithProviders(<Contact />);
    fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    const button = await screen.findByRole("button", { name: /sending\.\.\./i });
    expect(button).toBeDisabled();
    expect(screen.getByLabelText(/^name$/i)).toBeDisabled();
    expect(screen.getByLabelText(/^company or project$/i)).toBeDisabled();
    expect(screen.getByLabelText(/^message$/i)).toBeDisabled();
  });

  it("hides the honeypot from people and assistive tech", () => {
    renderWithProviders(<Contact />);
    const hp = document.querySelector('input[name="_hp"]');
    expect(hp).toHaveAttribute("tabindex", "-1");
    expect(hp).toHaveAttribute("autocomplete", "off");
    expect(hp.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it("blocks a company name longer than 100 characters before sending", async () => {
    renderWithProviders(<Contact />);
    fillRequiredFields({ company: "a".repeat(101) });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(
      await screen.findByText(/company or project must not exceed 100 characters/i)
    ).toBeInTheDocument();
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
});
