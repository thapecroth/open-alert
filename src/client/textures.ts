import * as THREE from "three";
import { MapId, getMapLayout, getSpawns } from "../shared/gamedefs";

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

// Compute a crisp OpenGL tangent-space normal map from a normalized [0..1] heightfield via 3x3 Sobel gradient
function heightBufferToNormalCanvas(
  heights: Float32Array,
  w: number,
  h: number,
  strength: number,
  tileable = true,
): HTMLCanvasElement {
  const [nc, nctx] = makeCanvas(w, h);
  const nimg = nctx.createImageData(w, h);
  const nd = nimg.data;

  const sample = (x: number, y: number): number => {
    const sx = tileable ? ((x % w) + w) % w : Math.max(0, Math.min(w - 1, x));
    const sy = tileable ? ((y % h) + h) % h : Math.max(0, Math.min(h - 1, y));
    return heights[sy * w + sx];
  };

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const tl = sample(px - 1, py - 1);
      const t = sample(px, py - 1);
      const tr = sample(px + 1, py - 1);
      const l = sample(px - 1, py);
      const r = sample(px + 1, py);
      const bl = sample(px - 1, py + 1);
      const b = sample(px, py + 1);
      const br = sample(px + 1, py + 1);

      const dx = tr + 2 * r + br - (tl + 2 * l + bl);
      const dy = bl + 2 * b + br - (tl + 2 * t + tr);

      // CanvasTexture flipY=true maps +px -> +U (+T) and -py -> +V (+B)
      let nx = -dx * strength;
      let ny = dy * strength;
      let nz = 1.0;
      const invLen = 1 / Math.hypot(nx, ny, nz);
      nx *= invLen;
      ny *= invLen;
      nz *= invLen;

      const idx = (py * w + px) * 4;
      nd[idx] = Math.max(0, Math.min(255, Math.round((nx * 0.5 + 0.5) * 255)));
      nd[idx + 1] = Math.max(0, Math.min(255, Math.round((ny * 0.5 + 0.5) * 255)));
      nd[idx + 2] = Math.max(0, Math.min(255, Math.round((nz * 0.5 + 0.5) * 255)));
      nd[idx + 3] = 255;
    }
  }
  nctx.putImageData(nimg, 0, 0);
  return nc;
}

function canvasToNormalCanvas(src: HTMLCanvasElement, strength: number, tileable = true): HTMLCanvasElement {
  const w = src.width;
  const h = src.height;
  const ctx = src.getContext("2d")!;
  const data = ctx.getImageData(0, 0, w, h).data;
  const heights = new Float32Array(w * h);
  for (let i = 0; i < heights.length; i++) {
    heights[i] = data[i * 4] / 255;
  }
  return heightBufferToNormalCanvas(heights, w, h, strength, tileable);
}

// ---------- Shared 512x512 Next-Gen PBR Armor Detail Maps ----------

let armorNormalTex: THREE.CanvasTexture | null = null;
let armorRoughTex: THREE.CanvasTexture | null = null;
let armorDetailTex: THREE.CanvasTexture | null = null;
let concreteDiffTex: THREE.CanvasTexture | null = null;
let concreteNormalTex: THREE.CanvasTexture | null = null;
let concreteRoughTex: THREE.CanvasTexture | null = null;
let treadTex: THREE.CanvasTexture | null = null;
let treadNormalTex: THREE.CanvasTexture | null = null;

function ensureArmorDetail() {
  if (armorNormalTex && armorRoughTex && armorDetailTex) return;
  const S = 512;
  const [hc, hctx] = makeCanvas(S, S);
  const [rc, rctx] = makeCanvas(S, S);
  const [ac, actx] = makeCanvas(S, S);
  const rand = mulberry32(4201);

  // Neutral mid-height plate, balanced satin-matte roughness (~0.88 multiplier), near-white subtle AO map
  hctx.fillStyle = "#888888";
  hctx.fillRect(0, 0, S, S);
  rctx.fillStyle = "#dedede";
  rctx.fillRect(0, 0, S, S);
  actx.fillStyle = "#f4f4f4";
  actx.fillRect(0, 0, S, S);

  // Fine brushed titanium / composite directional micro-grain
  for (let i = 0; i < 2800; i++) {
    const x = rand() * S;
    const y = rand() * S;
    const len = 14 + rand() * 58;
    const hv = 128 + ((rand() - 0.5) * 20) | 0;
    hctx.fillStyle = `rgb(${hv},${hv},${hv})`;
    hctx.fillRect(x, y, len, 1);

    const rv = 212 + ((rand() - 0.5) * 38) | 0;
    rctx.fillStyle = `rgb(${rv},${rv},${rv})`;
    rctx.fillRect(x, y, len, 1.4);

    const av = 240 + ((rand() - 0.5) * 18) | 0;
    actx.fillStyle = `rgb(${av},${av},${av})`;
    actx.fillRect(x, y, len, 1.2);
  }

  // Subtle composite surface mottle patches for organic weathering
  for (let i = 0; i < 70; i++) {
    const cx = rand() * S;
    const cy = rand() * S;
    const rad = 18 + rand() * 54;
    const darker = rand() > 0.45;
    const g = rctx.createRadialGradient(cx, cy, 2, cx, cy, rad);
    g.addColorStop(0, darker ? "rgba(255,255,255,0.12)" : "rgba(155,155,155,0.12)");
    g.addColorStop(1, "rgba(220,220,220,0)");
    rctx.fillStyle = g;
    rctx.beginPath();
    rctx.arc(cx, cy, rad, 0, Math.PI * 2);
    rctx.fill();

    const ag = actx.createRadialGradient(cx, cy, 2, cx, cy, rad);
    ag.addColorStop(0, darker ? "rgba(210,210,210,0.14)" : "rgba(255,255,255,0.08)");
    ag.addColorStop(1, "rgba(244,244,244,0)");
    actx.fillStyle = ag;
    actx.beginPath();
    actx.arc(cx, cy, rad, 0, Math.PI * 2);
    actx.fill();
  }

  // Precision beveled hull armor plates (2x2 main layout + recessed tactical inspection hatch)
  const panels: [number, number, number, number, boolean][] = [
    [0, 0, 256, 256, true],
    [256, 0, 256, 256, true],
    [0, 256, 256, 256, true],
    [256, 256, 256, 256, true],
    [32, 32, 116, 84, false], // Recessed maintenance hatch on upper-left plate
  ];

  for (const [px, py, pw, ph, withRivets] of panels) {
    // Soft outer AO halo along panel seam
    actx.strokeStyle = "rgba(110, 110, 110, 0.32)";
    actx.lineWidth = 10;
    actx.strokeRect(px + 2, py + 2, pw - 4, ph - 4);

    // Wide beveled shoulder (smooth height ramp so Sobel generates gleaming 45-deg edge highlights)
    hctx.strokeStyle = "#b4b4b4";
    hctx.lineWidth = 9;
    hctx.strokeRect(px + 6, py + 6, pw - 12, ph - 12);

    hctx.strokeStyle = "#d2d2d2";
    hctx.lineWidth = 3;
    hctx.strokeRect(px + 9, py + 9, pw - 18, ph - 18);

    // Crisp recessed dark panel seam groove
    hctx.strokeStyle = "#262626";
    hctx.lineWidth = 4;
    hctx.strokeRect(px + 2, py + 2, pw - 4, ph - 4);

    // AO darkening directly inside seam + subtle metallic edge highlight along bevel lip
    actx.strokeStyle = "#8a8a8a";
    actx.lineWidth = 3.5;
    actx.strokeRect(px + 2, py + 2, pw - 4, ph - 4);
    actx.strokeStyle = "rgba(255, 255, 255, 0.55)";
    actx.lineWidth = 1.5;
    actx.strokeRect(px + 7, py + 7, pw - 14, ph - 14);

    // Roughness variation: rougher grime in recessed seam, sleeker burnished metal along beveled edge
    rctx.strokeStyle = "#fafafa";
    rctx.lineWidth = 5;
    rctx.strokeRect(px + 2, py + 2, pw - 4, ph - 4);
    rctx.strokeStyle = "#9e9e9e";
    rctx.lineWidth = 4;
    rctx.strokeRect(px + 8, py + 8, pw - 16, ph - 16);

    // Precision recessed hex fasteners / rivets around main armor plates
    if (withRivets) {
      const inset = 22;
      const fasteners: [number, number][] = [
        [px + inset, py + inset],
        [px + pw - inset, py + inset],
        [px + inset, py + ph - inset],
        [px + pw - inset, py + ph - inset],
        [px + pw * 0.5, py + inset],
        [px + pw * 0.5, py + ph - inset],
        [px + inset, py + ph * 0.5],
        [px + pw - inset, py + ph * 0.5],
      ];
      for (const [rx, ry] of fasteners) {
        // Countersunk collar recess
        hctx.fillStyle = "#484848";
        hctx.beginPath();
        hctx.arc(rx, ry, 5.4, 0, Math.PI * 2);
        hctx.fill();

        // Raised domed bolt head
        const rg = hctx.createRadialGradient(rx - 0.8, ry - 0.8, 0.4, rx, ry, 3.8);
        rg.addColorStop(0, "#ededed");
        rg.addColorStop(0.65, "#bcbcbc");
        rg.addColorStop(1, "#666666");
        hctx.fillStyle = rg;
        hctx.beginPath();
        hctx.arc(rx, ry, 3.8, 0, Math.PI * 2);
        hctx.fill();

        // Subtle dark AO ring around fastener + metallic specular dot
        actx.strokeStyle = "rgba(115, 115, 115, 0.58)";
        actx.lineWidth = 1.8;
        actx.beginPath();
        actx.arc(rx, ry, 5.1, 0, Math.PI * 2);
        actx.stroke();

        rctx.fillStyle = "#989898";
        rctx.beginPath();
        rctx.arc(rx, ry, 3.6, 0, Math.PI * 2);
        rctx.fill();
      }
    }
  }

  // Recessed armored radiator louver grille on lower-right plate
  const gx = 296;
  const gy = 304;
  const gw = 176;
  const gh = 160;
  hctx.fillStyle = "#4c4c4c";
  hctx.fillRect(gx - 6, gy - 6, gw + 12, gh + 12);
  actx.fillStyle = "#bcbcbc";
  actx.fillRect(gx - 4, gy - 4, gw + 8, gh + 8);
  rctx.fillStyle = "#f5f5f5";
  rctx.fillRect(gx - 4, gy - 4, gw + 8, gh + 8);

  for (let sy = gy + 6; sy < gy + gh - 8; sy += 16) {
    // Deep recessed slot
    hctx.fillStyle = "#1c1c1c";
    hctx.fillRect(gx + 6, sy, gw - 12, 6);
    // Angled metal slat lip
    hctx.fillStyle = "#d0d0d0";
    hctx.fillRect(gx + 6, sy + 6, gw - 12, 5);
    actx.fillStyle = "#727272";
    actx.fillRect(gx + 6, sy, gw - 12, 6);
    actx.fillStyle = "#f2f2f2";
    actx.fillRect(gx + 6, sy + 6, gw - 12, 4);
    rctx.fillStyle = "#aeaeae";
    rctx.fillRect(gx + 6, sy + 6, gw - 12, 5);
  }

  // Tactical surface micro-scratches (catch sharp specular highlights along wear lines)
  for (let i = 0; i < 110; i++) {
    const sx = rand() * S;
    const sy = rand() * S;
    const ang = (rand() - 0.5) * 0.9 + (rand() > 0.5 ? 0 : Math.PI * 0.5);
    const len = 10 + rand() * 44;
    const ex = sx + Math.cos(ang) * len;
    const ey = sy + Math.sin(ang) * len;

    hctx.strokeStyle = rand() > 0.35 ? "rgba(70,70,70,0.55)" : "rgba(215,215,215,0.4)";
    hctx.lineWidth = 0.8 + rand() * 0.9;
    hctx.beginPath();
    hctx.moveTo(sx, sy);
    hctx.lineTo(ex, ey);
    hctx.stroke();

    // Scratches expose shinier bare alloy beneath paint
    rctx.strokeStyle = "rgba(118,118,118,0.55)";
    rctx.lineWidth = 1.0 + rand() * 0.8;
    rctx.beginPath();
    rctx.moveTo(sx, sy);
    rctx.lineTo(ex, ey);
    rctx.stroke();

    actx.strokeStyle = "rgba(255,255,255,0.28)";
    actx.lineWidth = 0.9;
    actx.beginPath();
    actx.moveTo(sx, sy);
    actx.lineTo(ex, ey);
    actx.stroke();
  }

  const normalCanvas = canvasToNormalCanvas(hc, 1.45, true);
  armorNormalTex = new THREE.CanvasTexture(normalCanvas);
  armorNormalTex.wrapS = armorNormalTex.wrapT = THREE.RepeatWrapping;
  armorNormalTex.anisotropy = 4;

  armorRoughTex = new THREE.CanvasTexture(rc);
  armorRoughTex.wrapS = armorRoughTex.wrapT = THREE.RepeatWrapping;
  armorRoughTex.anisotropy = 4;

  armorDetailTex = new THREE.CanvasTexture(ac);
  armorDetailTex.colorSpace = THREE.SRGBColorSpace;
  armorDetailTex.wrapS = armorDetailTex.wrapT = THREE.RepeatWrapping;
  armorDetailTex.anisotropy = 4;
}

