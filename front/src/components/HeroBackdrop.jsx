import { useCallback, useEffect, useRef, useState } from "react";

// Decorative hero background. The static fallback (blue glow + faint blueprint grid)
// always renders. The three.js scene is a separate lazy chunk that is only requested
// on wide screens, without reduced motion, with WebGL, and after the page is idle.

const WIDE = "(min-width: 1024px)";
const REDUCED = "(prefers-reduced-motion: reduce)";

function matches(query) {
  return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

function hasWebGL() {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!gl) return false;
    // Intentional probe: stops the ~133 kB three.js chunk downloading on devices without WebGL.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function whenIdle(callback) {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(callback, { timeout: 2000 });
    return () => window.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(callback, 300);
  return () => window.clearTimeout(id);
}

// Scene loaders. Each is a dynamic import so every scene is its own lazy chunk.
const loadNodes = () => import("./HeroScene.jsx").then((mod) => mod.default);
export const loadTerrain = () => import("./TeamScene.jsx").then((mod) => mod.default);

/**
 * `progress`: optional MotionValue (0..1) of the hero scrolling out; the scene drifts with it.
 * `load`: resolves to the scene component (default: Home's node field).
 */
export default function HeroBackdrop({ progress, load = loadNodes }) {
  const [Scene, setScene] = useState(null);
  // Held in a ref so an inline `load` neither re-runs the gating effect nor disposes the scene.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  const dropScene = useCallback(() => setScene(null), []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const wide = window.matchMedia(WIDE);
    const reduced = window.matchMedia(REDUCED);
    let cancelIdle = null;
    let cancelled = false;
    let webgl; // probed once, only when the other conditions pass

    const evaluate = () => {
      cancelIdle?.();
      cancelIdle = null;
      if (!matches(WIDE) || matches(REDUCED)) {
        setScene(null); // resized narrow or motion turned off: unmount and dispose
        return;
      }
      cancelIdle = whenIdle(async () => {
        if (webgl === undefined) webgl = hasWebGL();
        if (!webgl) return;
        try {
          const Component = await loadRef.current();
          if (!cancelled && matches(WIDE) && !matches(REDUCED)) setScene(() => Component);
        } catch {
          // Chunk failed to load: keep the static fallback.
        }
      });
    };

    evaluate();
    wide.addEventListener("change", evaluate);
    reduced.addEventListener("change", evaluate);
    return () => {
      cancelled = true;
      cancelIdle?.();
      wide.removeEventListener("change", evaluate);
      reduced.removeEventListener("change", evaluate);
    };
  }, []);

  return (
    <div className="studio-backdrop" aria-hidden="true" data-scene={Scene ? "3d" : "static"}>
      <div className="studio-backdrop-grid" />
      {Scene ? <Scene onUnsupported={dropScene} progress={progress} /> : null}
    </div>
  );
}
