import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConfirmModal from "../components/admin/ConfirmModal";
import BaseModal from "../components/admin/shared/BaseModal";
import ErrorMessage from "../components/admin/shared/ErrorMessage";
import FormInput from "../components/admin/shared/FormInput";
import TruncationNotice from "../components/admin/shared/TruncationNotice";
import Toast from "../components/admin/Toast";
import Docs from "../pages/Docs.jsx";

// <main> is its own stacking context below the sticky header, so overlays must render
// outside it (portaled to <body>) to layer above the header.
function renderInsideMain(ui) {
  return render(<main className="relative z-10">{ui}</main>);
}

describe("overlay layering", () => {
  it("portals BaseModal to <body>, above the header layer", () => {
    const { container } = renderInsideMain(
      <BaseModal isOpen onClose={() => {}} title="Profile" titleId="t">
        body
      </BaseModal>
    );
    const dialog = screen.getByRole("dialog", { name: "Profile" });
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.className).toContain("z-[60]");
    expect(screen.getByRole("heading", { name: "Profile" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("portals ConfirmModal and Toast to <body>, stacked above dialogs", () => {
    const { container } = renderInsideMain(
      <>
        <ConfirmModal isOpen title="Sure?" message="m" onConfirm={() => {}} onCancel={() => {}} />
        <Toast show message="Saved" type="success" onClose={() => {}} />
      </>
    );
    const confirm = screen.getByRole("dialog");
    const toast = screen.getByRole("alert");
    expect(container.contains(confirm)).toBe(false);
    expect(container.contains(toast)).toBe(false);
    expect(confirm.className).toContain("z-[70]");
    expect(toast.className).toContain("z-[80]");
  });

  it("closes BaseModal on Escape and restores focus to the opener", () => {
    const onClose = vi.fn();
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { rerender } = render(
      <BaseModal isOpen onClose={onClose} title="Profile">
        body
      </BaseModal>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <BaseModal isOpen={false} onClose={onClose} title="Profile">
        body
      </BaseModal>
    );
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("restores focus to the opener when an always-open modal unmounts", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(
      <BaseModal isOpen onClose={() => {}} title="Profile">
        body
      </BaseModal>
    );
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe("BaseModal sizes", () => {
  it.each([
    ["sm", "max-w-sm"],
    ["md", "max-w-lg"],
    ["lg", "max-w-2xl"],
    ["xl", "max-w-5xl"],
  ])("applies the %s width", (size, cls) => {
    render(
      <BaseModal isOpen onClose={() => {}} title="Sized" size={size}>
        body
      </BaseModal>
    );
    const panel = screen.getByRole("dialog").querySelector("[data-size]");
    expect(panel.dataset.size).toBe(size);
    expect(panel.className).toContain(cls);
  });

  it("falls back to md for an unknown size", () => {
    render(
      <BaseModal isOpen onClose={() => {}} title="Sized" size="huge">
        body
      </BaseModal>
    );
    const panel = screen.getByRole("dialog").querySelector("[data-size]");
    expect(panel.dataset.size).toBe("md");
    expect(panel.className).toContain("max-w-lg");
  });
});

describe("status text contrast", () => {
  it("uses a dark red on light backgrounds for errors", () => {
    render(
      <>
        <ErrorMessage message="Boom" />
        <FormInput id="f" label="Field" value="" onChange={() => {}} error="Bad value" />
      </>
    );
    for (const el of screen.getAllByRole("alert")) {
      expect(el.className).toContain("text-red-700");
      expect(el.className).toContain("dark:text-red-400");
    }
  });

  it("uses a dark yellow on light backgrounds for the truncation warning", () => {
    render(<TruncationNotice shown={10} total={20} noun="clients" />);
    const notice = screen.getByRole("status");
    expect(notice.className).toContain("text-yellow-800");
    expect(notice.className).toContain("dark:text-yellow-400");
  });
});

describe("Docs section navigation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [true, "auto"],
    [false, "smooth"],
  ])("respects prefers-reduced-motion=%s", (reduce, behavior) => {
    window.matchMedia = vi.fn((query) => ({
      matches: query === "(prefers-reduced-motion: reduce)" && reduce,
    }));
    window.scrollTo = vi.fn();
    render(<Docs />, { wrapper: MemoryRouter });
    fireEvent.click(screen.getAllByRole("button", { name: "Quick Start" })[0]);
    expect(window.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior }));
  });
});
