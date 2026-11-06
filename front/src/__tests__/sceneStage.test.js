import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Minimal three.js stand-in: only what mountStage touches, with spies on the disposals.
const renderer = vi.hoisted(() => ({}));
vi.mock("three", () => ({
  Color: class {},
  Scene: class {},
  PerspectiveCamera: class {
    updateProjectionMatrix() {}
  },
  WebGLRenderer: class {
    constructor() {
      Object.assign(this, renderer, {
        domElement: document.createElement("canvas"),
        setPixelRatio: vi.fn(),
        setClearColor: vi.fn(),
        setSize: vi.fn(),
        render: vi.fn(),
        dispose: vi.fn(),
        forceContextLoss: vi.fn(),
      });
      renderer.instance = this;
    }
  },
}));

const { mountStage } = await import("../components/sceneStage.js");

let observers;
let raf;
let host;
let part;

const setHidden = (hidden) => {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
  document.dispatchEvent(new Event("visibilitychange"));
};
const setOnScreen = (isIntersecting) => observers.io.callback([{ isIntersecting }]);

beforeEach(() => {
  observers = {};
  raf = { next: 1, active: new Set() };
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      callback;
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(callback) {
        this.callback = callback;
        observers.io = this;
      }
    }
  );
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor() {
        observers.theme = this;
      }
    }
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor() {
        observers.ro = this;
      }
    }
  );
  // Frames never run on their own; the tests only care which are scheduled or cancelled.
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => {
      raf.active.add(raf.next);
      return raf.next++;
    })
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id) => raf.active.delete(id))
  );
  window.devicePixelRatio = 1;
  setHidden(false);
  host = document.createElement("div");
  document.body.appendChild(host);
  part = { dispose: vi.fn() };
});

afterEach(() => {
  vi.unstubAllGlobals();
  host.remove();
});

const mount = () => mountStage(host, { fov: 40, setup: () => part });

describe("mountStage", () => {
  it("caps the pixel ratio at 1.5", () => {
    window.devicePixelRatio = 3;
    mount()();
    expect(renderer.instance.setPixelRatio).toHaveBeenCalledWith(1.5);
    window.devicePixelRatio = 1;
    mount()();
    expect(renderer.instance.setPixelRatio).toHaveBeenCalledWith(1);
  });

  it("runs while visible and onscreen, pauses when hidden or offscreen, then resumes", () => {
    const unmount = mount();
    expect(raf.active.size).toBe(1);

    setHidden(true);
    expect(raf.active.size).toBe(0);
    setHidden(false);
    expect(raf.active.size).toBe(1);

    setOnScreen(false);
    expect(raf.active.size).toBe(0);
    setOnScreen(true);
    expect(raf.active.size).toBe(1);

    // Hidden tab and offscreen host together: becoming visible alone must not resume.
    setOnScreen(false);
    setHidden(true);
    setHidden(false);
    expect(raf.active.size).toBe(0);
    unmount();
  });

  it("releases everything on unmount", () => {
    const unmount = mount();
    const { instance } = renderer;
    expect(host.contains(instance.domElement)).toBe(true);

    const canvasOff = vi.spyOn(instance.domElement, "removeEventListener");
    const windowOff = vi.spyOn(window, "removeEventListener");

    unmount();

    expect(raf.active.size).toBe(0);
    expect(observers.theme.disconnect).toHaveBeenCalled();
    expect(windowOff).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(canvasOff).toHaveBeenCalledWith("webglcontextlost", expect.any(Function));
    expect(observers.io.disconnect).toHaveBeenCalled();
    expect(observers.ro.disconnect).toHaveBeenCalled();
    expect(part.dispose).toHaveBeenCalled();
    expect(instance.dispose).toHaveBeenCalled();
    expect(instance.forceContextLoss).toHaveBeenCalled();
    expect(host.contains(instance.domElement)).toBe(false);

    // Listeners are gone too: a late visibility change must not restart the loop.
    setHidden(true);
    setHidden(false);
    expect(raf.active.size).toBe(0);
  });

  it("reports a lost WebGL context as unsupported", () => {
    const onUnsupported = vi.fn();
    const unmount = mountStage(host, { fov: 40, onUnsupported, setup: () => part });
    renderer.instance.domElement.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(onUnsupported).toHaveBeenCalledTimes(1);
    unmount();
  });
});
