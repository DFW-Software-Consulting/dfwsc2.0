import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AdminSetup from "../components/admin/AdminSetup";
import { renderWithProviders } from "../test/renderWithProviders";

describe("AdminSetup", () => {
  it("renders env-bootstrap instructions and no password form when not bootstrap-pending", () => {
    renderWithProviders(<AdminSetup isBootstrapPending={false} />);

    expect(screen.getByText(/ADMIN_USERNAME/)).toBeInTheDocument();
    expect(screen.getByText(/ADMIN_PASSWORD/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Password$/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /create admin/i })).not.toBeInTheDocument();
  });

  it("renders the confirm form when bootstrap is pending", () => {
    renderWithProviders(<AdminSetup isBootstrapPending token="jwt" />);

    expect(screen.getByLabelText(/admin username/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirm admin account/i })).toBeInTheDocument();
  });
});
