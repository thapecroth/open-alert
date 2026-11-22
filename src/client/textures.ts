import * as THREE from "three";
import { MAP_W, MAP_H, SPAWNS, MapId, getMapLayout } from "../shared/gamedefs";

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

// ---------- Stratified Rock & Scorch Crater Textures ----------

let rockBumpTex: THREE.CanvasTexture | null = null;
let rockRoughTex: THREE.CanvasTexture | null = null;

function ensureRockDetail() {
  if (rockBumpTex && rockRoughTex) return;
  const S = 256;
  const [bc, bctx] = makeCanvas(S, S);
  const [rc, rctx] = makeCanvas(S, S);
  const noise = valueNoise2D(8821);
  const rand = mulberry32(6143);

  const bimg = bctx.createImageData(S, S);
  const rimg = rctx.createImageData(S, S);
  const bd = bimg.data;
  const rd = rimg.data;

  for (let py = 0; py < S; py++) {
    // Horizontal sedimentary strata bands
    const strata =
      Math.sin((py / S) * Math.PI * 10) * 0.35 +
      Math.sin((py / S) * Math.PI * 24 + 1.2) * 0.22 +
      Math.sin((py / S) * Math.PI * 5.0 + 0.5) * 0.25;
    for (let px = 0; px < S; px++) {
      const n = noise((px / S) * 10, (py / S) * 14);
      const crack = Math.abs(noise((px / S) * 22 + 4.1, (py / S) * 8 + 9.2) - 0.5);
      const fissure = crack < 0.045 ? -58 : 0;
      const grain = (rand() - 0.5) * 26;
      const bv = Math.max(15, Math.min(245, 128 + strata * 44 + (n - 0.5) * 76 + fissure + grain));
      const rv = Math.max(130, Math.min(245, 198 - strata * 16 + (rand() - 0.5) * 28));
      const idx = (py * S + px) * 4;
      bd[idx] = bd[idx + 1] = bd[idx + 2] = bv;
      bd[idx + 3] = 255;
      rd[idx] = rd[idx + 1] = rd[idx + 2] = rv;
      rd[idx + 3] = 255;
    }
  }
  bctx.putImageData(bimg, 0, 0);
  rctx.putImageData(rimg, 0, 0);

  rockBumpTex = new THREE.CanvasTexture(bc);
  rockBumpTex.wrapS = rockBumpTex.wrapT = THREE.RepeatWrapping;
  rockBumpTex.repeat.set(2, 2);
  rockRoughTex = new THREE.CanvasTexture(rc);
  rockRoughTex.wrapS = rockRoughTex.wrapT = THREE.RepeatWrapping;
  rockRoughTex.repeat.set(2, 2);
}

export interface CliffBiomeMats {
  wall: THREE.MeshStandardMaterial;
  cap: THREE.MeshStandardMaterial;
  boulder: THREE.MeshStandardMaterial;
  foliage: THREE.MeshStandardMaterial;
  trunk: THREE.MeshStandardMaterial;
  accent?: THREE.MeshStandardMaterial;
  water?: THREE.MeshStandardMaterial;
}

const cliffMatsCache = new Map<MapId, CliffBiomeMats>();