function ensureConcrete() {
  if (concreteDiffTex && concreteNormalTex && concreteRoughTex) return;
  const S = 512;
  const [dc, dctx] = makeCanvas(S, S);
  const [hc, hctx] = makeCanvas(S, S);
  const [rc, rctx] = makeCanvas(S, S);
  const rand = mulberry32(9012);

  dctx.fillStyle = "#52595f";
  dctx.fillRect(0, 0, S, S);
  hctx.fillStyle = "#808080";
  hctx.fillRect(0, 0, S, S);
  rctx.fillStyle = "#d8d8d8";
  rctx.fillRect(0, 0, S, S);

  // Crisp concrete aggregate speckles & surface pitting
  for (let i = 0; i < 8500; i++) {
    const x = rand() * S;
    const y = rand() * S;
    const s = 1 + rand() * 3.2;
    const delta = ((rand() - 0.5) * 34) | 0;
    const r = Math.max(46, Math.min(132, 82 + delta));
    const g = Math.max(50, Math.min(138, 89 + delta));
    const b = Math.max(54, Math.min(144, 95 + delta));
    dctx.fillStyle = `rgb(${r},${g},${b})`;
    dctx.fillRect(x, y, s, s);
    const hv = Math.max(42, Math.min(212, 128 + delta * 2.1));
    hctx.fillStyle = `rgb(${hv},${hv},${hv})`;
    hctx.fillRect(x, y, s, s);
    const rv = Math.max(170, Math.min(252, 220 - delta));
    rctx.fillStyle = `rgb(${rv},${rv},${rv})`;
    rctx.fillRect(x, y, s, s);
  }

  // Subtle oil & tire weathering marks
  for (let i = 0; i < 24; i++) {
    const cx = rand() * S;
    const cy = rand() * S;
    const rad = 18 + rand() * 52;
    const g = dctx.createRadialGradient(cx, cy, 2, cx, cy, rad);
    g.addColorStop(0, "rgba(32, 36, 40, 0.22)");
    g.addColorStop(1, "rgba(32, 36, 40, 0)");
    dctx.fillStyle = g;
    dctx.beginPath();
    dctx.arc(cx, cy, rad, 0, Math.PI * 2);
    dctx.fill();
  }

  // Deep concrete expansion joints
  dctx.strokeStyle = "#292e33";
  dctx.lineWidth = 5;
  dctx.strokeRect(8, 8, S - 16, S - 16);
  dctx.beginPath();
  dctx.moveTo(S / 2, 8);
  dctx.lineTo(S / 2, S - 8);
  dctx.moveTo(8, S / 2);
  dctx.lineTo(S - 8, S / 2);
  dctx.stroke();

  hctx.strokeStyle = "#282828";
  hctx.lineWidth = 6;
  hctx.strokeRect(8, 8, S - 16, S - 16);
  hctx.beginPath();
  hctx.moveTo(S / 2, 8);
  hctx.lineTo(S / 2, S - 8);
  hctx.moveTo(8, S / 2);
  hctx.lineTo(S - 8, S / 2);
  hctx.stroke();

  // Industrial hazard trim strips along the perimeter edge
  dctx.save();
  dctx.beginPath();
  dctx.rect(12, 12, S - 24, 22);
  dctx.rect(12, S - 34, S - 24, 22);
  dctx.clip();
  dctx.fillStyle = "#222529";
  dctx.fillRect(0, 0, S, S);
  dctx.fillStyle = "#cf9b26";
  for (let x = -S; x < S * 2; x += 44) {
    dctx.beginPath();
    dctx.moveTo(x, 0);
    dctx.lineTo(x + 22, 0);
    dctx.lineTo(x - 20, S);
    dctx.lineTo(x - 42, S);
    dctx.closePath();
    dctx.fill();
  }
  dctx.restore();

  concreteDiffTex = new THREE.CanvasTexture(dc);
  concreteDiffTex.colorSpace = THREE.SRGBColorSpace;
  concreteDiffTex.anisotropy = 4;

  concreteNormalTex = new THREE.CanvasTexture(canvasToNormalCanvas(hc, 1.35, true));
  concreteNormalTex.anisotropy = 4;

  concreteRoughTex = new THREE.CanvasTexture(rc);
  concreteRoughTex.anisotropy = 4;
}

export function getTreadTexture(): THREE.CanvasTexture {
  if (treadTex) return treadTex;
  const [c, ctx] = makeCanvas(128, 256);
  const [hc, hctx] = makeCanvas(128, 256);
  ctx.fillStyle = "#181c20";
  ctx.fillRect(0, 0, 128, 256);
  hctx.fillStyle = "#303030";
  hctx.fillRect(0, 0, 128, 256);

  for (let y = 0; y < 256; y += 32) {
    // Raised armored track grouser pads
    ctx.fillStyle = "#32383f";
    ctx.fillRect(8, y + 4, 112, 18);
    ctx.fillStyle = "#48505a";
    ctx.fillRect(10, y + 5, 108, 4);
    ctx.fillStyle = "#101316";
    ctx.fillRect(54, y + 4, 20, 18);

    hctx.fillStyle = "#d8d8d8";
    hctx.fillRect(8, y + 4, 112, 18);
    hctx.fillStyle = "#424242";
    hctx.fillRect(54, y + 4, 20, 18);
  }
  treadTex = new THREE.CanvasTexture(c);
  treadTex.colorSpace = THREE.SRGBColorSpace;
  treadTex.wrapS = treadTex.wrapT = THREE.RepeatWrapping;
  treadTex.repeat.set(1, 3);
  treadTex.anisotropy = 4;

  treadNormalTex = new THREE.CanvasTexture(canvasToNormalCanvas(hc, 1.8, true));
  treadNormalTex.wrapS = treadNormalTex.wrapT = THREE.RepeatWrapping;
  treadNormalTex.repeat.set(1, 3);
  return treadTex;
}

// ---------- Next-Gen 2026 PBR Material Caches ----------

const chassisMatCache = new Map<string, THREE.MeshStandardMaterial>();
export function getChassisMat(hex = "#3d4752", roughness = 0.44, metalness = 0.62): THREE.MeshStandardMaterial {
  ensureArmorDetail();
  const key = `${hex}|${roughness}|${metalness}`;
  let m = chassisMatCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(hex),
      map: armorDetailTex!,
      normalMap: armorNormalTex!,
      normalScale: new THREE.Vector2(0.88, 0.88),
      roughnessMap: armorRoughTex!,
      roughness,
      metalness,
      envMapIntensity: 1.12,
    });
    chassisMatCache.set(key, m);
  }
  return m;
}

const accentMatCache = new Map<string, THREE.MeshStandardMaterial>();
export function getAccentMat(hex: string): THREE.MeshStandardMaterial {
  ensureArmorDetail();
  let m = accentMatCache.get(hex);
  if (!m) {
    const c = new THREE.Color(hex);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    // Deepen & refine faction hue by ~14% toward rich tactical military composite paint
    hsl.s = Math.max(0, Math.min(1, hsl.s * 0.86));
    hsl.l = hsl.l > 0.4 ? hsl.l * 0.91 : hsl.l * 0.96;
    c.setHSL(hsl.h, hsl.s, hsl.l);

    m = new THREE.MeshStandardMaterial({
      color: c,
      map: armorDetailTex!,
      normalMap: armorNormalTex!,
      normalScale: new THREE.Vector2(0.76, 0.76),
      roughnessMap: armorRoughTex!,
      metalness: 0.38,
      roughness: 0.42,
      envMapIntensity: 1.05,
    });
    accentMatCache.set(hex, m);
  }
  return m;
}

const glassMatCache = new Map<string, THREE.MeshStandardMaterial>();
export function getGlassMat(tint = "#66d4ff"): THREE.MeshStandardMaterial {
  let m = glassMatCache.get(tint);
  if (!m) {
    const c = new THREE.Color(tint);
    m = new THREE.MeshStandardMaterial({
      color: c,
      roughness: 0.1,
      metalness: 0.85,
      emissive: c.clone().multiplyScalar(0.28),
      envMapIntensity: 1.45,
    });
    glassMatCache.set(tint, m);
  }
  return m;
}

let contactShadowTexCache: THREE.CanvasTexture | null = null;
export function getContactShadowTex(): THREE.CanvasTexture {
  if (contactShadowTexCache) return contactShadowTexCache;
  const S = 128;
  const [c, ctx] = makeCanvas(S, S);
  const cx = S / 2;
  const cy = S / 2;
  ctx.clearRect(0, 0, S, S);

  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, S * 0.5);
  grad.addColorStop(0.0, "rgba(4, 8, 12, 0.58)");
  grad.addColorStop(0.36, "rgba(4, 8, 12, 0.44)");
  grad.addColorStop(0.66, "rgba(4, 8, 12, 0.2)");
  grad.addColorStop(0.86, "rgba(4, 8, 12, 0.05)");
  grad.addColorStop(1.0, "rgba(4, 8, 12, 0)");

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, S, S);

  contactShadowTexCache = new THREE.CanvasTexture(c);
  contactShadowTexCache.colorSpace = THREE.SRGBColorSpace;
  return contactShadowTexCache;
}

