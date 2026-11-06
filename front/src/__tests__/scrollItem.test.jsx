import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScrollItem } from "../components/motion/ScrollFx";

describe("ScrollItem outside a ScrollGroup", () => {
  it("renders its children as a plain element with no transforms", () => {
    render(
      <ScrollItem as="li" index={1}>
        Step one
      </ScrollItem>
    );
    const el = screen.getByText("Step one");
    expect(el.tagName).toBe("LI");
    expect(el.style.transform).toBe("");
    expect(el.style.opacity).toBe("");
  });
});
