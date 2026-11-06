import { useEffect, useRef } from "react";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  NormalBlending,
  Points,
  PointsMaterial,
} from "three";
import { mountStage } from "./sceneStage.js";

// "Connected nodes" blueprint field behind the Home hero. Only ever loaded through the
// dynamic import in HeroBackdrop, so three.js stays out of every other chunk.

const POINTS = 210;
const BOX = { x: 30, y: 15, z: 6 };
const LINK_DISTANCE = 3.6;
const MAX_LINKS = 520;
const FOV = 50;

function dotTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(255,255,255,0.9)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new CanvasTexture(canvas);
}

// Builds the node field into the stage; returns the stage hooks (see mountStage).
function buildNodes({ scene }, progress) {
  const group = new Group();
  scene.add(group);

  // Node state: positions and slow velocities live in typed arrays, no per-frame allocation.
  const pos = new Float32Array(POINTS * 3);
  const vel = new Float32Array(POINTS * 3);
  const accent = new Uint8Array(POINTS);
  for (let i = 0; i < POINTS; i++) {
    pos[i * 3] = (Math.random() - 0.5) * BOX.x;
    pos[i * 3 + 1] = (Math.random() - 0.5) * BOX.y;
    pos[i * 3 + 2] = (Math.random() - 0.5) * BOX.z;
    vel[i * 3] = (Math.random() - 0.5) * 0.008;
    vel[i * 3 + 1] = (Math.random() - 0.5) * 0.008;
    vel[i * 3 + 2] = (Math.random() - 0.5) * 0.004;
    accent[i] = Math.random() < 0.08 ? 1 : 0;
  }
  const pointColors = new Float32Array(POINTS * 3);
  const pointGeo = new BufferGeometry();
  pointGeo.setAttribute("position", new BufferAttribute(pos, 3));
  pointGeo.setAttribute("color", new BufferAttribute(pointColors, 3));
  const texture = dotTexture();
  const pointMat = new PointsMaterial({
    size: 0.34,
    map: texture,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
  });
  group.add(new Points(pointGeo, pointMat));

  const linePos = new Float32Array(MAX_LINKS * 6);
  const lineColors = new Float32Array(MAX_LINKS * 6);
  const lineGeo = new BufferGeometry();
  lineGeo.setAttribute("position", new BufferAttribute(linePos, 3));
  lineGeo.setAttribute("color", new BufferAttribute(lineColors, 3));
  lineGeo.setDrawRange(0, 0);
  const lineMat = new LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
  });
  group.add(new LineSegments(lineGeo, lineMat));

  let theme;
  const applyTheme = (next) => {
    theme = next;
    // Light paper needs normal blending and lower intensity; the navy bg takes additive glow.
    const blending = theme.dark ? AdditiveBlending : NormalBlending;
    pointMat.blending = blending;
    lineMat.blending = blending;
    pointMat.opacity = theme.dark ? 0.85 : 0.5;
    lineMat.opacity = theme.dark ? 0.5 : 0.28;
    pointMat.needsUpdate = true;
    lineMat.needsUpdate = true;
    for (let i = 0; i < POINTS; i++) {
      const c = accent[i] ? theme.sand : theme.blue;
      pointColors[i * 3] = c.r;
      pointColors[i * 3 + 1] = c.g;
      pointColors[i * 3 + 2] = c.b;
    }
    pointGeo.attributes.color.needsUpdate = true;
  };

  const tmp = new Color();
  const frame = (target) => {
    for (let i = 0; i < POINTS; i++) {
      const k = i * 3;
      pos[k] += vel[k];
      pos[k + 1] += vel[k + 1];
      pos[k + 2] += vel[k + 2];
      if (Math.abs(pos[k]) > BOX.x / 2) vel[k] *= -1;
      if (Math.abs(pos[k + 1]) > BOX.y / 2) vel[k + 1] *= -1;
      if (Math.abs(pos[k + 2]) > BOX.z / 2) vel[k + 2] *= -1;
    }
    pointGeo.attributes.position.needsUpdate = true;

    let n = 0;
    const max2 = LINK_DISTANCE * LINK_DISTANCE;
    for (let i = 0; i < POINTS && n < MAX_LINKS; i++) {
      for (let j = i + 1; j < POINTS && n < MAX_LINKS; j++) {
        const dx = pos[i * 3] - pos[j * 3];
        const dy = pos[i * 3 + 1] - pos[j * 3 + 1];
        const dz = pos[i * 3 + 2] - pos[j * 3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > max2) continue;
        // Fade each link toward the background with distance.
        const fade = 1 - Math.sqrt(d2) / LINK_DISTANCE;
        tmp.copy(theme.bg).lerp(accent[i] || accent[j] ? theme.sand : theme.blue, fade);
        const o = n * 6;
        linePos[o] = pos[i * 3];
        linePos[o + 1] = pos[i * 3 + 1];
        linePos[o + 2] = pos[i * 3 + 2];
        linePos[o + 3] = pos[j * 3];
        linePos[o + 4] = pos[j * 3 + 1];
        linePos[o + 5] = pos[j * 3 + 2];
        lineColors[o] = lineColors[o + 3] = tmp.r;
        lineColors[o + 1] = lineColors[o + 4] = tmp.g;
        lineColors[o + 2] = lineColors[o + 5] = tmp.b;
        n++;
      }
    }
    lineGeo.setDrawRange(0, n * 2);
    lineGeo.attributes.position.needsUpdate = true;
    lineGeo.attributes.color.needsUpdate = true;

    // Scroll drift: the field rises slower than the page and turns a little as the hero leaves.
    const scrolled = progress?.get() ?? 0;
    group.position.y += (scrolled * 3 - group.position.y) * 0.08;
    group.rotation.y += (target.x * 0.06 + scrolled * 0.5 - group.rotation.y) * 0.03;
    group.rotation.x += (target.y * 0.04 + scrolled * 0.2 - group.rotation.x) * 0.03;
  };

  return {
    frame,
    applyTheme,
    fit: (camera, aspect) => {
      // Fit the node box so it always covers the visible frustum.
      const t = 2 * Math.tan((FOV * Math.PI) / 360);
      camera.position.z = Math.min(BOX.y / t, BOX.x / (t * aspect));
    },
    dispose: () => {
      pointGeo.dispose();
      lineGeo.dispose();
      pointMat.dispose();
      lineMat.dispose();
      texture.dispose();
    },
  };
}

// fallow-ignore-next-line unused-export
export default function HeroScene({ onUnsupported, progress }) {
  const hostRef = useRef(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    return mountStage(host, {
      fov: FOV,
      onUnsupported,
      setup: (stage) => buildNodes(stage, progress),
    });
  }, [onUnsupported, progress]); // both must be stable (useCallback / MotionValue) or the scene rebuilds each render

  return <div ref={hostRef} className="studio-backdrop-scene" />;
}
