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

  it("states the confirmation endpoint limit and a polling backoff", () => {
    const { container } = render(<Docs />, { wrapper: MemoryRouter });

    expect(container.textContent).toMatch(/30 requests per minute for each calling IP address/i);
    expect(container.textContent).toMatch(/2, 5 and 10 seconds/);
    expect(container.textContent).toMatch(/one budget shared by all your pending orders/i);
    expect(container.textContent).toMatch(/every 15 minutes/i);
    expect(container.textContent).toMatch(/about 20 requests a minute across every order/i);
    expect(container.textContent).not.toMatch(/couple of seconds/i);
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
