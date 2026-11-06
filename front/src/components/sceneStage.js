import { Color, PerspectiveCamera, Scene, WebGLRenderer } from "three";

// Shared three.js plumbing for the hero backdrop scenes (HeroScene, TeamScene): renderer
// with a capped DPR, theme colors read from the CSS vars, resize, pointer, a render loop
// that pauses when the tab is hidden or the host is offscreen, and full disposal. Only
// imported by the lazy scene chunks, so three.js stays out of every other chunk.

function readTheme() {
  const css = getComputedStyle(document.documentElement);
  const dark = document.documentElement.classList.contains("dark");
  return {
    dark,
    blue: new Color(css.getPropertyValue(dark ? "--link" : "--cta-bg").trim()),
    sand: new Color(css.getPropertyValue("--accent").trim()),
    // Links fade toward black when blended additively (dark) and toward paper otherwise.
    bg: dark ? new Color(0x000000) : new Color(css.getPropertyValue("--bg-main").trim()),
  };
}

/**
 * Mounts a renderer in `host` and runs `setup({ scene, camera })`, which returns
 * `{ frame(pointer), applyTheme(theme), fit(camera, aspect), dispose() }` (all optional).
 * `pointer` is the eased-by-the-scene target in -1..1. Returns the cleanup function.
 */
export function mountStage(host, { fov, onUnsupported, setup }) {
  let renderer;
  try {
    renderer = new WebGLRenderer({ alpha: true, antialias: false, powerPreference: "low-power" });
  } catch {
    onUnsupported?.();
    return undefined;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.setAttribute("aria-hidden", "true");
  canvas.className = "studio-backdrop-canvas";
  host.appendChild(canvas);

  const scene = new Scene();
  const camera = new PerspectiveCamera(fov, 1, 0.1, 100);
  const part = setup({ scene, camera });

  const applyTheme = () => part.applyTheme?.(readTheme());
  applyTheme();
  const themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

  const resize = () => {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    part.fit?.(camera, camera.aspect);
    camera.updateProjectionMatrix();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  resize();

  const pointer = { x: 0, y: 0 };
  const onPointer = (e) => {
    pointer.x = (e.clientX / window.innerWidth - 0.5) * 2;
    pointer.y = (e.clientY / window.innerHeight - 0.5) * 2;
  };

  // Run only while the host is on screen and the tab is visible.
  let raf = 0;
  let onScreen = true;
  let shown = false;
  const tick = () => {
    part.frame?.(pointer);
    renderer.render(scene, camera);
    if (!shown) {
      shown = true;
      canvas.classList.add("is-shown");
    }
    raf = requestAnimationFrame(tick);
  };
  const sync = () => {
    const shouldRun = onScreen && !document.hidden;
    if (shouldRun && !raf) {
      raf = requestAnimationFrame(tick);
      window.addEventListener("pointermove", onPointer, { passive: true });
    }
    if (!shouldRun && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
      window.removeEventListener("pointermove", onPointer);
    }
  };
  const visibility = new IntersectionObserver((entries) => {
    onScreen = entries[entries.length - 1].isIntersecting;
    sync();
  });
  visibility.observe(host);
  document.addEventListener("visibilitychange", sync);

  const onLost = (e) => {
    e.preventDefault();
    onUnsupported?.();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  sync();

  return () => {
    cancelAnimationFrame(raf);
    raf = 0;
    visibility.disconnect();
    resizeObserver.disconnect();
    themeObserver.disconnect();
    document.removeEventListener("visibilitychange", sync);
    window.removeEventListener("pointermove", onPointer);
    canvas.removeEventListener("webglcontextlost", onLost);
    part.dispose?.();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  };
}
