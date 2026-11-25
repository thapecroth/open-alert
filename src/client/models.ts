import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { CrateKind } from "../shared/gamedefs";
import { BUILDINGS, EntKind, isBuildingKind } from "./util";
import { getChassisMat, getContactShadowTex, getGlowMat } from "./textures";
import { buildLandModel } from "./models-land";
import { buildAirSeaModel } from "./models-airsea";

export interface AnimRig {
  body: THREE.Group;
  legL?: THREE.Group;
  legR?: THREE.Group;
  armL?: THREE.Group;
  armR?: THREE.Group;
  head?: THREE.Group;
  turret?: THREE.Group;
  recoil?: THREE.Group;
  spiderLegs?: THREE.Group[];
  spin?: THREE.Group;
  spin2?: THREE.Group;
  pulse?: THREE.Mesh[];
  flag?: THREE.Mesh;
  crane?: THREE.Group;
  bin?: THREE.Mesh;
  smokePos?: THREE.Vector3;
  altitude?: number;
  shadow?: THREE.Mesh;
  powerGlow?: THREE.Mesh[];
  subMats?: THREE.Material[];
}

export interface BuiltModel {
  topY: number;
  turret: THREE.Group | null;
  rig: Partial<AnimRig>;
  powerGlow?: THREE.Mesh[];
}

export interface EntVis {
  root: THREE.Group;
  turret: THREE.Group | null;
  barBg: THREE.Sprite;
  barFg: THREE.Sprite;
  vetBadge: THREE.Sprite;
  groupTag: THREE.Sprite;
  ring: THREE.Mesh;
  topY: number;
  spin?: THREE.Group;
  bin?: THREE.Mesh;
  rig: AnimRig;
  kind: EntKind;
}

export interface CrateVis {
  root: THREE.Group;
  box: THREE.Group;
  ring: THREE.Mesh;
  beacon: THREE.Mesh;
  kind: CrateKind;
}

// ---------- Shared Overlay & Shadow Assets ----------

const geoRing = new THREE.RingGeometry(0.84, 1.0, 44);
const geoAirShadow = new THREE.CircleGeometry(1, 24);
geoAirShadow.rotateX(-Math.PI / 2);

let airShadowMat: THREE.MeshBasicMaterial | null = null;
function getAirShadowMat(): THREE.MeshBasicMaterial {
  if (!airShadowMat) {
    airShadowMat = new THREE.MeshBasicMaterial({
      map: getContactShadowTex(),
      color: 0xffffff,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });
  }
  return airShadowMat;
}

// ---------- Static-Geometry Merge (draw-call collapse) ----------
//
// Unit bodies ship as dozens of tiny meshes (wheels, antennae, armor plates).
// Anything not inside an animated rig subtree never moves independently, so we
// bake those meshes into one geometry per (material × shadow flags × attribute
// signature) — ~55 draw calls per unit collapse to ~6-10 with identical pixels.

