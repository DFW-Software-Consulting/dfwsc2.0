import { act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MotionRoot, Reveal, RevealGroup, RevealItem } from "../components/motion/Reveal.jsx";

const tree = (
  <MotionRoot>
    <Reveal data-pos="in" data-testid="in">
      in view
    </Reveal>
    <Reveal mount data-pos="in" data-testid="mount">
      mount reveal
    </Reveal>
    <RevealGroup mount data-pos="in" data-testid="group">
      <RevealItem data-pos="in" data-testid="item">
        hero item
      </RevealItem>
    </RevealGroup>
    <Reveal data-pos="below" data-testid="below">
      below the fold
    </Reveal>
  </MotionRoot>
);

beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal("matchMedia", (query) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function rect() {
    const below = this.getAttribute("data-pos") === "below";
    return {
      top: below ? 2000 : 100,
      bottom: below ? 2100 : 200,
      left: 0,
      right: 0,
      width: 0,
      height: 100,
    };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("reveals when hydrating prerendered HTML", () => {
  it("never hides what is already on screen, and still reveals content below the fold", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = renderToString(tree);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const seen = [];
    // Record every opacity the on-screen elements ever have, not just the final one.
    const watch = new MutationObserver(() => {
      for (const id of ["in", "mount", "group", "item"]) {
        const el = container.querySelector(`[data-testid="${id}"]`);
        if (el) seen.push(el.style.opacity);
      }
    });
    watch.observe(container, { subtree: true, attributes: true, childList: true });

    await act(async () => {
      hydrateRoot(container, tree);
    });
    await act(async () => {});
    watch.disconnect();

    for (const id of ["in", "mount", "group", "item"]) {
      expect(container.querySelector(`[data-testid="${id}"]`).style.opacity, id).toBe("");
    }
    expect(seen.filter((opacity) => opacity === "0")).toEqual([]);
    expect(container.querySelector('[data-testid="below"]').style.opacity).toBe("0");
    expect(errors.mock.calls.filter(([m]) => !String(m).includes("useLayoutEffect"))).toEqual([]);
  });
});
