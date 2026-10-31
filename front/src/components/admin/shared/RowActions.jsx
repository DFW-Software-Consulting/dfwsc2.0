import { useCallback, useEffect, useId, useRef, useState } from "react";
import Button from "./Button";

/**
 * Row action buttons driven by a list of specs:
 *   { key, label, onClick, variant, disabled, isLoading, title, primary }
 *
 * `inline` renders every action as a Button (desktop table cells).
 * `card` renders the `primary` action (default: the first) as a Button and moves the
 * rest into an overflow menu; with two actions or fewer it just wraps them in a row.
 */
export default function RowActions({ actions, mode = "inline", menuLabel = "More actions" }) {
  if (mode === "inline") {
    return (
      <div className="flex gap-2">
        {actions.map((a) => (
          <ActionButton key={a.key} action={a} />
        ))}
      </div>
    );
  }
  if (actions.length <= 2) {
    return (
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => (
          <ActionButton key={a.key} action={a} />
        ))}
      </div>
    );
  }
  const lead = actions.find((a) => a.primary) ?? actions[0];
  const rest = actions.filter((a) => a !== lead);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ActionButton action={lead} />
      <OverflowMenu actions={rest} label={menuLabel} />
    </div>
  );
}

function ActionButton({ action }) {
  return (
    <Button
      size="sm"
      variant={action.variant ?? "secondary"}
      disabled={action.disabled}
      isLoading={action.isLoading}
      title={action.title}
      onClick={action.onClick}
    >
      {action.label}
    </Button>
  );
}

const ITEM_BASE =
  "flex w-full items-center rounded px-3 text-left text-sm min-h-11 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus aria-disabled:opacity-50 aria-disabled:cursor-not-allowed";

function OverflowMenu({ actions, label }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();

  // Disabled and loading items stay in the arrow-key order (aria-disabled, not the native
  // disabled attribute) so every action stays reachable with its name; activation is guarded.
  const items = () => [...(menuRef.current?.querySelectorAll('[role="menuitem"]') ?? [])];

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Move focus into the menu when it opens.
  useEffect(() => {
    if (open) menuRef.current?.querySelector('[role="menuitem"]')?.focus();
  }, [open]);

  // Close on outside press without stealing focus from whatever was pressed.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onMenuKeyDown = (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    let next = null;
    if (e.key === "ArrowDown") next = list[(i + 1) % list.length];
    else if (e.key === "ArrowUp") next = list[(i - 1 + list.length) % list.length];
    else if (e.key === "Home") next = list[0];
    else if (e.key === "End") next = list[list.length - 1];
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    } else if (e.key === "Tab") {
      close(false);
      return;
    }
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  const onTriggerKeyDown = (e) => {
    if (e.key === "ArrowDown" && !open) {
      e.preventDefault();
      setOpen(true);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
        className="inline-flex items-center justify-center gap-1 rounded-md border border-line bg-surface px-3 py-1 text-xs font-medium text-fg transition-colors hover:border-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11 max-md:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
      >
        {label}
        <svg aria-hidden="true" className="size-3" viewBox="0 0 20 20" fill="currentColor">
          <path d="M5.3 7.3a1 1 0 011.4 0L10 10.6l3.3-3.3a1 1 0 111.4 1.4l-4 4a1 1 0 01-1.4 0l-4-4a1 1 0 010-1.4z" />
        </svg>
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
          className="absolute left-0 z-20 mt-1 min-w-44 rounded-md border border-line bg-card p-1 shadow-lg"
        >
          {actions.map((a) => {
            const inactive = Boolean(a.disabled || a.isLoading);
            return (
              <button
                key={a.key}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={inactive ? "true" : undefined}
                aria-busy={a.isLoading ? "true" : undefined}
                title={a.title}
                onClick={() => {
                  if (inactive) return;
                  close();
                  a.onClick?.();
                }}
                className={`${ITEM_BASE} ${
                  a.variant === "danger" || a.variant === "ghost-danger"
                    ? "text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-400/10"
                    : "text-fg hover:bg-accent-soft"
                }`}
              >
                {a.label}
                {a.isLoading && (
                  <svg
                    aria-hidden="true"
                    className="ml-auto size-3 animate-spin"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                    />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
