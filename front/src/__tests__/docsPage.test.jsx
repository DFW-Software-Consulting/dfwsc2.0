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

  it("does not describe request fields or notifications the API does not support", () => {
    const { container } = render(<Docs />, { wrapper: MemoryRouter });

    expect(container.textContent).not.toMatch(/price IDs/i);
    expect(container.textContent).not.toMatch(/webhook/i);
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
