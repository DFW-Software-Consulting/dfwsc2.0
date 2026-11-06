import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sceneLoaded = vi.hoisted(() => vi.fn());

let HeroBackdrop;
let listeners;

function mockEnvironment({ wide = true, reduced = false, webgl = true } = {}) {
  const state = { wide, reduced };
  listeners = { wide: new Set(), reduced: new Set() };
  window.matchMedia = vi.fn((query) => {
    const key = query.includes("min-width") ? "wide" : "reduced";
    return {
      get matches() {
        return state[key];
      },
      media: query,
      addEventListener: (_type, fn) => listeners[key].add(fn),
      removeEventListener: (_type, fn) => listeners[key].delete(fn),
    };
  });
  window.requestIdleCallback = (cb) => {
    cb();
    return 1;
  };
  window.cancelIdleCallback = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() =>
    webgl ? { getExtension: () => null } : null
  );
  return {
    set(key, value) {
      state[key] = value;
      for (const fn of listeners[key]) fn({ matches: value });
    },
  };
}

// Fresh module graph per test, with the scene module mocked right before the import.
async function renderBackdrop() {
  vi.doMock("../components/HeroScene.jsx", () => {
    sceneLoaded();
    return { default: () => <canvas data-testid="scene" /> };
  });
  ({ default: HeroBackdrop } = await import("../components/HeroBackdrop.jsx"));
  let utils;
  await act(async () => {
    utils = render(<HeroBackdrop />);
  });
  return utils;
}

// Flush timers and idle callbacks so a (wrongly) scheduled scene import would have happened.
async function flush() {
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

beforeEach(() => {
  vi.resetModules();
  sceneLoaded.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock("../components/HeroScene.jsx");
  delete window.matchMedia;
  delete window.requestIdleCallback;
  delete window.cancelIdleCallback;
});

describe("HeroBackdrop", () => {
  it.each([
    ["with reduced motion", { reduced: true }],
    ["on narrow viewports", { wide: false }],
    ["when WebGL is unavailable", { webgl: false }],
  ])("keeps the static fallback and never imports the scene %s", async (_name, env) => {
    mockEnvironment(env);
    const { container } = await renderBackdrop();
    await flush();
    expect(container.querySelector('[data-scene="static"]')).toBeInTheDocument();
    expect(container.querySelector("canvas")).toBeNull();
    expect(sceneLoaded).not.toHaveBeenCalled();
  });

  it("loads the scene on wide screens with motion and WebGL", async () => {
    mockEnvironment();
    const { container } = await renderBackdrop();
    await flush();
    expect(container.querySelector('[data-scene="3d"]')).toBeInTheDocument();
    expect(sceneLoaded).toHaveBeenCalledTimes(1);
  });

  it("drops the scene and restores the fallback when the viewport narrows", async () => {
    const env = mockEnvironment();
    const { container } = await renderBackdrop();
    await flush();
    expect(container.querySelector('[data-scene="3d"]')).toBeInTheDocument();
    await act(async () => env.set("wide", false));
    await flush();
    expect(container.querySelector('[data-scene="static"]')).toBeInTheDocument();
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("drops the scene and restores the fallback when reduced motion turns on", async () => {
    const env = mockEnvironment();
    const { container } = await renderBackdrop();
    await flush();
    expect(container.querySelector('[data-scene="3d"]')).toBeInTheDocument();
    await act(async () => env.set("reduced", true));
    await flush();
    expect(container.querySelector('[data-scene="static"]')).toBeInTheDocument();
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("does not update state or error when unmounted before the import resolves", async () => {
    mockEnvironment();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // Hold the idle callback so we control when the import starts.
    let run;
    window.requestIdleCallback = (cb) => {
      run = cb;
      return 1;
    };
    const { container, unmount } = await renderBackdrop();
    expect(container.querySelector('[data-scene="static"]')).toBeInTheDocument();
    await act(async () => {
      run();
      unmount();
    });
    await flush();
    expect(errors).not.toHaveBeenCalled();
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("is decorative and hidden from assistive tech", async () => {
    mockEnvironment({ reduced: true });
    const { container } = await renderBackdrop();
    expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
  });
});