export function getCliffRockMaterials(mapId: MapId): CliffBiomeMats {
  const cached = cliffMatsCache.get(mapId);
  if (cached) return cached;
  ensureRockDetail();

  const palette: Record<
    MapId,
    {
      wall: number;
      cap: number;
      boulder: number;
      foliage: number;
      trunk: number;
      wallRough?: number;
      capRough?: number;
      wallMetal?: number;
      capMetal?: number;
      accent?: number;
      water?: number;
    }
  > = {
    crossroads: {
      wall: 0x4b4a45,
      cap: 0x7b7868,
      boulder: 0x5c5b55,
      foliage: 0x264b30,
      trunk: 0x4a3525,
    },
    canyon: {
      wall: 0x86442c,
      cap: 0xc2794e,
      boulder: 0x9b5538,
      foliage: 0x4b5c32,
      trunk: 0x573b28,
    },
    basin: {
      wall: 0x2f3640,
      cap: 0x55606d,
      boulder: 0x3e4752,
      foliage: 0x1e3c38,
      trunk: 0x362d28,
    },
    tundra: {
      // Ice-blue glacier cliffs, bright snow-frosted cap & dark arctic spruce
      wall: 0x5d8eb4,
      cap: 0xd6eaf8,
      boulder: 0x84aac7,
      foliage: 0x224642,
      trunk: 0x3d3028,
      wallRough: 0.44,
      capRough: 0.52,
      wallMetal: 0.16,
      capMetal: 0.1,
      accent: 0xe6f4ff,
    },
    fortress: {
      // Weathered ochre sandstone citadel walls with fortified dark stone parapet trim
      wall: 0x9c8056,
      cap: 0x4a4742,
      boulder: 0x876f4c,
      foliage: 0x566034,
      trunk: 0x5a402a,
      wallRough: 0.88,
      capRough: 0.78,
      capMetal: 0.12,
      accent: 0x3a3834,
    },
    jungle: {
      // Mossy dark basalt ridges & rich dense vibrant tropical canopies
      wall: 0x2a3c30,
      cap: 0x355c35,
      boulder: 0x344a39,
      foliage: 0x1e7d38,
      trunk: 0x4c321e,
      accent: 0x2ea048,
    },
    islands: {
      // Wet coastal slate river-gorge crags & shimmering blue-teal water surface
      wall: 0x284756,
      cap: 0x476874,
      boulder: 0x3a5460,
      foliage: 0x235c46,
      trunk: 0x47382c,
      wallRough: 0.56,
      capRough: 0.48,
      wallMetal: 0.14,
      water: 0x166d8c,
    },
    oasis: {
      // Terracotta Sahara rock spurs & vibrant palm-green oasis foliage
      wall: 0xa65836,
      cap: 0xd9a162,
      boulder: 0xb56d42,
      foliage: 0x2d8a3c,
      trunk: 0x6e4d30,
      accent: 0x3ba64a,
    },
  };
  const p = palette[mapId] ?? palette.crossroads;

  const mats: CliffBiomeMats = {
    wall: new THREE.MeshStandardMaterial({
      color: p.wall,
      bumpMap: rockBumpTex!,
      bumpScale: 0.14,
      roughnessMap: rockRoughTex!,
      roughness: p.wallRough ?? 0.92,
      metalness: p.wallMetal ?? 0.06,
    }),
    cap: new THREE.MeshStandardMaterial({
      color: p.cap,
      bumpMap: rockBumpTex!,
      bumpScale: 0.08,
      roughnessMap: rockRoughTex!,
      roughness: p.capRough ?? 0.88,
      metalness: p.capMetal ?? 0.05,
    }),
    boulder: new THREE.MeshStandardMaterial({
      color: p.boulder,
      bumpMap: rockBumpTex!,
      bumpScale: 0.12,
      roughness: p.wallRough ? Math.min(0.86, p.wallRough + 0.15) : 0.9,
      metalness: p.wallMetal ?? 0.08,
    }),
    foliage: new THREE.MeshStandardMaterial({
      color: p.foliage,
      roughness: 0.86,
      metalness: 0.03,
      flatShading: true,
    }),
    trunk: new THREE.MeshStandardMaterial({
      color: p.trunk,
      roughness: 0.94,
      metalness: 0.02,
    }),
    accent:
      p.accent !== undefined
        ? new THREE.MeshStandardMaterial({
            color: p.accent,
            roughness: mapId === "tundra" ? 0.45 : 0.78,
            metalness: mapId === "tundra" ? 0.12 : 0.08,
            flatShading: true,
          })
        : undefined,
    water:
      p.water !== undefined
        ? new THREE.MeshStandardMaterial({
            color: p.water,
            emissive: 0x0a384c,
            emissiveIntensity: 0.45,
            roughness: 0.22,
            metalness: 0.28,
            transparent: true,
            opacity: 0.9,
          })
        : undefined,
  };
  cliffMatsCache.set(mapId, mats);
  return mats;
}

