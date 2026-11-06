import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { usePageTitle } from "../hooks/usePageTitle";

const initialTitle = document.title;

afterEach(() => {
  document.title = initialTitle;
});

describe("usePageTitle", () => {
  it("formats the supplied title with the site name and updates it when the title changes", () => {
    const { rerender } = renderHook(({ title }) => usePageTitle(title), {
      initialProps: { title: "Pricing" },
    });

    expect(document.title).toBe("Pricing - DFW Software Consulting");

    rerender({ title: "Our Team" });
    expect(document.title).toBe("Our Team - DFW Software Consulting");
  });

  it("leaves the existing document title alone for a falsy title", () => {
    document.title = "Existing title";

    renderHook(() => usePageTitle(""));

    expect(document.title).toBe("Existing title");
  });
});
