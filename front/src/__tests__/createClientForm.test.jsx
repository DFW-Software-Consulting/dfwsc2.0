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
  it("submits client portal account creation through shared mutation", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateClientForm workspace="client_portal" />);

    await user.type(screen.getByLabelText("Account Name"), "Portal Co");
    await user.type(screen.getByLabelText("Account Email"), "portal@example.com");
    await user.click(screen.getByRole("button", { name: "Create Client" }));

    expect(createClientMutate).toHaveBeenCalledTimes(1);
    expect(createClientMutate).toHaveBeenCalledWith(
      {
        name: "Portal Co",
        email: "portal@example.com",
        workspace: "client_portal",
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      })
    );
    expect(dfwscClientMutate).not.toHaveBeenCalled();
  });
});
