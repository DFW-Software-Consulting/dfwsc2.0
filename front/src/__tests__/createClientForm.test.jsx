import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import CreateClientForm from "../components/admin/CreateClientForm";
import { renderWithProviders } from "../test/renderWithProviders";

const createClientMutate = vi.fn();
const dfwscClientMutate = vi.fn();

vi.mock("../hooks/useClients", () => ({
  useCreateClient: () => ({ mutate: createClientMutate, isPending: false }),
  useDfwscClient: () => ({ mutate: dfwscClientMutate, isPending: false }),
}));

vi.mock("../hooks/useGroups", () => ({
  useGroups: () => ({ data: [] }),
}));

describe("CreateClientForm", () => {
  it("submits ledger CRM account creation through direct client mutation", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateClientForm workspace="ledger_crm" />);

    await user.type(screen.getByLabelText("Account Name"), "Ledger Co");
    await user.type(screen.getByLabelText("Account Email"), "ledger@example.com");
    await user.click(screen.getByRole("button", { name: "Create Client" }));

    expect(createClientMutate).toHaveBeenCalledTimes(1);
    expect(createClientMutate).toHaveBeenCalledWith(
      {
        name: "Ledger Co",
        email: "ledger@example.com",
        workspace: "ledger_crm",
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      })
    );
    expect(dfwscClientMutate).not.toHaveBeenCalled();
  });
});
