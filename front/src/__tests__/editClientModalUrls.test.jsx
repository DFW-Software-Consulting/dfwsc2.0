import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EditClientModal from "../components/admin/EditClientModal";
import { renderWithProviders } from "../test/renderWithProviders";

const mutate = vi.fn();
let fullClientState;

vi.mock("../hooks/useGroups", () => ({
  useGroups: () => ({ data: [], isLoading: false, isError: false }),
}));

vi.mock("../hooks/useClients", () => ({
  useClient: () => fullClientState,
  usePatchClient: () => ({ mutate, isPending: false }),
}));

// The list row never carries the URL columns; only the full record does.
const listRow = {
  id: "client-1",
  name: "Acme",
  email: "billing@acme.com",
  groupId: null,
  processingFeePercent: null,
  processingFeeCents: null,
};

const fullClient = {
  ...listRow,
  paymentSuccessUrl: "https://acme.com/thanks",
  paymentCancelUrl: "https://acme.com/cancel",
};

function renderModal() {
  return renderWithProviders(
    <EditClientModal client={listRow} onClose={vi.fn()} showToast={vi.fn()} />
  );
}

describe("EditClientModal payment URLs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fullClientState = { data: fullClient, isLoading: false };
  });

  it("seeds the URL fields from the full client record", async () => {
    renderModal();

    await waitFor(() =>
      expect(screen.getByLabelText(/payment success url/i)).toHaveValue("https://acme.com/thanks")
    );
    expect(screen.getByLabelText(/payment cancel url/i)).toHaveValue("https://acme.com/cancel");
  });

  it("does not send URL keys when only the fee is edited", async () => {
    renderModal();
    await waitFor(() =>
      expect(screen.getByLabelText(/payment success url/i)).toHaveValue("https://acme.com/thanks")
    );

    fireEvent.click(screen.getByLabelText(/flat \(cents\)/i));
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. 50/), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(mutate).toHaveBeenCalledTimes(1);
    const { body } = mutate.mock.calls[0][0];
    expect(body.processingFeeCents).toBe(50);
    expect(body).not.toHaveProperty("paymentSuccessUrl");
    expect(body).not.toHaveProperty("paymentCancelUrl");
  });

  it("sends only the URL that was changed, and null when it is cleared", async () => {
    renderModal();
    await waitFor(() =>
      expect(screen.getByLabelText(/payment success url/i)).toHaveValue("https://acme.com/thanks")
    );

    fireEvent.change(screen.getByLabelText(/payment cancel url/i), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    const { body } = mutate.mock.calls[0][0];
    expect(body.paymentCancelUrl).toBeNull();
    expect(body).not.toHaveProperty("paymentSuccessUrl");
  });

  it("disables Save until the full client record has loaded", () => {
    fullClientState = { data: undefined, isLoading: true };
    renderModal();

    expect(screen.getByRole("button", { name: /save changes/i })).toBeDisabled();
  });
});
