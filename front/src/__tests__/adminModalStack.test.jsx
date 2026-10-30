import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConfirmModal from "../components/admin/ConfirmModal";
import BaseModal from "../components/admin/shared/BaseModal";

// Mirrors ClientProfileView → EditClientModal (BaseModal inside BaseModal), plus a
// ConfirmModal that can open on top of the inner dialog. Handlers are inline arrows
// on purpose: re-renders must not reorder the modal stack.
function NestedModals() {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOuter(true)}>
        Open outer
      </button>
      <BaseModal isOpen={outer} onClose={() => setOuter(false)} title="Outer">
        <button type="button" onClick={() => setInner(true)}>
          Open inner
        </button>
        <BaseModal isOpen={inner} onClose={() => setInner(false)} title="Inner">
          <button type="button" onClick={() => setConfirm(true)}>
            Open confirm
          </button>
          <ConfirmModal
            isOpen={confirm}
            title="Sure?"
            message="m"
            onConfirm={() => setConfirm(false)}
            onCancel={() => setConfirm(false)}
          />
        </BaseModal>
      </BaseModal>
    </>
  );
}

const pressEscape = () => fireEvent.keyDown(document, { key: "Escape" });
const dialog = (name) => screen.queryByRole("dialog", { name });

afterEach(() => {
  document.body.style.overflow = "";
});

describe("nested modal stack", () => {
  it("closes only the topmost modal on each Escape", () => {
    render(<NestedModals />);
    fireEvent.click(screen.getByText("Open outer"));
    fireEvent.click(screen.getByText("Open inner"));
    fireEvent.click(screen.getByText("Open confirm"));
    expect(dialog("Sure?")).toBeInTheDocument();

    pressEscape();
    expect(dialog("Sure?")).not.toBeInTheDocument();
    expect(dialog("Inner")).toBeInTheDocument();
    expect(dialog("Outer")).toBeInTheDocument();

    pressEscape();
    expect(dialog("Inner")).not.toBeInTheDocument();
    expect(dialog("Outer")).toBeInTheDocument();

    pressEscape();
    expect(dialog("Outer")).not.toBeInTheDocument();
  });

  it("keeps the body scroll-locked until the last modal closes", () => {
    document.body.style.overflow = "scroll";
    render(<NestedModals />);
    fireEvent.click(screen.getByText("Open outer"));
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(screen.getByText("Open inner"));
    fireEvent.click(screen.getByText("Open confirm"));
    expect(document.body.style.overflow).toBe("hidden");

    pressEscape();
    expect(document.body.style.overflow).toBe("hidden");
    pressEscape();
    expect(document.body.style.overflow).toBe("hidden");
    pressEscape();
    // Restores whatever the page had before the first modal opened.
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("restores focus to each opener through nested open/close", async () => {
    render(<NestedModals />);
    const openOuter = screen.getByText("Open outer");
    openOuter.focus();
    fireEvent.click(openOuter);
    await waitFor(() => expect(dialog("Outer").querySelector("[data-size]")).toHaveFocus());

    const openInner = screen.getByText("Open inner");
    openInner.focus();
    fireEvent.click(openInner);
    await waitFor(() => expect(dialog("Inner").querySelector("[data-size]")).toHaveFocus());

    const openConfirm = screen.getByText("Open confirm");
    openConfirm.focus();
    fireEvent.click(openConfirm);
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus());

    pressEscape();
    expect(openConfirm).toHaveFocus();
    pressEscape();
    expect(openInner).toHaveFocus();
    pressEscape();
    expect(openOuter).toHaveFocus();
  });

  it("returns focus to the outer opener and unlocks scroll when the whole stack unmounts", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(
      <BaseModal isOpen onClose={() => {}} title="Outer">
        <BaseModal isOpen onClose={() => {}} title="Inner">
          body
        </BaseModal>
      </BaseModal>
    );
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("only traps Tab in the topmost modal", () => {
    render(<NestedModals />);
    fireEvent.click(screen.getByText("Open outer"));
    fireEvent.click(screen.getByText("Open inner"));
    // Focus has wandered back into the outer dialog; Tab must pull it into the inner one.
    screen.getByText("Open inner").focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(dialog("Inner").contains(document.activeElement)).toBe(true);
  });
});

describe("ConfirmModal keyboard handling", () => {
  function renderConfirm(props = {}) {
    const onCancel = vi.fn();
    render(
      <ConfirmModal
        isOpen
        title="Delete?"
        message="m"
        onConfirm={() => {}}
        onCancel={onCancel}
        {...props}
      />
    );
    return {
      onCancel,
      cancel: screen.getByRole("button", { name: "Cancel" }),
      confirm: screen.getByRole("button", { name: "Confirm" }),
    };
  }

  it("focuses the confirm button on open", async () => {
    const { confirm } = renderConfirm();
    await waitFor(() => expect(confirm).toHaveFocus());
  });

  it("wraps Tab from the last button to the first", () => {
    const { cancel, confirm } = renderConfirm();
    confirm.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(cancel).toHaveFocus();
  });

  it("wraps Shift+Tab from the first button to the last", () => {
    const { cancel, confirm } = renderConfirm();
    cancel.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();
  });

  it("pulls focus back inside when it has escaped the dialog", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const { cancel } = renderConfirm();
    outside.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(cancel).toHaveFocus();
    outside.remove();
  });

  it("cancels on Escape exactly once", () => {
    const { onCancel } = renderConfirm();
    pressEscape();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not react to keys while closed", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmModal isOpen={false} title="x" message="m" onConfirm={() => {}} onCancel={onCancel} />
    );
    pressEscape();
    expect(onCancel).not.toHaveBeenCalled();
    expect(document.body.style.overflow).toBe("");
  });
});