// ---------- Legacy-Compatible Shared Material Caches (Upgraded to Tangent-Space Normals) ----------

const armorMatCache = new Map<string, THREE.MeshStandardMaterial>();
export function getArmorMat(hex: string, metalness = 0.45, roughness = 0.56, emissive = 0): THREE.MeshStandardMaterial {
  ensureArmorDetail();
  const key = `${hex}|${metalness}|${roughness}|${emissive}`;
  let m = armorMatCache.get(key);
  if (!m) {
    const c = new THREE.Color(hex);
    m = new THREE.MeshStandardMaterial({
      color: c,
      map: armorDetailTex!,
      metalness,
      roughness,
      normalMap: armorNormalTex!,
      normalScale: new THREE.Vector2(0.75, 0.75),
      roughnessMap: armorRoughTex!,
      emissive: emissive > 0 ? c.clone().multiplyScalar(emissive) : new THREE.Color(0x000000),
      envMapIntensity: 1.05,
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
      normalMap: concreteNormalTex!,
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughnessMap: concreteRoughTex!,
      roughness: 0.88,
      metalness: 0.08,
      envMapIntensity: 0.65,
    });
  }
  return concreteMatCache;
}

let treadMatCache: THREE.MeshStandardMaterial | null = null;
export function getTreadMat(): THREE.MeshStandardMaterial {
  if (!treadMatCache) {
    const map = getTreadTexture();
    treadMatCache = new THREE.MeshStandardMaterial({
      map,
      normalMap: treadNormalTex!,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughness: 0.82,
      metalness: 0.28,
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

let rockNormalTex: THREE.CanvasTexture | null = null;
let rockRoughTex: THREE.CanvasTexture | null = null;

function ensureRockDetail() {
  if (rockNormalTex && rockRoughTex) return;
  const S = 256;
  const [rc, rctx] = makeCanvas(S, S);
  const noise = valueNoise2D(8821);
  const rand = mulberry32(6143);

  const heights = new Float32Array(S * S);
  const rimg = rctx.createImageData(S, S);
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
      const fissure = crack < 0.045 ? -0.24 : 0;
      const grain = (rand() - 0.5) * 0.09;
      const h = Math.max(0.05, Math.min(0.96, 0.5 + strata * 0.18 + (n - 0.5) * 0.32 + fissure + grain));
      heights[py * S + px] = h;

      const rv = Math.max(130, Math.min(248, 202 - strata * 16 + (rand() - 0.5) * 28));
      const idx = (py * S + px) * 4;
      rd[idx] = rd[idx + 1] = rd[idx + 2] = rv;
      rd[idx + 3] = 255;
    }
  }
  rctx.putImageData(rimg, 0, 0);

  rockNormalTex = new THREE.CanvasTexture(heightBufferToNormalCanvas(heights, S, S, 2.2, true));
  rockNormalTex.wrapS = rockNormalTex.wrapT = THREE.RepeatWrapping;
  rockNormalTex.repeat.set(2, 2);
  rockNormalTex.anisotropy = 4;

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
    fulda_gap: {
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
      wallRough: 0.42,
      capRough: 0.5,
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
    archipelago: {
      // Pacific Atoll: dark volcanic basalt crags, tropical emerald palms & turquoise ocean
      wall: 0x2d3238,
      cap: 0x455348,
      boulder: 0x3c4347,
      foliage: 0x24943e,
      trunk: 0x6b4c30,
      wallRough: 0.84,
      capRough: 0.78,
      wallMetal: 0.08,
      accent: 0x38ba54,
      water: 0x16a8b8,
    },
    coastline: {
      // Storm Coast: rugged wet granite sea-cliffs, stormy spruce & slate-blue North Sea
      wall: 0x37444f,
      cap: 0x52636b,
      boulder: 0x46545e,
      foliage: 0x1f4d3a,
      trunk: 0x3f332a,
      wallRough: 0.66,
      capRough: 0.62,
      wallMetal: 0.14,
      water: 0x154768,
    },
    atlantis: {
      // Mythic Sea: teal coral stone pylons, pale marble-gold ancient temple caps & luminous turquoise reef
      wall: 0x3c8492,
      cap: 0xe0d6bc,
      boulder: 0x4c8a90,
      foliage: 0x1fa67a,
      trunk: 0x7c745e,
      wallRough: 0.48,
      capRough: 0.36,
      wallMetal: 0.16,
      capMetal: 0.24,
      accent: 0xe4be58,
      water: 0x18c4d6,
    },
    shipwreck: {
      // Abyssal: wet dark granite reefs, weathered kelp-slate caps & deep stormy teal-slate ocean
      wall: 0x26353e,
      cap: 0x3b4d52,
      boulder: 0x31414a,
      foliage: 0x1a463a,
      trunk: 0x362d26,
      wallRough: 0.5,
      capRough: 0.56,
      wallMetal: 0.2,
      water: 0x114256,
    },
    volcano: {
      // Volcanic: charcoal-basalt obsidian spires with glowing molten orange-amber caldera fissures
      wall: 0x242022,
      cap: 0x3a3234,
      boulder: 0x2d2729,
      foliage: 0x3e2a20,
      trunk: 0x261d1a,
      wallRough: 0.62,
      capRough: 0.72,
      wallMetal: 0.24,
      capMetal: 0.14,
      accent: 0xff5a14,
      water: 0x1a3e50,
    },
    oilrig: {
      // Deep Sea: riveted industrial steel offshore bulkheads, concrete decks & yellow safety accents
      wall: 0x3c4854,
      cap: 0x5c6670,
      boulder: 0x46525c,
      foliage: 0x2c6c56,
      trunk: 0x4e4238,
      wallRough: 0.44,
      capRough: 0.52,
      wallMetal: 0.64,
      capMetal: 0.42,
      accent: 0xe4ae24,
      water: 0x104478,
    },
    cybergrid: {
      // Orbital: sleek dark carbon-titanium monolith walls with luminous cyan energy inlays
      wall: 0x1c2432,
      cap: 0x2d3a4e,
      boulder: 0x232f40,
      foliage: 0x20d8ff,
      trunk: 0x1a222e,
      wallRough: 0.28,
      capRough: 0.24,
      wallMetal: 0.82,
      capMetal: 0.86,
      accent: 0x28ecff,
    },
    hormuz: {
      // Gulf Strait: sun-bleached arid coastal bluffs, salt-crusted rocks & deep teal Persian Gulf water
      wall: 0x8a7a5c,
      cap: 0xa89a74,
      boulder: 0x7a6c52,
      foliage: 0x4a7a44,
      trunk: 0x5c4630,
      wallRough: 0.88,
      capRough: 0.82,
      wallMetal: 0.06,
      accent: 0xd8b56a,
      water: 0x0e5e78,
    },
    delta: {
      // River Delta: lush jungle mangrove bluffs, wet dark mud & warm green-brown waterways
      wall: 0x3a5a3a,
      cap: 0x54704c,
      boulder: 0x2e4a34,
      foliage: 0x1e7a38,
      trunk: 0x4a3826,
      wallRough: 0.86,
      capRough: 0.8,
      wallMetal: 0.06,
      accent: 0x5aa84c,
      water: 0x1e6a52,
    },
    bering: {
      // Polar Strait: sea-ice floes, frost-covered granite shores & steel-blue arctic water
      wall: 0x6e96b4,
      cap: 0xe4f2fc,
      boulder: 0x86aac2,
      foliage: 0x24484a,
      trunk: 0x3c3028,
      wallRough: 0.44,
      capRough: 0.5,
      wallMetal: 0.16,
      capMetal: 0.1,
      accent: 0xecf8ff,
      water: 0x14506e,
    },
    europa: {
      // Continental European steppe/highlands: rugged slate-granite mountain ridges & rich olive-emerald conifers
      wall: 0x494f54,
      cap: 0x6c7566,
      boulder: 0x575d60,
      foliage: 0x265c32,
      trunk: 0x4a3524,
      wallRough: 0.84,
      capRough: 0.82,
      wallMetal: 0.08,
    },
    pacific_theatre: {
      // Coral Sea: dark volcanic basalt atoll crags, vivid tropical emerald palms & turquoise coral sea
      wall: 0x2d3238,
      cap: 0x46584a,
      boulder: 0x3c4347,
      foliage: 0x249c42,
      trunk: 0x6b4c30,
      wallRough: 0.84,
      capRough: 0.78,
      wallMetal: 0.08,
      accent: 0x38ba54,
      water: 0x14b4c8,
    },
    panama: {
      // Coral Sea: dark volcanic basalt atoll crags, vivid tropical emerald palms & turquoise coral sea
      wall: 0x2d3238,
      cap: 0x46584a,
      boulder: 0x3c4347,
      foliage: 0x249c42,
      trunk: 0x6b4c30,
      wallRough: 0.84,
      capRough: 0.78,
      wallMetal: 0.08,
      accent: 0x38ba54,
      water: 0x14b4c8,
    },
    english_channel: {
      // Coral Sea: dark volcanic basalt atoll crags, vivid tropical emerald palms & turquoise coral sea
      wall: 0x2d3238,
      cap: 0x46584a,
      boulder: 0x3c4347,
      foliage: 0x249c42,
      trunk: 0x6b4c30,
      wallRough: 0.84,
      capRough: 0.78,
      wallMetal: 0.08,
      accent: 0x38ba54,
      water: 0x14b4c8,
    },
    arctic_front: {
      // Polar War: ice-blue glacial ridges, snow-frosted caps & icy steel-blue polar ocean
      wall: 0x5786ad,
      cap: 0xdceefa,
      boulder: 0x7ca2c0,
      foliage: 0x204542,
      trunk: 0x3b2f28,
      wallRough: 0.4,
      capRough: 0.48,
      wallMetal: 0.18,
      capMetal: 0.1,
      accent: 0xeaf6ff,
      water: 0x16547c,
    },
    megacontinent: {
      // Eurasia Grand Theater: alpine granite peaks, snow-dusted crests, steppe pines & deep azure sea strait
      wall: 0x4a4f58,
      cap: 0x9aa4a8,
      boulder: 0x5b6066,
      foliage: 0x285834,
      trunk: 0x4c3726,
      wallRough: 0.78,
      capRough: 0.72,
      wallMetal: 0.1,
      accent: 0xdbe6ee,
      water: 0x125e94,
    },
    persian_gulf: {
      // Eurasia Grand Theater: alpine granite peaks, snow-dusted crests, steppe pines & deep azure sea strait
      wall: 0x4a4f58,
      cap: 0x9aa4a8,
      boulder: 0x5b6066,
      foliage: 0x285834,
      trunk: 0x4c3726,
      wallRough: 0.78,
      capRough: 0.72,
      wallMetal: 0.1,
      accent: 0xdbe6ee,
      water: 0x125e94,
    },
    mediterranean: {
      wall: 0x6a6254, cap: 0xa89a78, boulder: 0x756c5b, foliage: 0x3f6b32, trunk: 0x563d25,
      wallRough: 0.76, capRough: 0.7, wallMetal: 0.08, accent: 0xf0dfb4, water: 0x14749a,
    },
    scandinavia: {
      wall: 0x4d5c66, cap: 0x9fb2bd, boulder: 0x5b6b74, foliage: 0x24533d, trunk: 0x3d2d22,
      wallRough: 0.8, capRough: 0.72, wallMetal: 0.1, accent: 0xe4eef5, water: 0x124765,
    },
    terra: {
      wall: 0x535d55, cap: 0x9aa79a, boulder: 0x626b61, foliage: 0x2e6336, trunk: 0x4b3524,
      wallRough: 0.78, capRough: 0.72, wallMetal: 0.09, accent: 0xdde8dc, water: 0x115b8c,
    },
  };
  const p = palette[mapId] ?? palette.crossroads;

  let cliffWaterMat: THREE.MeshStandardMaterial | undefined;
  if (p.water !== undefined) {
    const cliffWaterNorm = new THREE.CanvasTexture(ensureWaterNormalCanvas());
    cliffWaterNorm.wrapS = cliffWaterNorm.wrapT = THREE.RepeatWrapping;
    cliffWaterMat = new THREE.MeshStandardMaterial({
      color: p.water,
      emissive: 0x0a384c,
      emissiveIntensity: 0.35,
      normalMap: cliffWaterNorm,
      normalScale: new THREE.Vector2(0.45, 0.45),
      roughness: 0.14,
      metalness: 0.32,
      transparent: true,
      opacity: 0.88,
      envMapIntensity: 1.25,
    });
  }

  const isGlowingVolcano = mapId === "volcano";
  const isGlowingCyber = mapId === "cybergrid";
  const isAtlantis = mapId === "atlantis";
  const isArctic = mapId === "tundra" || mapId === "arctic_front";
  const isMetallicBiome = mapId === "cybergrid" || mapId === "oilrig";

  const mats: CliffBiomeMats = {
    wall: new THREE.MeshStandardMaterial({
      color: p.wall,
      normalMap: rockNormalTex!,
      normalScale: new THREE.Vector2(isMetallicBiome ? 0.65 : 1.15, isMetallicBiome ? 0.65 : 1.15),
      roughnessMap: rockRoughTex!,
      roughness: p.wallRough ?? 0.9,
      metalness: p.wallMetal ?? 0.06,
      envMapIntensity: isArctic ? 0.95 : isMetallicBiome ? 1.25 : isAtlantis ? 0.9 : 0.6,
    }),
    cap: new THREE.MeshStandardMaterial({
      color: p.cap,
      normalMap: rockNormalTex!,
      normalScale: new THREE.Vector2(isMetallicBiome ? 0.45 : 0.75, isMetallicBiome ? 0.45 : 0.75),
      roughnessMap: rockRoughTex!,
      roughness: p.capRough ?? 0.86,
      metalness: p.capMetal ?? 0.05,
      envMapIntensity: isArctic ? 0.9 : isMetallicBiome ? 1.2 : isAtlantis ? 0.95 : 0.55,
    }),
    boulder: new THREE.MeshStandardMaterial({
      color: p.boulder,
      normalMap: rockNormalTex!,
      normalScale: new THREE.Vector2(0.95, 0.95),
      roughness: p.wallRough ? Math.min(0.86, p.wallRough + 0.15) : 0.9,
      metalness: p.wallMetal ?? 0.08,
      envMapIntensity: isMetallicBiome ? 1.1 : 0.55,
    }),
    foliage: new THREE.MeshStandardMaterial({
      color: p.foliage,
      roughness: isGlowingCyber ? 0.25 : 0.84,
      metalness: isGlowingCyber ? 0.4 : 0.03,
      emissive: isGlowingCyber ? new THREE.Color(0x16c8ff) : new THREE.Color(0x000000),
      emissiveIntensity: isGlowingCyber ? 0.95 : 0,
      flatShading: true,
      envMapIntensity: 0.55,
    }),
    trunk: new THREE.MeshStandardMaterial({
      color: p.trunk,
      roughness: isMetallicBiome ? 0.45 : 0.94,
      metalness: isMetallicBiome ? 0.65 : 0.02,
    }),
    accent:
      p.accent !== undefined
        ? new THREE.MeshStandardMaterial({
            color: p.accent,
            roughness: isArctic ? 0.38 : isAtlantis ? 0.28 : isGlowingVolcano || isGlowingCyber ? 0.22 : 0.78,
            metalness: isArctic ? 0.16 : isAtlantis ? 0.58 : isGlowingCyber ? 0.45 : 0.08,
            emissive: isGlowingVolcano
              ? new THREE.Color(0xff4a08)
              : isGlowingCyber
                ? new THREE.Color(0x18e0ff)
                : new THREE.Color(0x000000),
            emissiveIntensity: isGlowingVolcano ? 1.55 : isGlowingCyber ? 1.45 : 0,
            flatShading: true,
            envMapIntensity: isArctic || isAtlantis || isGlowingCyber ? 1.2 : 0.6,
          })
        : undefined,
    water: cliffWaterMat,
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

// ---------- Animated Shimmering Ocean Water Material (Tangent-Space Wave Normals) ----------

let waterNormalBase: HTMLCanvasElement | null = null;

function ensureWaterNormalCanvas(): HTMLCanvasElement {
  if (waterNormalBase) return waterNormalBase;
  const S = 256;
  const heights = new Float32Array(S * S);
  const TAU = Math.PI * 2;
  for (let py = 0; py < S; py++) {
    const v = py / S;
    for (let px = 0; px < S; px++) {
      const u = px / S;
      // Seamless multi-directional ocean swells + crisp capillary wave harmonics
      const w1 = Math.sin((u * 2 + v * 3) * TAU) * 1.0;
      const w2 = Math.sin((u * 4 - v * 3) * TAU + 1.1) * 0.68;
      const w3 = Math.cos((u * 3 + v * 6) * TAU + 2.3) * 0.48;
      const w4 = Math.sin((u * 7 + v * 5) * TAU + 0.7) * 0.3;
      const w5 = Math.cos((u * 5 - v * 9) * TAU + 1.9) * 0.22;
      const w6 = Math.sin((u * 11 + v * 8) * TAU + 3.1) * 0.14;
      const w7 = Math.cos((u * 13 - v * 11) * TAU + 0.4) * 0.1;
      const h = (w1 + w2 + w3 + w4 + w5 + w6 + w7) / 2.92;
      heights[py * S + px] = 0.5 + h * 0.46;
    }
  }
  waterNormalBase = heightBufferToNormalCanvas(heights, S, S, 2.35, true);
  return waterNormalBase;
}

export function createOceanWaterMaterial(mapId: MapId): THREE.MeshStandardMaterial {
  const normalMap = new THREE.CanvasTexture(ensureWaterNormalCanvas());
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.repeat.set(0.42, 0.42);
  normalMap.anisotropy = 4;

  const cfg: Record<string, { color: number; emissive: number; ei: number; normalScale: number; opacity?: number }> = {
    archipelago: { color: 0x16a8be, emissive: 0x0a5668, ei: 0.28, normalScale: 0.58 },
    coastline: { color: 0x184e72, emissive: 0x082438, ei: 0.22, normalScale: 0.72 },
    islands: { color: 0x1680a2, emissive: 0x083c52, ei: 0.26, normalScale: 0.62 },
    atlantis: { color: 0x16c8da, emissive: 0x0d7488, ei: 0.36, normalScale: 0.52, opacity: 0.82 },
    shipwreck: { color: 0x103f52, emissive: 0x061d28, ei: 0.2, normalScale: 0.78, opacity: 0.88 },
    volcano: { color: 0x1a3e50, emissive: 0x102834, ei: 0.24, normalScale: 0.68, opacity: 0.86 },
    oilrig: { color: 0x0f4478, emissive: 0x061f42, ei: 0.22, normalScale: 0.7, opacity: 0.87 },
    hormuz: { color: 0x0e6a8a, emissive: 0x064054, ei: 0.28, normalScale: 0.66, opacity: 0.85 },
    delta: { color: 0x1a7458, emissive: 0x0a3e2c, ei: 0.26, normalScale: 0.7, opacity: 0.86 },
    bering: { color: 0x165a7e, emissive: 0x0a2e48, ei: 0.22, normalScale: 0.72, opacity: 0.88 },
    europa: { color: 0x186c88, emissive: 0x083448, ei: 0.24, normalScale: 0.62, opacity: 0.85 },
    pacific_theatre: { color: 0x14b6cc, emissive: 0x0a6476, ei: 0.3, normalScale: 0.56, opacity: 0.84 },
    arctic_front: { color: 0x1a567c, emissive: 0x0a2c44, ei: 0.24, normalScale: 0.68, opacity: 0.87 },
    megacontinent: { color: 0x125e94, emissive: 0x082e52, ei: 0.26, normalScale: 0.64, opacity: 0.86 },
  };
  const c = cfg[mapId] ?? cfg.islands;

  return new THREE.MeshStandardMaterial({
    color: c.color,
    emissive: c.emissive,
    emissiveIntensity: c.ei,
    normalMap,
    normalScale: new THREE.Vector2(c.normalScale, c.normalScale),
    roughness: 0.08,
    metalness: 0.36,
    envMapIntensity: 1.5,
    transparent: true,
    opacity: c.opacity ?? 0.85,
    depthWrite: false,
  });
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
  beach?: [number, number, number];
  seabedShallow?: [number, number, number];
  seabedDeep?: [number, number, number];
}

const BIOMES: Record<MapId, BiomePalette> = {
  crossroads: {
    // Olive-ochre European steppe
    seedA: 1337,
    seedB: 7331,
    base: [84, 82, 56],
    altDelta: [-20, 16, -8],
    noiseAmp: [24, 22, 14],
    road: [120, 106, 82],
    spawn: [94, 96, 90],
    cliff: [56, 54, 50],
    talus: [68, 64, 54],
    trackStroke: "rgba(42, 36, 26, 0.15)",
  },
  fulda_gap: {
    // Olive-ochre European steppe
    seedA: 1337,
    seedB: 7331,
    base: [84, 82, 56],
    altDelta: [-20, 16, -8],
    noiseAmp: [24, 22, 14],
    road: [120, 106, 82],
    spawn: [94, 96, 90],
    cliff: [56, 54, 50],
    talus: [68, 64, 54],
    trackStroke: "rgba(42, 36, 26, 0.15)",
  },
  canyon: {
    // Arid red-sandstone mesa theater
    seedA: 2459,
    seedB: 8417,
    base: [136, 86, 54],
    altDelta: [22, 16, 4],
    noiseAmp: [26, 18, 12],
    road: [160, 120, 84],
    spawn: [116, 98, 84],
    cliff: [92, 46, 32],
    talus: [112, 62, 42],
    trackStroke: "rgba(68, 34, 20, 0.16)",
  },
  basin: {
    // Dark alpine volcanic basin
    seedA: 3911,
    seedB: 9173,
    base: [60, 68, 70],
    altDelta: [-10, 12, 6],
    noiseAmp: [18, 20, 22],
    road: [86, 92, 96],
    spawn: [76, 82, 88],
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
    base: [156, 128, 86],
    altDelta: [-18, -14, -10],
    noiseAmp: [22, 18, 12],
    road: [134, 116, 90],
    spawn: [112, 108, 100],
    cliff: [74, 66, 56],
    talus: [104, 92, 72],
    trackStroke: "rgba(56, 44, 30, 0.17)",
  },
  jungle: {
    // Deep lush emerald tropical valley floor with mossy dark basalt ridges
    seedA: 6427,
    seedB: 2909,
    base: [44, 88, 50],
    altDelta: [14, 26, -4],
    noiseAmp: [16, 24, 14],
    road: [100, 88, 62],
    spawn: [74, 88, 68],
    cliff: [32, 46, 36],
    talus: [42, 64, 44],
    trackStroke: "rgba(28, 24, 16, 0.2)",
  },
  islands: {
    // Deep blue-teal riverland terrain with coastal sandbars & navigable river channels
    seedA: 7219,
    seedB: 4093,
    base: [62, 98, 90],
    altDelta: [26, 18, -4],
    noiseAmp: [18, 20, 18],
    road: [146, 132, 102],
    spawn: [98, 110, 108],
    cliff: [20, 74, 98],
    talus: [152, 138, 104],
    trackStroke: "rgba(38, 50, 48, 0.16)",
    beach: [186, 166, 122],
    seabedShallow: [32, 122, 138],
    seabedDeep: [12, 52, 74],
  },
  oasis: {
    // Warm golden Sahara sand dunes with terracotta rock spurs & palm-green oasis accents
    seedA: 8369,
    seedB: 3541,
    base: [186, 146, 86],
    altDelta: [20, 14, -8],
    noiseAmp: [22, 18, 12],
    road: [160, 122, 76],
    spawn: [144, 124, 94],
    cliff: [128, 72, 46],
    talus: [154, 104, 62],
    trackStroke: "rgba(84, 52, 26, 0.16)",
  },
  archipelago: {
    // Pacific Atoll: lush volcanic emerald atolls, golden sandy beaches & turquoise tropical ocean
    seedA: 9413,
    seedB: 5741,
    base: [64, 122, 62],
    altDelta: [20, 26, -6],
    noiseAmp: [16, 22, 14],
    road: [178, 156, 110],
    spawn: [122, 134, 104],
    cliff: [44, 48, 54],
    talus: [76, 82, 68],
    trackStroke: "rgba(48, 44, 28, 0.15)",
    beach: [220, 192, 130],
    seabedShallow: [38, 174, 180],
    seabedDeep: [12, 76, 108],
  },
  coastline: {
    // Storm Coast: moody North Sea ocean, stormy green coastal shores & rugged granite cliffs
    seedA: 8747,
    seedB: 6151,
    base: [52, 82, 66],
    altDelta: [-10, 14, 8],
    noiseAmp: [16, 18, 16],
    road: [110, 108, 96],
    spawn: [84, 94, 92],
    cliff: [48, 58, 68],
    talus: [70, 78, 82],
    trackStroke: "rgba(26, 36, 40, 0.18)",
    beach: [142, 136, 114],
    seabedShallow: [26, 80, 108],
    seabedDeep: [10, 32, 54],
  },
  atlantis: {
    // Mythic Sea: luminous turquoise tropical reef ocean, pale marble-gold ancient temple causeways & teal coral pylons
    seedA: 9127,
    seedB: 4483,
    base: [184, 174, 148],
    altDelta: [18, 14, -8],
    noiseAmp: [14, 14, 12],
    road: [216, 194, 136],
    spawn: [176, 174, 160],
    cliff: [56, 132, 142],
    talus: [110, 156, 150],
    trackStroke: "rgba(130, 108, 60, 0.18)",
    beach: [228, 212, 168],
    seabedShallow: [48, 208, 214],
    seabedDeep: [10, 86, 118],
  },
  shipwreck: {
    // Abyssal: moody deep teal-slate stormy ocean, weathered dark kelp-sand shoals & wet dark granite reefs
    seedA: 7853,
    seedB: 3259,
    base: [58, 72, 68],
    altDelta: [-12, 10, 8],
    noiseAmp: [16, 18, 16],
    road: [92, 96, 88],
    spawn: [74, 84, 84],
    cliff: [36, 48, 56],
    talus: [52, 62, 66],
    trackStroke: "rgba(20, 30, 34, 0.2)",
    beach: [112, 116, 100],
    seabedShallow: [22, 74, 92],
    seabedDeep: [8, 26, 42],
  },
  volcano: {
    // Volcanic: charcoal-basalt obsidian ash earth, glowing molten lava caldera fissures & steaming slate ocean border
    seedA: 6679,
    seedB: 2819,
    base: [44, 38, 40],
    altDelta: [12, 6, 4],
    noiseAmp: [16, 12, 12],
    road: [74, 62, 56],
    spawn: [62, 56, 58],
    cliff: [32, 26, 28],
    talus: [92, 42, 22],
    trackStroke: "rgba(16, 12, 12, 0.24)",
    beach: [68, 60, 58],
    seabedShallow: [26, 62, 80],
    seabedDeep: [10, 24, 40],
  },
  oilrig: {
    // Deep Sea: deep sapphire North Atlantic ocean around riveted steel/concrete offshore platform decks
    seedA: 5381,
    seedB: 7919,
    base: [82, 90, 98],
    altDelta: [-10, -8, -4],
    noiseAmp: [12, 12, 14],
    road: [108, 114, 120],
    spawn: [96, 102, 110],
    cliff: [56, 66, 76],
    talus: [74, 80, 88],
    trackStroke: "rgba(30, 36, 42, 0.22)",
    beach: [100, 106, 114],
    seabedShallow: [18, 66, 116],
    seabedDeep: [7, 24, 58],
  },
  cybergrid: {
    // Orbital: sleek dark carbon-titanium sci-fi battle deck with luminous cyan circuit/grid inlays
    seedA: 4217,
    seedB: 9643,
    base: [26, 33, 45],
    altDelta: [8, 12, 18],
    noiseAmp: [10, 12, 16],
    road: [38, 52, 70],
    spawn: [34, 48, 66],
    cliff: [18, 26, 38],
    talus: [24, 60, 82],
    trackStroke: "rgba(38, 214, 248, 0.22)",
  },
  hormuz: {
    // Gulf Strait: arid golden-sand coasts, salt flats & deep teal-blue Persian Gulf channels
    seedA: 6301,
    seedB: 2381,
    base: [168, 148, 108],
    altDelta: [14, 10, -6],
    noiseAmp: [18, 16, 12],
    road: [196, 172, 124],
    spawn: [148, 132, 96],
    cliff: [116, 98, 66],
    talus: [138, 120, 86],
    trackStroke: "rgba(60, 50, 30, 0.2)",
    beach: [218, 196, 148],
    seabedShallow: [22, 132, 152],
    seabedDeep: [8, 56, 84],
  },
  delta: {
    // River Delta: lush emerald paddies & jungle banks with warm green-brown braided waterways
    seedA: 4451,
    seedB: 7723,
    base: [58, 108, 52],
    altDelta: [10, 18, 4],
    noiseAmp: [20, 22, 12],
    road: [122, 108, 70],
    spawn: [92, 112, 74],
    cliff: [44, 72, 46],
    talus: [66, 88, 58],
    trackStroke: "rgba(30, 44, 22, 0.18)",
    beach: [172, 158, 104],
    seabedShallow: [30, 128, 100],
    seabedDeep: [10, 62, 56],
  },
  bering: {
    // Polar Strait: snow-swept taiga shores, ice-floe fields & deep steel-blue arctic water
    seedA: 8819,
    seedB: 1493,
    base: [128, 152, 168],
    altDelta: [16, 20, 14],
    noiseAmp: [14, 16, 14],
    road: [156, 172, 182],
    spawn: [142, 160, 174],
    cliff: [96, 128, 152],
    talus: [118, 144, 162],
    trackStroke: "rgba(48, 70, 88, 0.18)",
    beach: [212, 228, 236],
    seabedShallow: [30, 96, 126],
    seabedDeep: [8, 38, 64],
  },
  europa: {
    // Continental European steppe & highlands: rich olive-emerald fields, slate-granite ridges & golden-hour roads
    seedA: 2903,
    seedB: 8147,
    base: [68, 92, 54],
    altDelta: [-12, 20, -6],
    noiseAmp: [20, 22, 14],
    road: [126, 114, 88],
    spawn: [94, 100, 88],
    cliff: [58, 62, 66],
    talus: [76, 78, 70],
    trackStroke: "rgba(40, 38, 26, 0.16)",
  },
  pacific_theatre: {
    // Coral Sea: vivid tropical turquoise ocean, golden sandy shores & lush volcanic emerald atolls
    seedA: 9623,
    seedB: 4871,
    base: [60, 126, 62],
    altDelta: [22, 24, -6],
    noiseAmp: [16, 22, 14],
    road: [184, 160, 112],
    spawn: [124, 136, 106],
    cliff: [44, 48, 54],
    talus: [78, 84, 68],
    trackStroke: "rgba(48, 44, 28, 0.15)",
    beach: [228, 198, 132],
    seabedShallow: [36, 188, 194],
    seabedDeep: [10, 74, 112],
  },
  panama: {
    // Coral Sea: vivid tropical turquoise ocean, golden sandy shores & lush volcanic emerald atolls
    seedA: 9623,
    seedB: 4871,
    base: [60, 126, 62],
    altDelta: [22, 24, -6],
    noiseAmp: [16, 22, 14],
    road: [184, 160, 112],
    spawn: [124, 136, 106],
    cliff: [44, 48, 54],
    talus: [78, 84, 68],
    trackStroke: "rgba(48, 44, 28, 0.15)",
    beach: [228, 198, 132],
    seabedShallow: [36, 188, 194],
    seabedDeep: [10, 74, 112],
  },
  english_channel: {
    // Coral Sea: vivid tropical turquoise ocean, golden sandy shores & lush volcanic emerald atolls
    seedA: 9623,
    seedB: 4871,
    base: [60, 126, 62],
    altDelta: [22, 24, -6],
    noiseAmp: [16, 22, 14],
    road: [184, 160, 112],
    spawn: [124, 136, 106],
    cliff: [44, 48, 54],
    talus: [78, 84, 68],
    trackStroke: "rgba(48, 44, 28, 0.15)",
    beach: [228, 198, 132],
    seabedShallow: [36, 188, 194],
    seabedDeep: [10, 74, 112],
  },
  arctic_front: {
    // Polar War: crisp blue-white arctic snowfields, icy steel-blue polar ocean & glacial ridges
    seedA: 4937,
    seedB: 8513,
    base: [196, 212, 228],
    altDelta: [-20, -10, 10],
    noiseAmp: [16, 18, 16],
    road: [144, 166, 188],
    spawn: [156, 174, 192],
    cliff: [88, 130, 168],
    talus: [132, 162, 188],
    trackStroke: "rgba(56, 82, 110, 0.2)",
    beach: [176, 198, 216],
    seabedShallow: [34, 96, 136],
    seabedDeep: [10, 36, 64],
  },
  megacontinent: {
    // Eurasia Grand Theater: sweeping warm steppe & alpine peaks split by a deep azure sea strait
    seedA: 7529,
    seedB: 3187,
    base: [96, 94, 62],
    altDelta: [-16, 18, -8],
    noiseAmp: [24, 22, 14],
    road: [134, 118, 88],
    spawn: [104, 104, 94],
    cliff: [62, 66, 72],
    talus: [84, 82, 74],
    trackStroke: "rgba(44, 38, 26, 0.16)",
    beach: [192, 172, 126],
    seabedShallow: [26, 110, 152],
    seabedDeep: [9, 40, 82],
  },
  persian_gulf: {
    // Eurasia Grand Theater: sweeping warm steppe & alpine peaks split by a deep azure sea strait
    seedA: 7529,
    seedB: 3187,
    base: [96, 94, 62],
    altDelta: [-16, 18, -8],
    noiseAmp: [24, 22, 14],
    road: [134, 118, 88],
    spawn: [104, 104, 94],
    cliff: [62, 66, 72],
    talus: [84, 82, 74],
    trackStroke: "rgba(44, 38, 26, 0.16)",
    beach: [192, 172, 126],
    seabedShallow: [26, 110, 152],
    seabedDeep: [9, 40, 82],
  },
  mediterranean: {
    seedA: 7631, seedB: 4111, base: [104, 103, 58], altDelta: [-10, 17, -4], noiseAmp: [23, 21, 13],
    road: [145, 125, 86], spawn: [111, 105, 91], cliff: [102, 92, 74], talus: [126, 111, 82],
    trackStroke: "rgba(72, 54, 28, 0.16)", beach: [205, 179, 121], seabedShallow: [24, 126, 158], seabedDeep: [8, 54, 101],
  },
  scandinavia: {
    seedA: 7643, seedB: 4127, base: [72, 99, 72], altDelta: [-8, 20, 9], noiseAmp: [18, 25, 18],
    road: [111, 113, 96], spawn: [99, 105, 96], cliff: [72, 91, 104], talus: [96, 111, 119],
    trackStroke: "rgba(30, 43, 39, 0.18)", beach: [162, 168, 143], seabedShallow: [30, 91, 119], seabedDeep: [7, 34, 68],
  },
  terra: {
    seedA: 7657, seedB: 4151, base: [83, 109, 62], altDelta: [-12, 19, -7], noiseAmp: [22, 25, 15],
    road: [129, 116, 82], spawn: [104, 106, 94], cliff: [79, 91, 82], talus: [104, 109, 94],
    trackStroke: "rgba(40, 48, 28, 0.17)", beach: [190, 174, 124], seabedShallow: [27, 113, 158], seabedDeep: [7, 43, 91],
  },
};

export function createBattlefieldTextures(mapId: MapId = "crossroads"): {
  map: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
} {
  const S = 1024;
  const [dc, dctx] = makeCanvas(S, S);
  const [bc, bctx] = makeCanvas(S, S);
  const bio = BIOMES[mapId] ?? BIOMES.crossroads;
  const noiseA = valueNoise2D(bio.seedA);
  const noiseB = valueNoise2D(bio.seedB);
  const noiseC = valueNoise2D(bio.seedA ^ (bio.seedB + 193));
  const rand = mulberry32(5519 + bio.seedA);
  const layout = getMapLayout(mapId);
  const W = layout.w;
  const H = layout.h;
  const spawns = getSpawns(W, H);

  const isSandy = mapId === "oasis" || mapId === "canyon" || mapId === "fortress";
  const isTundra = mapId === "tundra" || mapId === "arctic_front";
  const isAtlantis = mapId === "atlantis";
  const isVolcano = mapId === "volcano";
  const isOilrig = mapId === "oilrig";
  const isCyber = mapId === "cybergrid";
  const isShipwreck = mapId === "shipwreck";
  const isGrassy =
    mapId === "crossroads" ||
    mapId === "jungle" ||
    mapId === "archipelago" ||
    mapId === "coastline" ||
    mapId === "islands" ||
    mapId === "europa" ||
    mapId === "pacific_theatre" ||
    mapId === "megacontinent";

  // Precompute tile-level cliff and navigable water masks
  const cliffGrid = new Uint8Array(W * H);
  for (const [cx, cy] of layout.cliffs) {
    if (cx >= 0 && cy >= 0 && cx < W && cy < H) cliffGrid[cy * W + cx] = 1;
  }

  const waterGrid = new Uint8Array(W * H);
  const hasWater = layout.water.length > 0;
  for (const [wx0, wy0] of layout.water) {
    if (wx0 >= 0 && wy0 >= 0 && wx0 < W && wy0 < H) waterGrid[wy0 * W + wx0] = 1;
  }

  const cliffNear = (wx: number, wy: number): { inside: boolean; dist: number } => {
    const tx = Math.floor(wx);
    const ty = Math.floor(wy);
    if (tx >= 0 && ty >= 0 && tx < W && ty < H && cliffGrid[ty * W + tx]) {
      return { inside: true, dist: 0 };
    }
    let minD = 99;
    const x0 = Math.max(0, tx - 2);
    const x1 = Math.min(W - 1, tx + 2);
    const y0 = Math.max(0, ty - 2);
    const y1 = Math.min(H - 1, ty + 2);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!cliffGrid[y * W + x]) continue;
        const dx = Math.max(x - wx, 0, wx - (x + 1));
        const dy = Math.max(y - wy, 0, wy - (y + 1));
        const dd = Math.hypot(dx, dy);
        if (dd < minD) minD = dd;
      }
    }
    return { inside: false, dist: minD };
  };

  const waterNear = (wx: number, wy: number): { inside: boolean; dist: number; landDist: number } => {
    if (!hasWater) return { inside: false, dist: 99, landDist: 0 };
    const tx = Math.floor(wx);
    const ty = Math.floor(wy);
    const inW = tx >= 0 && ty >= 0 && tx < W && ty < H && waterGrid[ty * W + tx] === 1;
    const rad = 3;
    const x0 = Math.max(0, tx - rad);
    const x1 = Math.min(W - 1, tx + rad);
    const y0 = Math.max(0, ty - rad);
    const y1 = Math.min(H - 1, ty + rad);
    let minD = 99;
    if (inW) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (waterGrid[y * W + x]) continue;
          const dx = Math.max(x - wx, 0, wx - (x + 1));
          const dy = Math.max(y - wy, 0, wy - (y + 1));
          const dd = Math.hypot(dx, dy);
          if (dd < minD) minD = dd;
        }
      }
      return { inside: true, dist: 0, landDist: minD };
    }
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!waterGrid[y * W + x]) continue;
        const dx = Math.max(x - wx, 0, wx - (x + 1));
        const dy = Math.max(y - wy, 0, wy - (y + 1));
        const dd = Math.hypot(dx, dy);
        if (dd < minD) minD = dd;
      }
    }
    return { inside: false, dist: minD, landDist: 0 };
  };

  const beachCol = bio.beach ?? [180, 162, 118];
  const seaShallow = bio.seabedShallow ?? [28, 114, 134];
  const seaDeep = bio.seabedDeep ?? [12, 48, 72];
  const beachSpan =
    mapId === "archipelago" || mapId === "pacific_theatre"
      ? 2.45
      : isAtlantis
        ? 2.2
        : isOilrig
          ? 0.9
          : mapId === "coastline" || isShipwreck || mapId === "arctic_front"
            ? 1.85
            : 2.05;

  const img = dctx.createImageData(S, S);
  const bimg = bctx.createImageData(S, S);
  const d = img.data;
  const b = bimg.data;
  const heightField = new Float32Array(S * S);

  // Compute natural worn convoy road factor between perimeter spawns and theater center
  const ringRadius = Math.min(W, H) * 0.28;
  const roadDist = (wx: number, wy: number) => {
    const cx = W / 2,
      cy = H / 2;
    let best = 999;
    for (const s of spawns) {
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
    const ringDist = Math.abs(Math.hypot(wx - cx, wy - cy) - ringRadius);
    return Math.min(best, ringDist * 1.15);
  };

  for (let py = 0; py < S; py++) {
    const wy = (py / S) * H;
    for (let px = 0; px < S; px++) {
      const wx = (px / S) * W;
      const n1 = noiseA(wx * 0.14, wy * 0.14);
      const n2 = noiseB(wx * 0.42, wy * 0.42);
      const n3 = noiseA(wx * 0.14 + 0.18, wy * 0.14 + 0.18);
      const micro = noiseC(wx * 1.65, wy * 1.65);
      const slopeShade = isOilrig || isCyber ? 1 + (n1 - n3) * 0.14 : 1 + (n1 - n3) * 0.34;
      const fine = (rand() - 0.5) * (isOilrig || isCyber ? 6 : 12);

      const altMix = Math.max(0, Math.min(1, (n1 - 0.34) * 2.4));
      let r = bio.base[0] + altMix * bio.altDelta[0] + n2 * bio.noiseAmp[0];
      let g = bio.base[1] + altMix * bio.altDelta[1] + n2 * bio.noiseAmp[1];
      let bl = bio.base[2] + altMix * bio.altDelta[2] + n2 * bio.noiseAmp[2];
      let bumpExtra = (micro - 0.5) * 28;

      // Biome-specific high-frequency micro-relief & surface storytelling
      if (isSandy) {
        // Wind-swept sand dune ripples catching raking golden sunlight
        const ripplePhase = (wx * 2.8 + wy * 1.9 + n2 * 4.2 + micro * 0.9) * Math.PI;
        const ripple = Math.sin(ripplePhase);
        const crest = ripple * ripple * (ripple > 0 ? 1 : -0.65);
        r += crest * 9;
        g += crest * 7;
        bl += crest * 4;
        bumpExtra += ripple * 16;
      } else if (isTundra) {
        // Wind-scoured arctic sastrugi snow ridges & glistening ice-crust highlights
        const sastrugi = Math.sin((wx * 1.9 - wy * 1.1 + n2 * 3.4) * Math.PI);
        const sparkle = micro > 0.78 && rand() > 0.65 ? 16 : 0;
        r += sastrugi * 7 + sparkle;
        g += sastrugi * 9 + sparkle;
        bl += sastrugi * 12 + sparkle * 1.1;
        bumpExtra += sastrugi * 14 + (sparkle > 0 ? 10 : 0);
      } else if (isAtlantis) {
        // Ancient Atlantean marble flagstones with subtle golden inlaid grout lines
        const fx = ((wx * 0.5) % 1 + 1) % 1;
        const fy = ((wy * 0.5) % 1 + 1) % 1;
        const seam = fx < 0.045 || fy < 0.045;
        const goldInlay = (Math.abs(fx - 0.5) < 0.025 || Math.abs(fy - 0.5) < 0.025) && n1 > 0.45;
        if (seam) {
          r -= 24;
          g -= 22;
          bl -= 18;
          bumpExtra -= 22;
        } else if (goldInlay) {
          r = r * 0.45 + 216 * 0.55;
          g = g * 0.45 + 182 * 0.55;
          bl = bl * 0.45 + 88 * 0.55;
          bumpExtra += 8;
        } else {
          const vein = Math.sin((wx * 2.1 + wy * 1.7 + n2 * 4.5) * 1.8) * 6;
          r += vein;
          g += vein * 0.9;
          bl += vein * 0.75;
        }
      } else if (isShipwreck) {
        // Wet dark kelp-sand shoal ripples & weathered tidal detritus
        const kelp = noiseC(wx * 2.4 + n2 * 1.8, wy * 2.4 - n1 * 1.4);
        const kelpPatch = Math.max(0, kelp - 0.58) * 2.3;
        r -= kelpPatch * 14;
        g += kelpPatch * 8;
        bl -= kelpPatch * 4;
        bumpExtra += (kelp - 0.5) * 22;
      } else if (isVolcano) {
        // Jagged obsidian-basalt ash ridges & glowing magma micro-cracks
        const ridge = Math.abs(micro - 0.5) * 2;
        const crackNoise = Math.abs(noiseC(wx * 1.2 + n2 * 1.6, wy * 1.2 - n1 * 1.4) - 0.5);
        r -= (1 - ridge) * 10;
        g -= (1 - ridge) * 9;
        bl -= (1 - ridge) * 8;
        bumpExtra += ridge * 24 - 12;
        if (crackNoise < 0.022 && Math.hypot(wx - W / 2, wy - H / 2) < 22) {
          const glow = 1 - crackNoise / 0.022;
          r = r * (1 - glow) + 245 * glow;
          g = g * (1 - glow) + 112 * glow;
          bl = bl * (1 - glow) + 22 * glow;
          bumpExtra -= glow * 18;
        }
      } else if (isOilrig) {
        // Riveted industrial steel/concrete offshore deck plating seams
        const gx = ((wx * 0.5) % 1 + 1) % 1;
        const gy = ((wy * 0.5) % 1 + 1) % 1;
        const seam = gx < 0.04 || gy < 0.04;
        const subSeam = Math.abs(gx - 0.5) < 0.018 || Math.abs(gy - 0.5) < 0.018;
        if (seam) {
          r -= 28;
          g -= 30;
          bl -= 32;
          bumpExtra = -26;
        } else if (subSeam) {
          r -= 12;
          g -= 13;
          bl -= 14;
          bumpExtra = -10;
        } else {
          // Subtle anti-slip diamond plate micro-texture
          const plate = Math.sin(wx * 18) * Math.sin(wy * 18);
          r += plate * 4;
          g += plate * 4;
          bl += plate * 4.5;
          bumpExtra = plate * 10;
        }
      } else if (isCyber) {
        // Sleek carbon-titanium battle deck with precision panel joints & luminous cyan circuit inlays
        const gx = ((wx * 0.5) % 1 + 1) % 1;
        const gy = ((wy * 0.5) % 1 + 1) % 1;
        const major = ((wx * 0.125) % 1 + 1) % 1;
        const majorY = ((wy * 0.125) % 1 + 1) % 1;
        const seam = gx < 0.035 || gy < 0.035;
        const circuit = major < 0.018 || majorY < 0.018;
        if (circuit) {
          r = 28;
          g = 216;
          bl = 248;
          bumpExtra = 14;
        } else if (seam) {
          r -= 10;
          g -= 11;
          bl -= 13;
          bumpExtra = -18;
        } else {
          const hex = Math.sin((wx + wy) * 6.2) * Math.cos((wx - wy) * 6.2);
          r += hex * 3;
          g += hex * 4;
          bl += hex * 6;
          bumpExtra = hex * 8;
        }
      } else if (isGrassy) {
        // Crisp dry-grass streaks & mossy tuft micro-variation
        const streak = noiseC(wx * 3.1 + n2 * 1.4, wy * 0.95);
        const dryMix = Math.max(0, streak - 0.56) * 2.2;
        r += dryMix * 16;
        g += dryMix * 10 - (micro - 0.5) * 12;
        bl -= dryMix * 6;
        bumpExtra += (streak - 0.5) * 18;
      } else {
        // Volcanic basalt scree ridges on Basin
        const ridge = Math.abs(micro - 0.5) * 2;
        r -= (1 - ridge) * 8;
        g -= (1 - ridge) * 7;
        bl -= (1 - ridge) * 5;
        bumpExtra += ridge * 20 - 10;
      }

      // Worn convoy roads
      const rd = roadDist(wx, wy) + (n2 - 0.5) * (isOilrig || isCyber ? 0.35 : 1.4);
      if (rd < 2.2) {
        const k = Math.max(0, 1 - rd / 2.2);
        const s = k * k * 0.62;
        r = r * (1 - s) + bio.road[0] * s;
        g = g * (1 - s) + bio.road[1] * s;
        bl = bl * (1 - s) + bio.road[2] * s;
        // Subtle compacted wheel-rut depression along road
        bumpExtra = bumpExtra * (1 - s * 0.55) - s * 10;
        if (isCyber && Math.abs(rd - 1.55) < 0.14) {
          r = 34;
          g = 212;
          bl = 248;
        }
      }

      // Flattened compacted gravel clearings at each spawn base
      for (const sp of spawns) {
        const sd = Math.hypot(wx - (sp.x + 1.5), wy - (sp.y + 1.5));
        if (sd < 7.5) {
          const k = Math.max(0, 1 - sd / 7.5);
          const s = k * k * 0.52;
          r = r * (1 - s) + bio.spawn[0] * s;
          g = g * (1 - s) + bio.spawn[1] * s;
          bl = bl * (1 - s) + bio.spawn[2] * s;
          bumpExtra *= 1 - s * 0.45;
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
        bumpExtra = 58 + strata;
        if (isVolcano) {
          const lavaVein = Math.abs(Math.sin((wx * 2.2 - wy * 1.9 + n2 * 3.8) * 1.7));
          if (lavaVein < 0.14) {
            const lv = 1 - lavaVein / 0.14;
            r = r * (1 - lv) + 252 * lv;
            g = g * (1 - lv) + 118 * lv;
            bl = bl * (1 - lv) + 24 * lv;
          }
        }
      } else if (cf.dist < 1.5) {
        const k = Math.max(0, 1 - cf.dist / 1.5);
        const scree = k * k * 0.72;
        const ao = 1 - k * k * 0.34;
        r = (r * (1 - scree) + bio.talus[0] * scree) * ao;
        g = (g * (1 - scree) + bio.talus[1] * scree) * ao;
        bl = (bl * (1 - scree) + bio.talus[2] * scree) * ao;
        bumpExtra += k * 36;
        if (isVolcano) {
          // Glowing molten orange-amber lava fissures ringing the volcanic caldera cliffs
          const fissure = Math.abs(Math.sin((wx * 2.5 + wy * 2.1 + n2 * 3.4) * 1.5));
          if (fissure < 0.16 && cf.dist < 1.15) {
            const lv = (1 - fissure / 0.16) * (1 - cf.dist / 1.15);
            r = r * (1 - lv) + 250 * lv;
            g = g * (1 - lv) + 120 * lv;
            bl = bl * (1 - lv) + 24 * lv;
          }
        } else if (isCyber && cf.dist < 0.45) {
          const glow = 1 - cf.dist / 0.45;
          r = r * (1 - glow * 0.65) + 32 * glow * 0.65;
          g = g * (1 - glow * 0.65) + 220 * glow * 0.65;
          bl = bl * (1 - glow * 0.65) + 250 * glow * 0.65;
        }
      }

      // Navigable ocean / river seabed & golden wet-to-dry sandy coastal shorelines (or Oilrig hazard deck trim)
      if (hasWater) {
        const wf = waterNear(wx, wy);
        if (wf.inside) {
          const depthT = Math.min(1, Math.max(0, (wf.landDist + (n2 - 0.5) * 0.65) / 2.6));
          const smoothD = depthT * depthT * (3 - 2 * depthT);
          const caustic = Math.sin((wx * 1.9 + wy * 1.4 + n2 * 3.1) * 2.1) * (isAtlantis ? 13 : 9) * (1 - smoothD * 0.62);
          r = seaShallow[0] * (1 - smoothD) + seaDeep[0] * smoothD + caustic * 0.55;
          g = seaShallow[1] * (1 - smoothD) + seaDeep[1] * smoothD + caustic * 0.95;
          bl = seaShallow[2] * (1 - smoothD) + seaDeep[2] * smoothD + caustic * 1.05;
          bumpExtra = -36 - smoothD * 24 + caustic * 0.7;
        } else if (isOilrig && wf.dist < 0.58) {
          // Crisp yellow-and-black industrial hazard safety striping along offshore platform edges!
          const stripe = Math.floor((wx + wy) * 3.0) % 2 === 0;
          if (wf.dist < 0.36) {
            r = stripe ? 228 : 34;
            g = stripe ? 176 : 38;
            bl = stripe ? 32 : 42;
            bumpExtra = 12;
          } else {
            r = 56;
            g = 62;
            bl = 68;
            bumpExtra = -8;
          }
        } else if (wf.dist < beachSpan) {
          const k = Math.max(0, 1 - (wf.dist + (n2 - 0.5) * 0.45) / beachSpan);
          const sandMix = Math.min(1, k * k * 1.15);
          // Rich wet-sand shoreline transition darkening + subtle shore ripple near water edge
          const wetFactor = wf.dist < 0.62 ? 1 - Math.pow(1 - wf.dist / 0.62, 1.5) * 0.32 : 1;
          const shoreRipple = Math.sin(wf.dist * 12 + n2 * 3) * 4 * k;
          r = (r * (1 - sandMix) + (beachCol[0] + shoreRipple) * sandMix) * wetFactor;
          g = (g * (1 - sandMix) + (beachCol[1] + shoreRipple * 0.9) * sandMix) * wetFactor;
          bl = (bl * (1 - sandMix) + (beachCol[2] + shoreRipple * 0.7) * sandMix) * wetFactor;
          bumpExtra = bumpExtra * (1 - sandMix * 0.65) - k * 16 + shoreRipple * 1.2;
        }
      }

      // Subtle tactical vignette near map border
      const edge = Math.min(wx, wy, W - wx, H - wy);
      const edgeDark = edge < 2.5 ? 0.72 + (edge / 2.5) * 0.28 : 1;
      const maxC = isVolcano || isCyber ? 250 : isTundra || isAtlantis ? 238 : 228;

      const idx = py * S + px;
      const idx4 = idx * 4;
      d[idx4] = Math.max(10, Math.min(maxC, (r * slopeShade + fine) * edgeDark));
      d[idx4 + 1] = Math.max(14, Math.min(maxC, (g * slopeShade + fine) * edgeDark));
      d[idx4 + 2] = Math.max(14, Math.min(maxC, (bl * slopeShade + fine) * edgeDark));
      d[idx4 + 3] = 255;

      const bv = Math.max(12, Math.min(244, 124 + (n2 - 0.5) * 86 + bumpExtra + fine * 1.6));
      b[idx4] = b[idx4 + 1] = b[idx4 + 2] = bv;
      b[idx4 + 3] = 255;
      heightField[idx] = bv / 255;
    }
  }
  dctx.putImageData(img, 0, 0);
  bctx.putImageData(bimg, 0, 0);

  // Scattered deterministic surface pebbles & dry grass tufts (baked into albedo + heightfield for crisp relief)
  const pebbleCount = isCyber || isOilrig ? 0 : isTundra ? 650 : isAtlantis ? 420 : 1400;
  for (let i = 0; i < pebbleCount; i++) {
    const px = Math.floor(rand() * S);
    const py = Math.floor(rand() * S);
    const tx = Math.min(W - 1, Math.floor((px / S) * W));
    const ty = Math.min(H - 1, Math.floor((py / S) * H));
    if (waterGrid[ty * W + tx]) continue;

    const rad = 1.0 + rand() * 2.1;
    const bright = rand() > 0.45;
    dctx.fillStyle = isTundra
      ? bright
        ? "rgba(235, 246, 255, 0.35)"
        : "rgba(130, 158, 184, 0.32)"
      : isAtlantis
        ? bright
          ? "rgba(238, 224, 182, 0.3)"
          : "rgba(128, 154, 146, 0.25)"
        : isVolcano
          ? bright
            ? "rgba(245, 118, 32, 0.28)"
            : "rgba(24, 20, 22, 0.45)"
          : isSandy
            ? bright
              ? "rgba(218, 184, 134, 0.32)"
              : "rgba(104, 72, 44, 0.34)"
            : bright
              ? "rgba(154, 150, 136, 0.32)"
              : "rgba(42, 44, 38, 0.35)";
    dctx.beginPath();
    dctx.arc(px, py, rad, 0, Math.PI * 2);
    dctx.fill();

    // Raise pebble micro-height in heightField so tangent-space normalMap catches sunlight
    const ir = Math.ceil(rad);
    const dh = bright ? 0.085 : 0.055;
    for (let oy = -ir; oy <= ir; oy++) {
      const ny = py + oy;
      if (ny < 0 || ny >= S) continue;
      for (let ox = -ir; ox <= ir; ox++) {
        const nx = px + ox;
        if (nx < 0 || nx >= S) continue;
        const dd = Math.hypot(ox, oy);
        if (dd <= rad) {
          const idx = ny * S + nx;
          heightField[idx] = Math.min(1, heightField[idx] + dh * (1 - dd / (rad + 0.2)));
        }
      }
    }
  }

  // Faint road track marks (clipped to land tiles on naval maps so tracks never cross open ocean)
  dctx.strokeStyle = bio.trackStroke;
  dctx.lineWidth = 3;
  dctx.setLineDash([12, 10]);
  for (const sp of spawns) {
    const sx = sp.x + 1.5;
    const sy = sp.y + 1.5;
    const ex = W / 2;
    const ey = H / 2;
    if (!hasWater) {
      dctx.beginPath();
      dctx.moveTo((sx / W) * S, (sy / H) * S);
      dctx.lineTo((ex / W) * S, (ey / H) * S);
      dctx.stroke();
    } else {
      const steps = Math.max(40, Math.round(Math.max(W, H) * 0.7));
      let drawing = false;
      dctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const wx = sx + (ex - sx) * u;
        const wy = sy + (ey - sy) * u;
        const tx = Math.max(0, Math.min(W - 1, Math.floor(wx)));
        const ty = Math.max(0, Math.min(H - 1, Math.floor(wy)));
        const dry = !waterGrid[ty * W + tx];
        if (dry) {
          if (!drawing) {
            dctx.moveTo((wx / W) * S, (wy / H) * S);
            drawing = true;
          } else {
            dctx.lineTo((wx / W) * S, (wy / H) * S);
          }
        } else {
          drawing = false;
        }
      }
      dctx.stroke();
    }
  }

  const normalCanvas = heightBufferToNormalCanvas(heightField, S, S, 1.55, false);

  const map = new THREE.CanvasTexture(dc);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;

  const bumpMap = new THREE.CanvasTexture(bc);
  bumpMap.anisotropy = 4;

  const normalMap = new THREE.CanvasTexture(normalCanvas);
  normalMap.anisotropy = 8;

  return { map, bumpMap, normalMap };
}

