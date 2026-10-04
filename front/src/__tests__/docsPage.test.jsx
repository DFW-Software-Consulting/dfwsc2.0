import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import Docs from "../pages/Docs";

describe("Docs page", () => {
  it("documents the confirmation step and the errors an integrator can hit", () => {
    const { container } = render(<Docs />, { wrapper: MemoryRouter });

    expect(screen.getByRole("heading", { name: /step 3/i })).toBeInTheDocument();
    expect(container.textContent).toContain("ACCOUNT_NOT_CONNECTED");
    expect(container.textContent).toContain("LEDGER_PERSISTENCE_FAILED");
  });

  it("lists the error codes /payments/create returns for caller errors and key conflicts", () => {
    const { container } = render(<Docs />, { wrapper: MemoryRouter });

    for (const code of [
      "INVALID_REQUEST",
      "CARD_DECLINED",
      "IDEMPOTENCY_KEY_REUSED",
      "IDEMPOTENCY_KEY_IN_USE",
      "RATE_LIMITED",
      "STRIPE_FAILED",
      "STRIPE_CIRCUIT_OPEN",
      "STRIPE_BUSY",
    ]) {
      expect(container.textContent).toContain(code);
    }
  });

  it("says an idempotency key covers one attempt for at most 24 hours", () => {
    const { container } = render(<Docs />, { wrapper: MemoryRouter });

    expect(container.textContent).toMatch(/one payment attempt, not one order/i);
    expect(container.textContent).toMatch(/never more than 24 hours/i);
    expect(container.textContent).toMatch(/218 characters/);
    expect(container.textContent).not.toMatch(/unique\s+Idempotency-Key/i);
  });

  it("tells integrators to keep and check every session of an order", () => {
    const { container } = render(<Docs />, { wrapper: MemoryRouter });
    const text = container.textContent;

    expect(text).toMatch(/does not cancel the earlier one: it stays payable until it expires/i);
    expect(text).toMatch(/keep the earlier ones; do not replace them/i);
    expect(text).toMatch(/check every session of an order, not just the newest/i);
    expect(text).toMatch(/earlier session comes back paid, the order is paid/i);
    expect(text).toMatch(/both come back paid, the customer paid twice/i);
    expect(text).toMatch(/no refund endpoint/i);
    expect(text).not.toMatch(/store the new sessionId against the order/i);
  });

  it("states the confirmation endpoint limits and a polling backoff", () => {
    const { container } = render(<Docs />, { wrapper: MemoryRouter });
    const text = container.textContent;

    expect(text).toMatch(/30 requests per minute for each calling IP address/i);
    expect(text).toMatch(/600 requests per minute for your account/i);
    expect(text).toMatch(/2, 5 and 10 seconds/);
    expect(text).toMatch(/one budget shared by all your pending orders/i);
    expect(text).toMatch(/every 15 minutes/i);
    expect(text).toMatch(/about 300 requests a minute across every order/i);
    expect(text).not.toMatch(/about 20 requests a minute/i);
    expect(text).not.toMatch(/No API key is needed/i);
    expect(text).not.toMatch(/couple of seconds/i);
  });

  it("explains sending the API key on the confirmation call", () => {
    const { container } = render(<Docs />, { wrapper: MemoryRouter });
    const text = container.textContent;

    expect(text).toMatch(/Send your X-Api-Key header with this call/i);
    expect(text).toMatch(/only see your own account.s sessions/i);
    expect(text).toMatch(/returns 404, the same as an unknown session/i);
    expect(text).toMatch(/wrong or deactivated key returns 401/i);
  });

  it("documents the checkout burst limit, Retry-After and automatic retries", () => {
    const { container } = render(<Docs />, { wrapper: MemoryRouter });
    const text = container.textContent;

    expect(text).toMatch(/200 checkouts at once/i);
    expect(text).toMatch(/refills at 120 per minute \(2 per second\)/i);
    expect(text).toMatch(/Every 429 from this API carries both/i);
    expect(text).toMatch(/Retry-After: 5/);
    expect(text).toMatch(/Retry automatically, with the same Idempotency-Key/i);
    expect(text).toMatch(/never have to click twice/i);
    expect(text).toMatch(/waiting screen/i);
  });

  it("does not describe request fields or notifications the API does not support", () => {
    const { container } = render(<Docs />, { wrapper: MemoryRouter });

    expect(container.textContent).not.toMatch(/price IDs/i);
    expect(container.textContent).not.toMatch(
      /(?:api|dfwsc|we)\s+(?:will\s+)?(?:sends?|posts?)\s+(?:a\s+|the\s+|your\s+)?webhooks?/i
    );
    expect(container.textContent).not.toMatch(/(?:get|receive) a webhook/i);
    expect(container.textContent).not.toMatch(/invoice or order ID/i);
  });

  it("takes the idempotency key as a parameter in every code sample", async () => {
    const user = userEvent.setup();
    const { container } = render(<Docs />, { wrapper: MemoryRouter });

    for (const tab of ["Node.js", "Python", "PHP"]) {
      await user.click(screen.getByRole("button", { name: tab }));
      expect(container.textContent).toMatch(/idempotency_?key/i);
      expect(container.textContent).not.toMatch(/randomUUID\(\),|uuid\.uuid4\(\)\),|random_bytes/);
    }
  });
});