function mergeStaticBody(body: THREE.Group, rig: AnimRig): void {
  // Rig subtrees whose parts all move rigidly with the animated root node can be
  // merged *within* that subtree: bake geometry into the animated node's local
  // space and re-parent the merged mesh to it, so the animation (turret yaw,
  // recoil kick, leg/arm stride, spider-leg wave, crane slew) stays pixel-identical
  // while the dozens of sub-meshes collapse to one draw call per material.
  const rigidRoots = new Set<THREE.Object3D>();
  const looseRoots = new Set<THREE.Object3D>();
  const rigid = (n?: THREE.Object3D | THREE.Object3D[] | null) => {
    if (!n) return;
    if (Array.isArray(n)) for (const x of n) x && rigidRoots.add(x);
    else rigidRoots.add(n);
  };
  const loose = (n?: THREE.Object3D | THREE.Object3D[] | null) => {
    if (!n) return;
    if (Array.isArray(n)) for (const x of n) x && looseRoots.add(x);
    else looseRoots.add(n);
  };
  rigid(rig.turret); rigid(rig.recoil); rigid(rig.spiderLegs);
  rigid(rig.crane);
  rigid(rig.legL); rigid(rig.legR); rigid(rig.armL); rigid(rig.armR);
  rigid(rig.head);
  // spin/spin2 children counter-rotate individually (props, radars) and the glow/
  // pulse/shadow meshes animate their own scale/opacity — never merge those.
  loose(rig.spin); loose(rig.spin2);
  loose(rig.flag); loose(rig.bin);
  loose(rig.pulse); loose(rig.powerGlow); loose(rig.shadow);

  // Nearest animated ancestor wins: a barrel inside rig.recoil inside rig.turret
  // bakes into recoil space (it both yaws with the turret and kicks with recoil).
  // Returns "loose" when the nearest animated root must stay unmerged.
  const anchorFor = (o: THREE.Object3D): THREE.Object3D | "loose" | null => {
    for (let p: THREE.Object3D | null = o; p && p !== body; p = p.parent) {
      if (looseRoots.has(p)) return "loose";
      if (rigidRoots.has(p)) return p;
    }
    return null;
  };

  const subMats = new Set(rig.subMats ?? []);

  // Color-bake path: same-shading standard materials merge into one vertex-colored
  // mesh (the real collapse — part colors differ but shading params cluster).
  const stdMergeMats = new Map<string, THREE.MeshStandardMaterial>();
  const stdBucketKey = (m: THREE.MeshStandardMaterial): string | null => {
    if (m.map || m.emissiveMap || m.normalMap || m.roughnessMap || m.metalnessMap || m.vertexColors) return null;
    return `std|${m.roughness}|${m.metalness}|${m.emissive.getHexString()}|${m.emissiveIntensity}|${m.transparent}|${m.opacity}|${m.side}`;
  };
  const stdMatFor = (key: string): THREE.MeshStandardMaterial => {
    let m = stdMergeMats.get(key);
    if (!m) {
      const p = key.split("|");
      m = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: +p[2],
        metalness: +p[3],
        emissive: new THREE.Color(`#${p[4]}`),
        emissiveIntensity: +p[5],
        transparent: p[6] === "true",
        opacity: +p[7],
        side: +p[8] as THREE.Side,
      });
      stdMergeMats.set(key, m);
    }
    return m;
  };
  const bakeColor = (g: THREE.BufferGeometry, c: THREE.Color): THREE.BufferGeometry => {
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return g;
  };

  interface Bucket {
    mat: THREE.Material;
    anchor: THREE.Object3D;
    anchorInv: THREE.Matrix4;
    castShadow: boolean;
    receiveShadow: boolean;
    renderOrder: number;
    geos: THREE.BufferGeometry[];
    owners: THREE.Mesh[];
  }
  const buckets = new Map<string, Bucket>();

  body.updateMatrixWorld(true);
  const rel = new THREE.Matrix4();

  body.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o instanceof THREE.SkinnedMesh) return;
    if (!o.visible || o.userData.isBar) return;
    const anchorHit = anchorFor(o);
    if (anchorHit === "loose") return;
    const anchor = anchorHit ?? body;
    const g = o.geometry;
    if (!g || (g.morphAttributes && Object.keys(g.morphAttributes).length > 0)) return;
    if (Array.isArray(o.material) || subMats.has(o.material)) return;
    let mat = o.material;
    let g2 = g.clone();
    if (mat instanceof THREE.MeshStandardMaterial) {
      const bkey = stdBucketKey(mat);
      if (bkey) {
        g2 = bakeColor(g2, mat.color);
        mat = stdMatFor(bkey);
      }
    }
    const sig =
      `${anchor.uuid}|${mat.uuid}|${o.castShadow}|${o.receiveShadow}|${o.renderOrder}|` +
      `${g2.index ? 1 : 0}|${Object.keys(g2.attributes).sort().join(",")}`;
    let b = buckets.get(sig);
    if (!b) {
      b = {
        mat,
        anchor,
        anchorInv: new THREE.Matrix4().copy(anchor.matrixWorld).invert(),
        castShadow: o.castShadow,
        receiveShadow: o.receiveShadow,
        renderOrder: o.renderOrder,
        geos: [],
        owners: [],
      };
      buckets.set(sig, b);
    }
    rel.multiplyMatrices(b.anchorInv, o.matrixWorld);
    b.geos.push(g2.applyMatrix4(rel));
    b.owners.push(o);
  });

  for (const b of buckets.values()) {
    const geo = b.geos.length >= 2 ? mergeGeometries(b.geos, false) : null;
    for (const g of b.geos) g.dispose();
    if (!geo) continue;
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    const m = new THREE.Mesh(geo, b.mat);
    m.castShadow = b.castShadow;
    m.receiveShadow = b.receiveShadow;
    m.renderOrder = b.renderOrder;
    b.anchor.add(m);
    for (const o of b.owners) o.parent?.remove(o);
  }
}

