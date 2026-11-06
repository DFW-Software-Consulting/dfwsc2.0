import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessGrid, ScrollGroup, ScrollItem } from "../components/motion/ScrollFx";
import css from "../index.css?raw";

const motion = vi.hoisted(() => ({ allowed: true }));
vi.mock("../components/motion/useMotionAllowed.js", () => ({
  useMotionAllowed: () => motion.allowed,
}));

beforeEach(() => {
  motion.allowed = true;
});

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

describe("ProcessGrid color fade", () => {
  const steps = [["01", "Plan", "Copy one"]];

  it("drives --step-lit and never touches opacity", () => {
    render(<ProcessGrid steps={steps} />);
    const step = screen.getByText("Plan").closest("article");
    expect(step.style.opacity).toBe("");
    expect(step.style.getPropertyValue("--step-lit")).not.toBe("");
  });

  it("emits no style at all under reduced motion", () => {
    motion.allowed = false;
    render(<ProcessGrid steps={steps} />);
    const step = screen.getByText("Plan").closest("article");
    expect(step.getAttribute("style")).toBeNull();
    expect(step.style.getPropertyValue("--step-lit")).toBe("");
  });

  it("does not emit --step-lit for an item without colorFade", () => {
    render(
      <ScrollGroup>
        <ScrollItem as="p">Plain item</ScrollItem>
      </ScrollGroup>
    );
    const el = screen.getByText("Plain item");
    expect(el.style.getPropertyValue("--step-lit")).toBe("");
    expect(el.style.opacity).not.toBe("");
  });
});

// Contrast guard: the dimmest step color is the dim token itself (the mix runs between two
// tokens), so it must clear AA 4.5:1 on the band background in each theme.

function themeTokens(selector) {
  const start = css.indexOf(`${selector} {`);
  const block = css.slice(start, css.indexOf("\n  }", start));
  const tokens = {};
  for (const [, name, value] of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    tokens[name] = value;
  }
  return tokens;
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe.each([
  ["light", ":root"],
  ["dark", ".dark"],
])("process step dim tokens (%s theme)", (_theme, selector) => {
  const t = themeTokens(selector);

  it("defines the dim tokens", () => {
    expect(t["step-dim-text"]).toBeDefined();
    expect(t["step-dim-accent"]).toBeDefined();
  });

  it.each(["step-dim-text", "step-dim-accent"])("%s keeps AA contrast on the band", (name) => {
    expect(contrast(t[name], t["bg-surface"])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["text-main", "text-muted", "accent"])("full token %s keeps AA contrast", (name) => {
    expect(contrast(t[name], t["bg-surface"])).toBeGreaterThanOrEqual(4.5);
  });
});
