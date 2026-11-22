import * as THREE from "three";
import { MAP_W, MAP_H, SPAWNS } from "../shared/gamedefs";

// Deterministic PRNG so procedural textures are consistent across frames and clients
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

// Smooth 2D value noise for organic battlefield terrain variation
function valueNoise2D(seed: number) {
  const rand = mulberry32(seed);
  const N = 64;
  const grid = new Float32Array(N * N);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const sample = (x: number, y: number) => {
    const xi = ((Math.floor(x) % N) + N) % N;
    const yi = ((Math.floor(y) % N) + N) % N;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const x1 = (xi + 1) % N;
    const y1 = (yi + 1) % N;
    const a = grid[yi * N + xi];
    const b = grid[yi * N + x1];
    const c = grid[y1 * N + xi];
    const d = grid[y1 * N + x1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  return (x: number, y: number) =>
    sample(x, y) * 0.55 + sample(x * 2.1 + 13.7, y * 2.1 + 7.3) * 0.3 + sample(x * 4.3 + 29.1, y * 4.3 + 19.4) * 0.15;
}

// ---------- Shared surface detail maps ----------

let armorBumpTex: THREE.CanvasTexture | null = null;
let armorRoughTex: THREE.CanvasTexture | null = null;
let concreteDiffTex: THREE.CanvasTexture | null = null;
let concreteBumpTex: THREE.CanvasTexture | null = null;
let treadTex: THREE.CanvasTexture | null = null;

function ensureArmorDetail() {
  if (armorBumpTex && armorRoughTex) return;
  const S = 256;
  const [bc, bctx] = makeCanvas(S, S);
  const [rc, rctx] = makeCanvas(S, S);
  const rand = mulberry32(4201);

  // Base brushed metal grain
  bctx.fillStyle = "#808080";
  bctx.fillRect(0, 0, S, S);
  rctx.fillStyle = "#7c7c7c";
  rctx.fillRect(0, 0, S, S);

  for (let i = 0; i < 900; i++) {
    const x = rand() * S;
    const y = rand() * S;
    const len = 8 + rand() * 34;
    const v = 112 + ((rand() * 34) | 0);
    bctx.fillStyle = `rgb(${v},${v},${v})`;
    bctx.fillRect(x, y, len, 1);
    const rv = 105 + ((rand() * 48) | 0);
    rctx.fillStyle = `rgb(${rv},${rv},${rv})`;
    rctx.fillRect(x, y, len, 1.5);
  }

  // Armor panel seams
  const panels = [
    [0, 0, S / 2, S / 2],
    [S / 2, 0, S / 2, S / 2],
    [0, S / 2, S / 2, S / 2],
    [S / 2, S / 2, S / 2, S / 2],
  ];
  for (const [px, py, pw, ph] of panels) {
    // Dark recessed seam
    bctx.strokeStyle = "#363636";
    bctx.lineWidth = 3;
    bctx.strokeRect(px + 2, py + 2, pw - 4, ph - 4);
    // Subtle bevel highlight inside seam
    bctx.strokeStyle = "#adadad";
    bctx.lineWidth = 1;
    bctx.strokeRect(px + 4, py + 4, pw - 8, ph - 8);
    // Edge wear (shinier metal along seams)
    rctx.strokeStyle = "#525252";
    rctx.lineWidth = 2;
    rctx.strokeRect(px + 4, py + 4, pw - 8, ph - 8);

    // Corner rivets
    for (const [rx, ry] of [
      [px + 12, py + 12],
      [px + pw - 12, py + 12],
      [px + 12, py + ph - 12],
      [px + pw - 12, py + ph - 12],
    ]) {
      bctx.fillStyle = "#c8c8c8";
      bctx.beginPath();
      bctx.arc(rx, ry, 2.6, 0, Math.PI * 2);
      bctx.fill();
      bctx.fillStyle = "#484848";
      bctx.beginPath();
      bctx.arc(rx + 0.8, ry + 0.8, 1.2, 0, Math.PI * 2);
      bctx.fill();
    }
  }

  // Louver vents on lower-right plate
  for (let y = S / 2 + 24; y < S - 24; y += 10) {
    bctx.fillStyle = "#323232";
    bctx.fillRect(S / 2 + 24, y, S / 2 - 48, 4);
    rctx.fillStyle = "#b0b0b0";
    rctx.fillRect(S / 2 + 24, y, S / 2 - 48, 4);
  }

  armorBumpTex = new THREE.CanvasTexture(bc);
  armorBumpTex.wrapS = armorBumpTex.wrapT = THREE.RepeatWrapping;
  armorRoughTex = new THREE.CanvasTexture(rc);
  armorRoughTex.wrapS = armorRoughTex.wrapT = THREE.RepeatWrapping;
}

function ensureConcrete() {
  if (concreteDiffTex && concreteBumpTex) return;
  const S = 256;
  const [dc, dctx] = makeCanvas(S, S);
  const [bc, bctx] = makeCanvas(S, S);
  const rand = mulberry32(9012);

  dctx.fillStyle = "#4c5358";
  dctx.fillRect(0, 0, S, S);
  bctx.fillStyle = "#808080";
  bctx.fillRect(0, 0, S, S);

  // Aggregate speckles
  for (let i = 0; i < 3500; i++) {
    const x = rand() * S;
    const y = rand() * S;
    const s = 1 + rand() * 2.5;
    const delta = ((rand() - 0.5) * 32) | 0;
    const r = Math.max(40, Math.min(120, 76 + delta));
    const g = Math.max(44, Math.min(126, 83 + delta));
    const b = Math.max(48, Math.min(132, 88 + delta));
    dctx.fillStyle = `rgb(${r},${g},${b})`;
    dctx.fillRect(x, y, s, s);
    const bv = Math.max(50, Math.min(200, 128 + delta * 2));
    bctx.fillStyle = `rgb(${bv},${bv},${bv})`;
    bctx.fillRect(x, y, s, s);
  }

  // Expansion joints
  dctx.strokeStyle = "#2b3035";
  dctx.lineWidth = 3;
  dctx.strokeRect(4, 4, S - 8, S - 8);
  dctx.beginPath();
  dctx.moveTo(S / 2, 4);
  dctx.lineTo(S / 2, S - 4);
  dctx.moveTo(4, S / 2);
  dctx.lineTo(S - 4, S / 2);
  dctx.stroke();

  bctx.strokeStyle = "#303030";
  bctx.lineWidth = 3;
  bctx.strokeRect(4, 4, S - 8, S - 8);

  // Industrial hazard trim strips along the perimeter edge
  dctx.save();
  dctx.beginPath();
  dctx.rect(6, 6, S - 12, 11);
  dctx.rect(6, S - 17, S - 12, 11);
  dctx.clip();
  dctx.fillStyle = "#232629";
  dctx.fillRect(0, 0, S, S);
  dctx.fillStyle = "#c89626";
  for (let x = -S; x < S * 2; x += 22) {
    dctx.beginPath();
    dctx.moveTo(x, 0);
    dctx.lineTo(x + 11, 0);
    dctx.lineTo(x - 10, S);
    dctx.lineTo(x - 21, S);
    dctx.closePath();
    dctx.fill();
  }
  dctx.restore();

  concreteDiffTex = new THREE.CanvasTexture(dc);
  concreteDiffTex.colorSpace = THREE.SRGBColorSpace;
  concreteDiffTex.anisotropy = 4;
  concreteBumpTex = new THREE.CanvasTexture(bc);
}

export function getTreadTexture(): THREE.CanvasTexture {
  if (treadTex) return treadTex;
  const [c, ctx] = makeCanvas(64, 128);
  ctx.fillStyle = "#171a1d";
  ctx.fillRect(0, 0, 64, 128);
  for (let y = 0; y < 128; y += 16) {
    ctx.fillStyle = "#2b3035";
    ctx.fillRect(4, y + 2, 56, 9);
    ctx.fillStyle = "#0e1012";
    ctx.fillRect(28, y + 2, 8, 9);
  }
  treadTex = new THREE.CanvasTexture(c);
  treadTex.colorSpace = THREE.SRGBColorSpace;
  treadTex.wrapS = treadTex.wrapT = THREE.RepeatWrapping;
  treadTex.repeat.set(1, 3);
  return treadTex;
}

// ---------- Material caches ----------

const armorMatCache = new Map<string, THREE.MeshStandardMaterial>();
export function getArmorMat(hex: string, metalness = 0.45, roughness = 0.56, emissive = 0): THREE.MeshStandardMaterial {
  ensureArmorDetail();
  const key = `${hex}|${metalness}|${roughness}|${emissive}`;
  let m = armorMatCache.get(key);
  if (!m) {
    const c = new THREE.Color(hex);
    m = new THREE.MeshStandardMaterial({
      color: c,
      metalness,
      roughness,
      bumpMap: armorBumpTex!,
      bumpScale: 0.035,
      roughnessMap: armorRoughTex!,
      emissive: emissive > 0 ? c.clone().multiplyScalar(emissive) : new THREE.Color(0x000000),
    });
    armorMatCache.set(key, m);
  }
  return m;
}

let concreteMatCache: THREE.MeshStandardMaterial | null = null;
export function getConcreteMat(): THREE.MeshStandardMaterial {
  ensureConcrete();
  if (!concreteMatCache) {
    concreteMatCache = new THREE.MeshStandardMaterial({
      map: concreteDiffTex!,
      bumpMap: concreteBumpTex!,
      bumpScale: 0.04,
      roughness: 0.88,
      metalness: 0.08,
    });
  }
  return concreteMatCache;
}

let treadMatCache: THREE.MeshStandardMaterial | null = null;
export function getTreadMat(): THREE.MeshStandardMaterial {
  if (!treadMatCache) {
    treadMatCache = new THREE.MeshStandardMaterial({
      map: getTreadTexture(),
      roughness: 0.85,
      metalness: 0.25,
    });
  }
  return treadMatCache;
}

const glowMatCache = new Map<string, THREE.MeshBasicMaterial>();
export function getGlowMat(hex: string, intensity = 1.25): THREE.MeshBasicMaterial {
  const key = `${hex}|${intensity}`;
  let m = glowMatCache.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color: hex });
    m.color.multiplyScalar(intensity);
    glowMatCache.set(key, m);
  }
  return m;
}