let craterTexCache: THREE.CanvasTexture | null = null;
export function getCraterTexture(): THREE.CanvasTexture {
  if (craterTexCache) return craterTexCache;
  const S = 256;
  const [c, ctx] = makeCanvas(S, S);
  const rand = mulberry32(3197);
  const cx = S / 2;
  const cy = S / 2;

  ctx.clearRect(0, 0, S, S);

  // Soft outer soot halo
  const outer = ctx.createRadialGradient(cx, cy, S * 0.06, cx, cy, S * 0.48);
  outer.addColorStop(0, "rgba(8, 7, 7, 0.94)");
  outer.addColorStop(0.32, "rgba(18, 15, 13, 0.82)");
  outer.addColorStop(0.58, "rgba(38, 30, 24, 0.46)");
  outer.addColorStop(0.82, "rgba(28, 22, 18, 0.16)");
  outer.addColorStop(1, "rgba(15, 12, 10, 0)");
  ctx.fillStyle = outer;
  ctx.beginPath();
  ctx.arc(cx, cy, S * 0.48, 0, Math.PI * 2);
  ctx.fill();

  // Radial scorch streaks & blast rays
  for (let i = 0; i < 42; i++) {
    const ang = rand() * Math.PI * 2;
    const r0 = S * (0.08 + rand() * 0.1);
    const r1 = S * (0.28 + rand() * 0.2);
    ctx.strokeStyle = `rgba(12, 10, 9, ${0.18 + rand() * 0.34})`;
    ctx.lineWidth = 1.5 + rand() * 5.5;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
    ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
    ctx.stroke();
  }

  // Subtle warm ash / cracked rim ring
  const rim = ctx.createRadialGradient(cx, cy, S * 0.16, cx, cy, S * 0.32);
  rim.addColorStop(0, "rgba(85, 58, 36, 0)");
  rim.addColorStop(0.55, "rgba(72, 54, 40, 0.28)");
  rim.addColorStop(1, "rgba(40, 32, 26, 0)");
  ctx.fillStyle = rim;
  ctx.beginPath();
  ctx.arc(cx, cy, S * 0.34, 0, Math.PI * 2);
  ctx.fill();

  // Deep charred impact pit center
  const pit = ctx.createRadialGradient(cx, cy, 0, cx, cy, S * 0.22);
  pit.addColorStop(0, "rgba(4, 4, 4, 0.96)");
  pit.addColorStop(0.65, "rgba(14, 11, 10, 0.85)");
  pit.addColorStop(1, "rgba(20, 16, 14, 0)");
  ctx.fillStyle = pit;
  ctx.beginPath();
  ctx.arc(cx, cy, S * 0.22, 0, Math.PI * 2);
  ctx.fill();

  // Fine scorched speckles
  for (let i = 0; i < 240; i++) {
    const a = rand() * Math.PI * 2;
    const rad = Math.sqrt(rand()) * S * 0.44;
    const sz = 1 + rand() * 2.4;
    ctx.fillStyle = rand() > 0.25 ? "rgba(10, 9, 8, 0.45)" : "rgba(95, 76, 56, 0.25)";
    ctx.fillRect(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad, sz, sz);
  }

  craterTexCache = new THREE.CanvasTexture(c);
  craterTexCache.colorSpace = THREE.SRGBColorSpace;
  return craterTexCache;
}

// ---------- Procedural Battlefield Terrain Map ----------

interface BiomePalette {
  seedA: number;
  seedB: number;
  base: [number, number, number];
  altDelta: [number, number, number];
  noiseAmp: [number, number, number];
  road: [number, number, number];
  spawn: [number, number, number];
  cliff: [number, number, number];
  talus: [number, number, number];
  trackStroke: string;
}

