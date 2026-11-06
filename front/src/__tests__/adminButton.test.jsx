import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Button from "../components/admin/shared/Button.jsx";

const ADMIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "../components/admin");

// bg-* or text-<color> utilities, with any variant prefix (hover:, dark:, ...).
// Text sizes and alignment are layout, not color.
const COLOR_UTILITY =
  /(^|\s)([a-z-]+:)*(bg-|text-(?!(xs|sm|base|lg|[2-9]?xl|left|right|center|justify)(\s|$)))/;

function adminSources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return adminSources(path);
    return entry.name.endsWith(".jsx") ? [{ path, source: readFileSync(path, "utf-8") }] : [];
  });
}

describe("Button", () => {
  it("renders the ghost variants with one text color pairing each, light and dark", () => {
    render(
      <>
        <Button variant="ghost-info">Edit</Button>
        <Button variant="ghost-warning">Unlink</Button>
        <Button variant="ghost-danger">Deactivate</Button>
      </>
    );

    expect(screen.getByRole("button", { name: "Edit" })).toHaveClass(
      "text-brand-700",
      "dark:text-brand-300"
    );
    expect(screen.getByRole("button", { name: "Unlink" })).toHaveClass(
      "text-yellow-800",
      "dark:text-yellow-400"
    );
    const deactivate = screen.getByRole("button", { name: "Deactivate" });
    expect(deactivate).toHaveClass("text-red-700", "dark:text-red-400");
    expect(deactivate).not.toHaveClass("text-fg-muted");
  });

  it("appends layout classes from className and falls back to primary for unknown variants", () => {
    render(
      <Button variant="nope" className="w-full shadow-lg">
        Save
      </Button>
    );

    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveClass("bg-brand-500", "text-white", "w-full", "shadow-lg");
  });

  it("forwards title", () => {
    render(
      <Button variant="secondary" title="Already onboarded" disabled>
        Resend Link
      </Button>
    );

    expect(screen.getByRole("button", { name: "Resend Link" })).toHaveAttribute(
      "title",
      "Already onboarded"
    );
  });

  // Same-property utilities resolve by stylesheet order, so a color passed through
  // className can silently lose to the variant's color. Colors belong in a variant.
  it("is never given color utilities through className in admin components", () => {
    const offenders = [];
    for (const { path, source } of adminSources(ADMIN_DIR)) {
      // Each <Button ...> opening tag, ending at the first ">" that isn't part of "=>".
      for (const [tag] of source.matchAll(/<Button\b[\s\S]*?[^=]>/g)) {
        for (const [, classes] of tag.matchAll(/className=["{`]+([^"`}]*)/g)) {
          if (COLOR_UTILITY.test(classes)) offenders.push(`${path}: ${classes}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
