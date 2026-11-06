import { useEffect, useRef } from "react";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  LineBasicMaterial,
  LineSegments,
  NormalBlending,
} from "three";
import { mountStage } from "./sceneStage.js";

// Topographic wave grid behind the Team hero: a wireframe terrain whose swell drifts on
// its own, ripples around the cursor, and rolls forward as the hero scrolls away. Only
// ever loaded through the dynamic import in HeroBackdrop.

const COLS = 56;
const ROWS = 30;
const SIZE = { x: 52, z: 30 };
const FOV = 45;

function buildTerrain({ scene, camera }, progress) {
  const count = COLS * ROWS;
  const pos = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = (r * COLS + c) * 3;
      pos[i] = (c / (COLS - 1) - 0.5) * SIZE.x;
      pos[i + 2] = (r / (ROWS - 1) - 0.5) * SIZE.z;
    }
  }
  // Wireframe indices: every row and every column as line segments.
  const index = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const v = r * COLS + c;
      if (c < COLS - 1) index.push(v, v + 1);
      if (r < ROWS - 1) index.push(v, v + COLS);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  geo.setAttribute("color", new BufferAttribute(colors, 3));
  geo.setIndex(index);
  const mat = new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
  scene.add(new LineSegments(geo, mat));

  let theme;
  const applyTheme = (next) => {
    theme = next;
    mat.blending = theme.dark ? AdditiveBlending : NormalBlending;
    mat.opacity = theme.dark ? 0.8 : 0.55;
    mat.needsUpdate = true;
  };

  const tmp = new Color();
  const cursor = { x: 0, z: 0 };
  let scroll = 0;
  let t = 0;
  const frame = (pointer) => {
    t += 0.012;
    const scrolled = progress?.get() ?? 0;
    scroll += (scrolled - scroll) * 0.06;
    // Cursor mapped onto the terrain plane, eased.
    cursor.x += (pointer.x * SIZE.x * 0.45 - cursor.x) * 0.06;
    cursor.z += (pointer.y * SIZE.z * 0.3 - cursor.z) * 0.06;
    const phase = scroll * 7;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const i = (r * COLS + c) * 3;
        const x = pos[i];
        const z = pos[i + 2];
        const dx = x - cursor.x;
        const dz = z - cursor.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        const h =
          0.7 * Math.sin(x * 0.32 + t) * Math.cos(z * 0.36 - t * 0.7) +
          0.45 * Math.sin(x * 0.11 + z * 0.19 + phase) +
          1.1 * Math.exp(-d * d * 0.03) * Math.sin(d * 1.6 - t * 4);
        pos[i + 1] = h;
        // Far rows and low ground fade into the page; crests warm to sand.
        const depth = 0.15 + 0.85 * (r / (ROWS - 1));
        const crest = Math.max(0, Math.min(1, (h - 0.6) / 1.2));
        tmp
          .copy(theme.bg)
          .lerp(theme.blue, depth)
          .lerp(theme.sand, crest * 0.7);
        colors[i] = tmp.r;
        colors[i + 1] = tmp.g;
        colors[i + 2] = tmp.b;
      }
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    // The camera lowers and tilts up a little as the hero scrolls out.
    camera.position.set(pointer.x * -0.8, 7 - scroll * 3, 15);
    camera.lookAt(0, -1 + scroll * 2, 0);
  };

  return {
    frame,
    applyTheme,
    dispose: () => {
      geo.dispose();
      mat.dispose();
    },
  };
}

// fallow-ignore-next-line unused-export
export default function TeamScene({ onUnsupported, progress }) {
  const hostRef = useRef(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    return mountStage(host, {
      fov: FOV,
      onUnsupported,
      setup: (stage) => buildTerrain(stage, progress),
    });
  }, [onUnsupported, progress]);

  return <div ref={hostRef} className="studio-backdrop-scene" />;
}