const BIOMES: Record<MapId, BiomePalette> = {
  crossroads: {
    // Olive-ochre European steppe
    seedA: 1337,
    seedB: 7331,
    base: [84, 80, 56],
    altDelta: [-20, 14, -8],
    noiseAmp: [24, 22, 14],
    road: [118, 104, 80],
    spawn: [92, 94, 88],
    cliff: [56, 54, 50],
    talus: [68, 64, 54],
    trackStroke: "rgba(42, 36, 26, 0.15)",
  },
  canyon: {
    // Arid red-sandstone mesa theater
    seedA: 2459,
    seedB: 8417,
    base: [132, 84, 54],
    altDelta: [22, 16, 4],
    noiseAmp: [26, 18, 12],
    road: [158, 118, 82],
    spawn: [114, 96, 82],
    cliff: [92, 46, 32],
    talus: [112, 62, 42],
    trackStroke: "rgba(68, 34, 20, 0.16)",
  },
  basin: {
    // Dark alpine volcanic basin
    seedA: 3911,
    seedB: 9173,
    base: [58, 66, 68],
    altDelta: [-10, 12, 6],
    noiseAmp: [18, 20, 22],
    road: [84, 90, 94],
    spawn: [74, 80, 86],
    cliff: [36, 42, 49],
    talus: [48, 54, 60],
    trackStroke: "rgba(22, 28, 34, 0.18)",
  },
  tundra: {
    // Crisp Arctic snowfield with frosty blue-white drifts & glacial ice
    seedA: 4621,
    seedB: 8837,
    base: [192, 208, 222],
    altDelta: [-22, -10, 10],
    noiseAmp: [18, 18, 16],
    road: [148, 168, 186],
    spawn: [158, 174, 188],
    cliff: [94, 136, 172],
    talus: [136, 164, 188],
    trackStroke: "rgba(62, 86, 112, 0.2)",
  },
  fortress: {
    // Sun-baked ochre desert plateau with weathered sandstone & fortified dark stone
    seedA: 5113,
    seedB: 6329,
    base: [154, 126, 84],
    altDelta: [-18, -14, -10],
    noiseAmp: [22, 18, 12],
    road: [132, 114, 88],
    spawn: [110, 106, 98],
    cliff: [74, 66, 56],
    talus: [104, 92, 72],
    trackStroke: "rgba(56, 44, 30, 0.17)",
  },
  jungle: {
    // Deep lush emerald tropical valley floor with mossy dark basalt ridges
    seedA: 6427,
    seedB: 2909,
    base: [42, 84, 48],
    altDelta: [14, 26, -4],
    noiseAmp: [16, 24, 14],
    road: [98, 86, 60],
    spawn: [72, 86, 66],
    cliff: [32, 46, 36],
    talus: [42, 64, 44],
    trackStroke: "rgba(28, 24, 16, 0.2)",
  },
  islands: {
    // Deep blue-teal riverland terrain with coastal sandbars & wet slate chasms
    seedA: 7219,
    seedB: 4093,
    base: [60, 96, 88],
    altDelta: [26, 18, -4],
    noiseAmp: [18, 20, 18],
    road: [144, 130, 100],
    spawn: [96, 108, 106],
    cliff: [20, 74, 98],
    talus: [152, 138, 104],
    trackStroke: "rgba(38, 50, 48, 0.16)",
  },
  oasis: {
    // Warm golden Sahara sand dunes with terracotta rock spurs & palm-green oasis accents
    seedA: 8369,
    seedB: 3541,
    base: [184, 144, 84],
    altDelta: [20, 14, -8],
    noiseAmp: [22, 18, 12],
    road: [158, 120, 74],
    spawn: [142, 122, 92],
    cliff: [128, 72, 46],
    talus: [154, 104, 62],
    trackStroke: "rgba(84, 52, 26, 0.16)",
  },
};