export function isAir(kind: EntKind): boolean {
  return (
    kind === "fpvdrone" ||
    kind === "uav" ||
    kind === "shahed" ||
    kind === "ewdrone" ||
    kind === "interceptor" ||
    kind === "chopper" ||
    kind === "a10" ||
    kind === "ac130" ||
    kind === "bomber" ||
    kind === "stealthbomber" ||
    kind === "hypersonic" ||
    kind === "zeppelin"
  );
}

export function isSea(kind: EntKind): boolean {
  return (
    kind === "usv" ||
    kind === "gunboat" ||
    kind === "destroyer" ||
    kind === "sub" ||
    kind === "dreadnought" ||
    kind === "carrier"
  );
}

const AIR_SHADOW_SIZE: Partial<Record<EntKind, [number, number]>> = {
  fpvdrone: [0.62, 0.62],
  uav: [1.18, 0.72],
  shahed: [0.88, 0.96],
  ewdrone: [1.08, 0.96],
  interceptor: [0.95, 1.1],
  chopper: [0.98, 1.15],
  a10: [1.24, 1.06],
  ac130: [1.68, 1.45],
  bomber: [1.45, 1.18],
  stealthbomber: [1.56, 1.12],
  hypersonic: [0.76, 1.38],
  zeppelin: [1.22, 1.85],
};

function makeSprite(w: number, h: number, hex: string, opacity: number): THREE.Sprite {
  const m = new THREE.SpriteMaterial({ color: hex, transparent: true, opacity, depthTest: false });
  const s = new THREE.Sprite(m);
  s.scale.set(w, h, 1);
  s.renderOrder = 20;
  return s;
}

function makeBar(w: number): { bg: THREE.Sprite; fg: THREE.Sprite } {
  const bg = makeSprite(w, 0.12, "#090e14", 0.85);
  const fg = makeSprite(w - 0.05, 0.065, "#26e050", 0.95);
  fg.userData.w = w - 0.05;
  bg.userData.isBar = true;
  fg.userData.isBar = true;
  return { bg, fg };
}

// ---------- Veterancy Star Badge Sprites ----------

const vetTexCache = new Map<number, THREE.CanvasTexture>();

function getVetTexture(rank: number): THREE.CanvasTexture {
  const r = Math.max(1, Math.min(3, rank | 0));
  const cached = vetTexCache.get(r);
  if (cached) return cached;

  const W = 128;
  const H = 48;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, W, H);

  const stars = r === 1 ? "★" : r === 2 ? "★★" : "★★★";
  const pillW = r === 1 ? 42 : r === 2 ? 72 : 104;
  const px = (W - pillW) / 2;

  ctx.fillStyle = r === 3 ? "rgba(44, 10, 10, 0.86)" : "rgba(10, 14, 20, 0.82)";
  ctx.strokeStyle = r === 3 ? "#ff5238" : r === 2 ? "#ffd040" : "#d8c47a";
  ctx.lineWidth = r === 3 ? 2.5 : 2;
  ctx.beginPath();
  ctx.roundRect(px, 7, pillW, 34, 8);
  ctx.fill();
  ctx.stroke();

  ctx.font = "900 24px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = r === 3 ? "#ff3820" : r === 2 ? "#ffae00" : "#e8d890";
  ctx.shadowBlur = r === 3 ? 12 : r === 2 ? 8 : 4;
  ctx.fillStyle = r === 3 ? "#ffe066" : r === 2 ? "#ffd83a" : "#ece2b8";
  ctx.fillText(stars, W / 2, H / 2 + 1);

  if (r === 3) {
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "#ff3a1f";
    ctx.lineWidth = 1.2;
    ctx.strokeText(stars, W / 2, H / 2 + 1);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  vetTexCache.set(r, tex);
  return tex;
}

export function setVetBadge(vis: EntVis, vet: number): void {
  const rank = Math.max(0, Math.min(3, vet | 0));
  if (vis.vetBadge.userData.vetRank === rank) return;
  vis.vetBadge.userData.vetRank = rank;
  if (rank <= 0) {
    vis.vetBadge.visible = false;
    return;
  }
  const mat = vis.vetBadge.material as THREE.SpriteMaterial;
  mat.map = getVetTexture(rank);
  mat.needsUpdate = true;
  const sc = rank === 3 ? 1.15 : 1.0;
  vis.vetBadge.scale.set(0.76 * sc, 0.285 * sc, 1);
  vis.vetBadge.visible = true;
}

