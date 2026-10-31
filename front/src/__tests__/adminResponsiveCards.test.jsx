import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminTable from "../components/admin/shared/AdminTable";
import RowActions from "../components/admin/shared/RowActions";

function mockViewport(isDesktop) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: isDesktop,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

afterEach(() => {
  delete window.matchMedia;
});

const onEdit = vi.fn();
const onDelete = vi.fn();
const onResend = vi.fn();

const columns = [
  { header: "Name", key: "name" },
  { header: "Email", key: "email", cardClassName: "break-all" },
  { header: "Status", render: (r) => <span>{r.status}</span> },
  {
    header: "Actions",
    actions: () => [
      { key: "resend", label: "Resend Link", onClick: onResend },
      { key: "edit", label: "Edit", primary: true, onClick: onEdit },
      { key: "delete", label: "Delete", variant: "danger", onClick: onDelete },
    ],
  },
];
const rows = [
  { id: "1", name: "Acme Co", email: "very.long.address@example.com", status: "active" },
];

describe("AdminTable responsive rendering", () => {
  it("renders the table at md and up", () => {
    mockViewport(true);
    render(<AdminTable columns={columns} rows={rows} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-cards")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resend Link" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
  });

  it("renders stacked cards below md with a title, label/value pairs and an overflow menu", () => {
    mockViewport(false);
    render(<AdminTable columns={columns} rows={rows} />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const card = within(screen.getByTestId("admin-cards")).getAllByRole("listitem")[0];
    expect(within(card).getByRole("heading", { name: "Acme Co" })).toBeInTheDocument();
    expect(within(card).getByText("Email")).toBeInTheDocument();
    expect(within(card).getByText("very.long.address@example.com").className).toContain(
      "break-all"
    );
    expect(within(card).getByText("Status")).toBeInTheDocument();
    // primary action is a button, the rest live in the menu
    expect(within(card).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /More actions/ })).toHaveAttribute(
      "aria-haspopup",
      "menu"
    );
  });

  it("wraps two or fewer actions in a row instead of a menu", () => {
    mockViewport(false);
    render(
      <RowActions
        mode="card"
        actions={[
          { key: "a", label: "One" },
          { key: "b", label: "Two" },
        ]}
      />
    );
    expect(screen.getByRole("button", { name: "One" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Two" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /More actions/ })).not.toBeInTheDocument();
  });
});

describe("overflow menu", () => {
  function setup() {
    mockViewport(false);
    render(
      <>
        <button type="button">outside</button>
        <AdminTable columns={columns} rows={rows} />
      </>
    );
    return userEvent.setup();
  }

  it("opens, moves focus to the first item, and exposes aria-expanded", async () => {
    const user = setup();
    const trigger = screen.getByRole("button", { name: /More actions/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Resend Link" })).toHaveFocus();
  });

  it("supports arrow keys, Home and End with wrap-around", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: /More actions/ }));
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Resend Link" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("menuitem", { name: "Resend Link" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = setup();
    const trigger = screen.getByRole("button", { name: /More actions/ });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("closes on outside press without running an action", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: /More actions/ }));
    await user.click(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("runs the chosen action, closes the menu and refocuses the trigger", async () => {
    const user = setup();
    const trigger = screen.getByRole("button", { name: /More actions/ });
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe("row-specific menu names", () => {
  const twoRows = [
    ...rows,
    { id: "2", name: "Beta LLC", email: "ops@beta.example", status: "paused" },
  ];

  it("names each card's trigger and menu after its row", async () => {
    mockViewport(false);
    const user = userEvent.setup();
    render(<AdminTable columns={columns} rows={twoRows} />);
    const acmeTrigger = screen.getByRole("button", { name: "More actions for Acme Co" });
    const betaTrigger = screen.getByRole("button", { name: "More actions for Beta LLC" });
    expect(acmeTrigger).toHaveAttribute("aria-haspopup", "menu");
    expect(betaTrigger).toHaveAttribute("aria-haspopup", "menu");

    await user.click(acmeTrigger);
    expect(screen.getByRole("menu", { name: "More actions for Acme Co" })).toBeInTheDocument();
  });
});

describe("loading menu items", () => {
  beforeEach(() => {
    onDelete.mockClear();
  });

  const loadingColumns = [
    { header: "Name", key: "name" },
    {
      header: "Actions",
      actions: () => [
        { key: "edit", label: "Edit", primary: true, onClick: onEdit },
        { key: "resend", label: "Resend Link", onClick: onResend },
        {
          key: "delete",
          label: "Delete",
          variant: "danger",
          isLoading: true,
          onClick: onDelete,
        },
      ],
    },
  ];

  it("keeps the label, marks busy and disabled, stays in arrow-key order and ignores activation", async () => {
    mockViewport(false);
    const user = userEvent.setup();
    render(<AdminTable columns={loadingColumns} rows={rows} />);
    await user.click(screen.getByRole("button", { name: "More actions for Acme Co" }));

    const loading = screen.getByRole("menuitem", { name: "Delete" });
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(loading).toHaveAttribute("aria-disabled", "true");
    expect(loading).not.toBeDisabled();

    // Opening focuses Resend Link; the loading item is the next stop with ArrowDown.
    expect(screen.getByRole("menuitem", { name: "Resend Link" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(loading).toHaveFocus();

    await user.click(loading);
    await user.keyboard("{Enter}");
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: "More actions for Acme Co" })).toBeInTheDocument();
  });
});