// ---------- Seamless 256x256 Close-Up 1P Ground Micro-Detail Maps ----------

let groundMicroMapTex: THREE.CanvasTexture | null = null;
let groundMicroNormalTex: THREE.CanvasTexture | null = null;

export function getGroundMicroDetail(): {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
} {
  if (groundMicroMapTex && groundMicroNormalTex) {
    return { map: groundMicroMapTex, normalMap: groundMicroNormalTex };
  }

  const S = 256;
  const [mc, mctx] = makeCanvas(S, S);
  const img = mctx.createImageData(S, S);
  const d = img.data;
  const heights = new Float32Array(S * S);
  const rand = mulberry32(73319);

  // Tileable periodic value noise generator (period P divides S cleanly for 100% seamless tiling)
  const makePeriodicNoise = (period: number, seed: number) => {
    const r = mulberry32(seed);
    const grid = new Float32Array(period * period);
    for (let i = 0; i < grid.length; i++) grid[i] = r();
    return (px: number, py: number) => {
      const fx = (px / S) * period;
      const fy = (py / S) * period;
      const x0 = Math.floor(fx) % period;
      const y0 = Math.floor(fy) % period;
      const x1 = (x0 + 1) % period;
      const y1 = (y0 + 1) % period;
      const tx = fx - Math.floor(fx);
      const ty = fy - Math.floor(fy);
      const u = tx * tx * (3 - 2 * tx);
      const v = ty * ty * (3 - 2 * ty);
      const a = grid[y0 * period + x0];
      const b = grid[y0 * period + x1];
      const c = grid[y1 * period + x0];
      const e = grid[y1 * period + x1];
      return a + (b - a) * u + (c - a) * v + (a - b - c + e) * u * v;
    };
  };

  const n8 = makePeriodicNoise(8, 1011);
  const n16 = makePeriodicNoise(16, 2023);
  const n32 = makePeriodicNoise(32, 3037);
  const n64 = makePeriodicNoise(64, 4051);

  // Base multi-octave organic earth / soil / mineral micro-grain centered around neutral 0.50
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const fbm = n8(px, py) * 0.24 + n16(px, py) * 0.28 + n32(px, py) * 0.28 + n64(px, py) * 0.2;
      const grit = (rand() - 0.5) * 0.16;
      const h = Math.max(0.05, Math.min(0.95, 0.5 + (fbm - 0.5) * 0.62 + grit));
      const idx = py * S + px;
      heights[idx] = h;
    }
  }

  // Wrap-safe helper to stamp organic micro-features seamlessly across tile borders
  const stampDisc = (cx: number, cy: number, rad: number, dh: number) => {
    const ir = Math.ceil(rad);
    for (let oy = -ir; oy <= ir; oy++) {
      const ny = (((Math.round(cy) + oy) % S) + S) % S;
      for (let ox = -ir; ox <= ir; ox++) {
        const nx = (((Math.round(cx) + ox) % S) + S) % S;
        const dist = Math.hypot(ox, oy);
        if (dist <= rad) {
          const t = 1 - dist / (rad + 0.15);
          const smooth = t * t * (3 - 2 * t);
          const idx = ny * S + nx;
          heights[idx] = Math.max(0.02, Math.min(0.98, heights[idx] + dh * smooth));
        }
      }
    }
  };

  // Crisp tiny stones & aggregate pebbles (raised highlights + subtle recessed soil pores)
  for (let i = 0; i < 420; i++) {
    const cx = rand() * S;
    const cy = rand() * S;
    const rad = 1.1 + rand() * 2.5;
    const raised = rand() > 0.34;
    stampDisc(cx, cy, rad, raised ? 0.14 + rand() * 0.14 : -(0.1 + rand() * 0.12));
  }

  // Fine crisp organic grass / earth fiber micro-blades (wrapped toroidally)
  for (let i = 0; i < 650; i++) {
    const x0 = rand() * S;
    const y0 = rand() * S;
    const ang = rand() * Math.PI * 2;
    const len = 3 + rand() * 7;
    const dh = (rand() > 0.45 ? 1 : -1) * (0.055 + rand() * 0.065);
    const steps = Math.ceil(len * 1.5);
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      const px = (((Math.round(x0 + Math.cos(ang) * len * f) % S) + S) % S);
      const py = (((Math.round(y0 + Math.sin(ang) * len * f) % S) + S) % S);
      const idx = py * S + px;
      const taper = 1 - Math.abs(f - 0.5) * 1.4;
      heights[idx] = Math.max(0.02, Math.min(0.98, heights[idx] + dh * Math.max(0.2, taper)));
    }
  }

  // Re-center mean strictly to 0.50 so shader multiplication preserves exact biome brightness
  let sum = 0;
  for (let i = 0; i < heights.length; i++) sum += heights[i];
  const meanOffset = 0.5 - sum / heights.length;
  for (let i = 0; i < heights.length; i++) {
    const h = Math.max(0.02, Math.min(0.98, heights[i] + meanOffset));
    heights[i] = h;
    // Slight warm/cool mineral speckle tinting while staying near-neutral around 128
    const base = Math.round(h * 255);
    const tint = ((i * 2654435761) >>> 28) - 7; // deterministic -7..+8 micro-chroma
    const idx4 = i * 4;
    d[idx4] = Math.max(0, Math.min(255, base + (tint >> 1)));
    d[idx4 + 1] = Math.max(0, Math.min(255, base + (tint >> 2)));
    d[idx4 + 2] = Math.max(0, Math.min(255, base - (tint >> 1)));
    d[idx4 + 3] = 255;
  }
  mctx.putImageData(img, 0, 0);

  const normalCanvas = heightBufferToNormalCanvas(heights, S, S, 2.35, true);

  // Keep micro-albedo linear so neutral 0.50 maps cleanly to 1.00 contrast multiplier in GLSL
  groundMicroMapTex = new THREE.CanvasTexture(mc);
  groundMicroMapTex.wrapS = groundMicroMapTex.wrapT = THREE.RepeatWrapping;
  groundMicroMapTex.anisotropy = 8;

  groundMicroNormalTex = new THREE.CanvasTexture(normalCanvas);
  groundMicroNormalTex.wrapS = groundMicroNormalTex.wrapT = THREE.RepeatWrapping;
  groundMicroNormalTex.anisotropy = 8;

  return { map: groundMicroMapTex, normalMap: groundMicroNormalTex };
}