// ---------- Control-Group Digit Badges ----------

const grpTexCache = new Map<number, THREE.CanvasTexture>();

function getGroupTexture(n: number): THREE.CanvasTexture {
  const cached = grpTexCache.get(n);
  if (cached) return cached;
  const W = 48, H = 48;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "rgba(10, 14, 20, 0.85)";
  ctx.strokeStyle = "#6ec1ff";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(2, 2, W - 4, H - 4, 10);
  ctx.fill();
  ctx.stroke();
  ctx.font = "900 30px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#9fd8ff";
  ctx.fillText(String(n), W / 2, H / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  grpTexCache.set(n, tex);
  return tex;
}

export function setGroupTag(vis: EntVis, n: number): void {
  const tag = vis.groupTag;
  if (!tag) return;
  if (tag.userData.grp === n) return;
  tag.userData.grp = n;
  if (n <= 0) { tag.visible = false; return; }
  (tag.material as THREE.SpriteMaterial).map = getGroupTexture(n);
  tag.material.needsUpdate = true;
  tag.visible = true;
}

// ---------- Main Entity Visual Orchestrator ----------

// topY for instanced-swarm kinds — harvested from the authored models so the
// lite EntVis (no body meshes, only HUD overlays) places bars identically
const LITE_TOP_Y: Partial<Record<EntKind, number>> = {
  fpvdrone: 2.99,
  shahed: 3.63,
  usv: 0.62,
  infantry: 1.0,
  engineer: 0.94,
  rocket: 1.08,
};

export function makeEntVis(kind: EntKind, colorHex: string, _scene?: THREE.Scene, lite = false): EntVis {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // lite: instanced kinds render through the InstancedMesh pool — their body's
  // full mesh rig is never added to the scene, so skip building it entirely
  const built: BuiltModel = lite
    ? { topY: LITE_TOP_Y[kind] ?? 1.0, turret: null, rig: {} }
    : buildAirSeaModel(kind, colorHex, body) ??
      buildLandModel(kind, colorHex, body) ?? {
        topY: 1.0,
        turret: null,
        rig: {},
      };

  const { topY, turret } = built;
  const partialRig = built.rig;
  const powerGlow = built.powerGlow ?? partialRig.powerGlow;

  const airUnit = isAir(kind) || partialRig.altitude !== undefined;
  const seaUnit = isSea(kind);

  // Clickable soft air-shadow disc on ground directly beneath hovering aircraft
  let shadow = partialRig.shadow;
  if (airUnit && !shadow && !lite) {
    const [rx, rz] = AIR_SHADOW_SIZE[kind] ?? [0.95, 1.05];
    const sh = new THREE.Mesh(geoAirShadow, getAirShadowMat());
    sh.scale.set(rx, 1, rz);
    sh.position.y = 0.042;
    sh.renderOrder = 3;
    sh.userData.isBar = true;
    sh.userData.isAirShadow = true;
    sh.userData.baseShadowScale = sh.scale.clone();
    root.add(sh);
    shadow = sh;
  }

  // Health bar sprites (tagged isBar so icon renderer & raycaster ignore them)
  const barW = isBuildingKind(kind)
    ? Math.max(BUILDINGS[kind].w, 1.4)
    : kind === "carrier"
      ? 1.68
      : kind === "dreadnought" || kind === "zeppelin" || kind === "ac130"
        ? 1.55
        : kind === "destroyer" || kind === "bomber" || kind === "stealthbomber"
          ? 1.24
          : kind === "railtank" || kind === "heavy" || kind === "himars" || kind === "a10"
            ? 1.12
            : kind === "fpvdrone"
              ? 0.78
              : kind === "usv"
                ? 0.84
                : 0.96;
  const { bg, fg } = makeBar(barW);
  bg.position.y = topY + 0.38;
  fg.position.y = topY + 0.38;
  // HP bar sprites are logical overlay records only: Renderer compacts them into
  // one instanced billboard batch each frame instead of paying two scene-graph
  // sprite draw calls per bar. They intentionally stay out of `root`.

  // Veterancy badge sprite (centered above HP bar; hidden until rank >= 1)
  const vetMat = new THREE.SpriteMaterial({ transparent: true, opacity: 0.98, depthTest: false });
  const vetBadge = new THREE.Sprite(vetMat);
  vetBadge.position.set(0, topY + 0.58, 0);
  vetBadge.scale.set(0.76, 0.285, 1);
  vetBadge.renderOrder = 22;
  vetBadge.visible = false;
  vetBadge.userData.isBar = true;
  vetBadge.userData.vetRank = 0;
  // Logical overlay state only; Renderer batches textured badges too.

  // Control-group digit badge (left of vet badge; hidden until grouped)
  const grpMat = new THREE.SpriteMaterial({ transparent: true, opacity: 0.95, depthTest: false });
  const groupTag = new THREE.Sprite(grpMat);
  groupTag.position.set(-0.62, topY + 0.58, 0);
  groupTag.scale.set(0.3, 0.3, 1);
  groupTag.renderOrder = 22;
  groupTag.visible = false;
  groupTag.userData.isBar = true;
  groupTag.userData.grp = 0;
  // Logical overlay state only; Renderer batches textured badges too.

  // Selection ring on ground/water directly beneath unit
  const ringSize = isBuildingKind(kind)
    ? Math.max(BUILDINGS[kind].w, BUILDINGS[kind].h) * 0.78
    : kind === "ac130"
      ? 1.65
      : kind === "carrier"
        ? 1.58
        : kind === "dreadnought"
          ? 1.42
          : kind === "zeppelin"
            ? 1.28
            : kind === "destroyer"
              ? 1.12
              : kind === "stealthbomber"
                ? 1.06
                : kind === "bomber" || kind === "a10"
                  ? 0.98
                  : kind === "sub" || kind === "railtank" || kind === "heavy"
                    ? 0.9
                    : kind === "fpvdrone"
                      ? 0.62
                      : kind === "usv"
                        ? 0.68
                        : seaUnit || airUnit || kind === "himars"
                          ? 0.82
                          : 0.68;
  const ring = new THREE.Mesh(
    geoRing,
    new THREE.MeshBasicMaterial({
      color: 0x5ae8ff,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.scale.setScalar(ringSize);
  ring.position.y = airUnit ? 0.06 : 0.05;
  ring.visible = false;
  ring.userData.isBar = true;
  root.add(ring);

  // Capture authored base scales for pulsing glow elements
  if (partialRig.pulse) {
    for (const p of partialRig.pulse) {
      if (!p.userData.baseScale) p.userData.baseScale = p.scale.clone();
    }
  }

  const rig: AnimRig = {
    ...partialRig,
    body,
    turret: turret ?? partialRig.turret,
    shadow,
    powerGlow: powerGlow && powerGlow.length ? powerGlow : undefined,
  };

  // Sub-detail parts (wheels, antennae, tips) can't cast a readable shadow — disabling
  // them trims ~40-60% of the shadow-pass draw calls per unit for free.
  {
    root.updateMatrixWorld(true);
    const ws = new THREE.Vector3();
    body.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || !o.castShadow || !o.geometry.boundingSphere) return;
      o.getWorldScale(ws);
      if (o.geometry.boundingSphere.radius * Math.max(Math.abs(ws.x), Math.abs(ws.y), Math.abs(ws.z)) < 0.2)
        o.castShadow = false;
    });
  }

  if (!lite) mergeStaticBody(body, rig);

  return {
    root,
    turret,
    barBg: bg,
    barFg: fg,
    vetBadge,
    groupTag,
    ring,
    topY,
    spin: rig.spin,
    bin: rig.bin,
    rig,
    kind,
  };
}

// ---------- Battlefield Supply Crate 3D Model ----------

const CRATE_ACCENTS: Record<CrateKind, string> = {
  cash: "#ffbe2e",
  vet: "#3ce8ff",
  heal: "#34e870",
  unit: "#ff5436",
};

const geoCrateHull = new RoundedBoxGeometry(0.68, 0.56, 0.68, 2, 0.06);
const geoCrateBand = new RoundedBoxGeometry(0.73, 0.14, 0.73, 2, 0.025);
const geoCratePost = new RoundedBoxGeometry(0.11, 0.62, 0.11, 2, 0.02);
const geoCrateLid = new RoundedBoxGeometry(0.56, 0.08, 0.56, 2, 0.02);
const geoCrateCore = new THREE.OctahedronGeometry(0.12, 0);
const geoCrateBeacon = new THREE.CylinderGeometry(0.12, 0.34, 1.35, 12, 1, true);

export function makeCrateVis(kind: CrateKind): CrateVis {
  const accent = CRATE_ACCENTS[kind] ?? "#ffbe2e";
  const accentHex = new THREE.Color(accent).getHex();
  const root = new THREE.Group();

  const crateBox = new THREE.Group();
  crateBox.position.y = 0.48;
  root.add(crateBox);

  const hull = new THREE.Mesh(geoCrateHull, getChassisMat("#2a3440", 0.38, 0.62));
  hull.castShadow = true;
  hull.receiveShadow = true;
  crateBox.add(hull);

  const band = new THREE.Mesh(geoCrateBand, getGlowMat(accent, 1.35));
  crateBox.add(band);

  const steelMat = getChassisMat("#6d7d8c", 0.32, 0.72);
  for (const [cx, cz] of [
    [-0.3, -0.3],
    [0.3, -0.3],
    [-0.3, 0.3],
    [0.3, 0.3],
  ]) {
    const post = new THREE.Mesh(geoCratePost, steelMat);
    post.position.set(cx, 0, cz);
    post.castShadow = true;
    crateBox.add(post);
  }

  const lid = new THREE.Mesh(geoCrateLid, getChassisMat("#181e24", 0.48, 0.68));
  lid.position.y = 0.31;
  crateBox.add(lid);

  const topCore = new THREE.Mesh(geoCrateCore, getGlowMat(accent, 1.55));
  topCore.position.y = 0.41;
  crateBox.add(topCore);

  const ring = new THREE.Mesh(
    geoRing,
    new THREE.MeshBasicMaterial({
      color: accentHex,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  ring.scale.setScalar(0.72);
  root.add(ring);

  const beacon = new THREE.Mesh(
    geoCrateBeacon,
    new THREE.MeshBasicMaterial({
      color: accentHex,
      transparent: true,
      opacity: 0.2,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  beacon.position.y = 0.72;
  root.add(beacon);

  return { root, box: crateBox, ring, beacon, kind };
}

export function tagEntity(root: THREE.Group, id: number) {
  root.userData.entityId = id;
  root.traverse((o) => (o.userData.entityId = id));
}

export function applyFacing(node: THREE.Object3D, d: number) {
  // Models are built facing +Z; server d = atan2(dy, dx) in map coords (x -> +X, y -> +Z)
  node.rotation.y = Math.PI / 2 - d;
}

// Flat ground ring marking a defensive structure's firing range (radius in tiles)
export function makeRangeRing(radius: number, color = 0x5ae8ff): THREE.Mesh {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(0.05, radius - 0.14), radius, 72),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  ring.userData.isBar = true; // overlay: exempt from rig animation like the selection ring
  return ring;
}

export function makePlacementGhost(kind: EntKind): THREE.Mesh {
  const d = isBuildingKind(kind) ? BUILDINGS[kind] : { w: 1, h: 1 };
  const slabMat = new THREE.MeshBasicMaterial({
    color: 0x22e060,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(d.w, 0.22, d.h), slabMat);
  slab.position.y = 0.13;

  const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(d.w, 0.85, d.h));
  const wireMat = new THREE.LineBasicMaterial({ color: 0x45ff88, transparent: true, opacity: 0.92 });
  const wire = new THREE.LineSegments(edges, wireMat);
  wire.position.y = 0.32;
  slab.add(wire);

  const rng = isBuildingKind(kind) ? (BUILDINGS[kind].range ?? 0) : 0;
  if (rng > 0) {
    const rr = makeRangeRing(rng, 0xffffff);
    rr.position.y = -0.07; // slab-local: lands ~0.06 above ground in world space
    slab.add(rr);
  }

  slab.userData.wireMat = wireMat;
  return slab;
}

export function setGhostColor(ghost: THREE.Mesh, ok: boolean) {
  (ghost.material as THREE.MeshBasicMaterial).color.setHex(ok ? 0x22e060 : 0xf03030);
  const wire = ghost.userData.wireMat as THREE.LineBasicMaterial | undefined;
  if (wire) wire.color.setHex(ok ? 0x55ff90 : 0xffc8c8);
}