// ---------- Procedural Battlefield Terrain Map ----------

export function createBattlefieldTextures(): { map: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture } {
  const S = 1024;
  const [dc, dctx] = makeCanvas(S, S);
  const [bc, bctx] = makeCanvas(S, S);
  const noiseA = valueNoise2D(1337);
  const noiseB = valueNoise2D(7331);
  const rand = mulberry32(5519);

  const img = dctx.createImageData(S, S);
  const bimg = bctx.createImageData(S, S);
  const d = img.data;
  const b = bimg.data;

  // Compute natural worn dirt road factor between corners and center
  const roadDist = (wx: number, wy: number) => {
    const cx = MAP_W / 2,
      cy = MAP_H / 2;
    let best = 999;
    // Diagonal supply routes through center
    for (const s of SPAWNS) {
      const sx = s.x + 1.5,
        sy = s.y + 1.5;
      const dx = cx - sx,
        dy = cy - sy;
      const len2 = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, ((wx - sx) * dx + (wy - sy) * dy) / len2));
      const px = sx + dx * t,
        py = sy + dy * t;
      const dd = Math.hypot(wx - px, wy - py);
      if (dd < best) best = dd;
    }
    // Perimeter ring route
    const ringDist = Math.abs(Math.hypot(wx - cx, wy - cy) - 18);
    return Math.min(best, ringDist * 1.15);
  };

  for (let py = 0; py < S; py++) {
    const wy = (py / S) * MAP_H;
    for (let px = 0; px < S; px++) {
      const wx = (px / S) * MAP_W;
      const n1 = noiseA(wx * 0.14, wy * 0.14);
      const n2 = noiseB(wx * 0.42, wy * 0.42);
      const fine = (rand() - 0.5) * 14;

      // Biome blend: olive tactical meadow vs warm sandy earth vs slate rock
      const grassMix = Math.max(0, Math.min(1, (n1 - 0.34) * 2.4));
      let r = 82 + grassMix * -18 + n2 * 24;
      let g = 78 + grassMix * 12 + n2 * 22;
      let bl = 58 + grassMix * -8 + n2 * 14;

      // Worn convoy roads
      const rd = roadDist(wx, wy) + (n2 - 0.5) * 1.4;
      if (rd < 2.2) {
        const k = Math.max(0, 1 - rd / 2.2);
        const s = k * k * 0.65;
        r = r * (1 - s) + 114 * s;
        g = g * (1 - s) + 102 * s;
        bl = bl * (1 - s) + 82 * s;
      }

      // Flattened compacted gravel clearings at each spawn base
      for (const sp of SPAWNS) {
        const sd = Math.hypot(wx - (sp.x + 1.5), wy - (sp.y + 1.5));
        if (sd < 7.5) {
          const k = Math.max(0, 1 - sd / 7.5);
          const s = k * k * 0.55;
          r = r * (1 - s) + 92 * s;
          g = g * (1 - s) + 94 * s;
          bl = bl * (1 - s) + 90 * s;
        }
      }

      // Subtle tactical vignette near map border
      const edge = Math.min(wx, wy, MAP_W - wx, MAP_H - wy);
      const edgeDark = edge < 2.5 ? 0.72 + (edge / 2.5) * 0.28 : 1;

      const idx4 = (py * S + px) * 4;
      d[idx4] = Math.max(18, Math.min(220, (r + fine) * edgeDark));
      d[idx4 + 1] = Math.max(18, Math.min(220, (g + fine) * edgeDark));
      d[idx4 + 2] = Math.max(16, Math.min(220, (bl + fine) * edgeDark));
      d[idx4 + 3] = 255;

      const bv = Math.max(30, Math.min(230, 120 + (n2 - 0.5) * 90 + fine * 2.5));
      b[idx4] = b[idx4 + 1] = b[idx4 + 2] = bv;
      b[idx4 + 3] = 255;
    }
  }
  dctx.putImageData(img, 0, 0);
  bctx.putImageData(bimg, 0, 0);

  // Faint road track marks
  dctx.strokeStyle = "rgba(42, 36, 28, 0.14)";
  dctx.lineWidth = 3;
  dctx.setLineDash([12, 10]);
  for (const sp of SPAWNS) {
    dctx.beginPath();
    dctx.moveTo(((sp.x + 1.5) / MAP_W) * S, ((sp.y + 1.5) / MAP_H) * S);
    dctx.lineTo(S / 2, S / 2);
    dctx.stroke();
  }

  const map = new THREE.CanvasTexture(dc);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;

  const bumpMap = new THREE.CanvasTexture(bc);
  bumpMap.anisotropy = 4;

  return { map, bumpMap };
}