export function createBattlefieldTextures(mapId: MapId = "crossroads"): {
  map: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
} {
  const S = 1024;
  const [dc, dctx] = makeCanvas(S, S);
  const [bc, bctx] = makeCanvas(S, S);
  const bio = BIOMES[mapId] ?? BIOMES.crossroads;
  const noiseA = valueNoise2D(bio.seedA);
  const noiseB = valueNoise2D(bio.seedB);
  const rand = mulberry32(5519 + bio.seedA);
  const layout = getMapLayout(mapId);

  // Precompute tile-level cliff mask and soft distance field (in tiles) for rocky cliff footprints
  const cliffGrid = new Uint8Array(MAP_W * MAP_H);
  for (const [cx, cy] of layout.cliffs) {
    if (cx >= 0 && cy >= 0 && cx < MAP_W && cy < MAP_H) cliffGrid[cy * MAP_W + cx] = 1;
  }

  const cliffNear = (wx: number, wy: number): { inside: boolean; dist: number } => {
    const tx = Math.floor(wx);
    const ty = Math.floor(wy);
    if (tx >= 0 && ty >= 0 && tx < MAP_W && ty < MAP_H && cliffGrid[ty * MAP_W + tx]) {
      return { inside: true, dist: 0 };
    }
    let minD = 99;
    const x0 = Math.max(0, tx - 2);
    const x1 = Math.min(MAP_W - 1, tx + 2);
    const y0 = Math.max(0, ty - 2);
    const y1 = Math.min(MAP_H - 1, ty + 2);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!cliffGrid[y * MAP_W + x]) continue;
        const dx = Math.max(x - wx, 0, wx - (x + 1));
        const dy = Math.max(y - wy, 0, wy - (y + 1));
        const dd = Math.hypot(dx, dy);
        if (dd < minD) minD = dd;
      }
    }
    return { inside: false, dist: minD };
  };

  const img = dctx.createImageData(S, S);
  const bimg = bctx.createImageData(S, S);
  const d = img.data;
  const b = bimg.data;

  // Compute natural worn convoy road factor between corners and center
  const roadDist = (wx: number, wy: number) => {
    const cx = MAP_W / 2,
      cy = MAP_H / 2;
    let best = 999;
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
    const ringDist = Math.abs(Math.hypot(wx - cx, wy - cy) - 18);
    return Math.min(best, ringDist * 1.15);
  };

  for (let py = 0; py < S; py++) {
    const wy = (py / S) * MAP_H;
    for (let px = 0; px < S; px++) {
      const wx = (px / S) * MAP_W;
      const n1 = noiseA(wx * 0.14, wy * 0.14);
      const n2 = noiseB(wx * 0.42, wy * 0.42);
      const n3 = noiseA(wx * 0.14 + 0.18, wy * 0.14 + 0.18);
      const slopeShade = 1 + (n1 - n3) * 0.32;
      const fine = (rand() - 0.5) * 14;

      const altMix = Math.max(0, Math.min(1, (n1 - 0.34) * 2.4));
      let r = bio.base[0] + altMix * bio.altDelta[0] + n2 * bio.noiseAmp[0];
      let g = bio.base[1] + altMix * bio.altDelta[1] + n2 * bio.noiseAmp[1];
      let bl = bio.base[2] + altMix * bio.altDelta[2] + n2 * bio.noiseAmp[2];
      let bumpExtra = 0;

      // Worn convoy roads
      const rd = roadDist(wx, wy) + (n2 - 0.5) * 1.4;
      if (rd < 2.2) {
        const k = Math.max(0, 1 - rd / 2.2);
        const s = k * k * 0.62;
        r = r * (1 - s) + bio.road[0] * s;
        g = g * (1 - s) + bio.road[1] * s;
        bl = bl * (1 - s) + bio.road[2] * s;
      }

      // Flattened compacted gravel clearings at each spawn base
      for (const sp of SPAWNS) {
        const sd = Math.hypot(wx - (sp.x + 1.5), wy - (sp.y + 1.5));
        if (sd < 7.5) {
          const k = Math.max(0, 1 - sd / 7.5);
          const s = k * k * 0.52;
          r = r * (1 - s) + bio.spawn[0] * s;
          g = g * (1 - s) + bio.spawn[1] * s;
          bl = bl * (1 - s) + bio.spawn[2] * s;
        }
      }

      // Industrial oil-stained pads around Oil Derricks
      for (const [dx, dy] of layout.derricks) {
        const dd = Math.hypot(wx - (dx + 1), wy - (dy + 1));
        if (dd < 2.6) {
          const k = Math.max(0, 1 - dd / 2.6);
          const s = k * k * 0.58;
          r = r * (1 - s) + 54 * s;
          g = g * (1 - s) + 56 * s;
          bl = bl * (1 - s) + 58 * s;
        }
      }

      // Lush palm-green oasis basins around flanking ore pools on Sahara Oasis map
      if (mapId === "oasis" && layout.extraOre) {
        for (const [ox, oy, orad] of layout.extraOre) {
          const od = Math.hypot(wx - ox, wy - oy);
          const span = orad + 3.2;
          if (od < span) {
            const k = Math.max(0, 1 - od / span);
            const s = k * k * 0.65;
            r = r * (1 - s) + 64 * s;
            g = g * (1 - s) + 128 * s;
            bl = bl * (1 - s) + 68 * s;
          }
        }
      }

      // Map-specific rocky cliff footprints + dark ambient-occlusion scree apron
      const cf = cliffNear(wx, wy);
      if (cf.inside) {
        const strata = Math.sin((wx * 1.6 + wy * 1.2 + n2 * 2.5) * 2.4) * 10;
        r = bio.cliff[0] + strata;
        g = bio.cliff[1] + strata * 0.9;
        bl = bio.cliff[2] + strata * 0.85;
        bumpExtra = mapId === "islands" ? -28 : 55;
      } else if (cf.dist < (mapId === "islands" ? 2.1 : 1.5)) {
        const range = mapId === "islands" ? 2.1 : 1.5;
        const k = Math.max(0, 1 - cf.dist / range);
        const scree = k * k * (mapId === "islands" ? 0.82 : 0.72);
        const ao = 1 - k * k * (mapId === "islands" ? 0.14 : 0.34);
        r = (r * (1 - scree) + bio.talus[0] * scree) * ao;
        g = (g * (1 - scree) + bio.talus[1] * scree) * ao;
        bl = (bl * (1 - scree) + bio.talus[2] * scree) * ao;
        bumpExtra = mapId === "islands" ? -k * 12 : k * 34;
      }

      // Subtle tactical vignette near map border
      const edge = Math.min(wx, wy, MAP_W - wx, MAP_H - wy);
      const edgeDark = edge < 2.5 ? 0.72 + (edge / 2.5) * 0.28 : 1;
      const maxC = mapId === "tundra" ? 238 : 225;

      const idx4 = (py * S + px) * 4;
      d[idx4] = Math.max(16, Math.min(maxC, (r * slopeShade + fine) * edgeDark));
      d[idx4 + 1] = Math.max(16, Math.min(maxC, (g * slopeShade + fine) * edgeDark));
      d[idx4 + 2] = Math.max(14, Math.min(maxC, (bl * slopeShade + fine) * edgeDark));
      d[idx4 + 3] = 255;

      const bv = Math.max(25, Math.min(238, 120 + (n2 - 0.5) * 92 + bumpExtra + fine * 2.5));
      b[idx4] = b[idx4 + 1] = b[idx4 + 2] = bv;
      b[idx4 + 3] = 255;
    }
  }
  dctx.putImageData(img, 0, 0);
  bctx.putImageData(bimg, 0, 0);

  // Faint road track marks
  dctx.strokeStyle = bio.trackStroke;
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
