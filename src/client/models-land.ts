import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { EntKind } from "./util";
import type { AnimRig } from "./models";
import {
  getChassisMat,
  getAccentMat,
  getGlassMat,
  getGlowMat,
  getConcreteMat,
  getTreadMat,
  getContactShadowTex,
} from "./textures";

export interface BuiltModel {
  topY: number;
  turret: THREE.Group | null;
  rig: Partial<AnimRig>;
  powerGlow?: THREE.Mesh[];
}

// ---------- Shared 75/25 Military Palette Constants ----------
const CERAMIC = "#46515d"; // primary weathered ceramic-steel armor
const CERAMIC_LT = "#5e6b78"; // lighter machined titanium / steel trim
const CERAMIC_DK = "#343d47"; // darker structural armor plate
const GUNMETAL = "#242b33"; // deep gunmetal barrels, frames, dark housings
const GRAPHITE = "#181d23"; // rubber tires, deep joints, recessed vents
const HAZARD = "#cc9624"; // industrial safety yellow-gold (cranes, engineer, scoops)
const COPPER = "#b97744"; // copper-chrome induction coils & manifolds
const GOLD_TRIM = "#d4a432"; // MKII heavy command trim

const CYAN_GLOW = "#48d8ff";
const AMBER_GLOW = "#ffaa2c";
const HEAT_GLOW = "#ff6c2c";
const WHITE_GLOW = "#d8f4ff";
const HEAL_GLOW = "#3ce080";

// ---------- Shared Sculpted & Beveled Geometries ----------
const geoRBox = new RoundedBoxGeometry(1, 1, 1, 2, 0.085);
const geoRBoxSharp = new RoundedBoxGeometry(1, 1, 1, 2, 0.045);
const geoRBoxSoft = new RoundedBoxGeometry(1, 1, 1, 3, 0.16);
const geoCyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 16);
const geoCylOct = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
const geoCylTaper = new THREE.CylinderGeometry(0.36, 0.52, 1, 18);
const geoSph = new THREE.SphereGeometry(0.5, 16, 12);
const geoCap = new THREE.CapsuleGeometry(0.25, 0.5, 5, 10);
const geoCone = new THREE.ConeGeometry(0.5, 1, 12);
const geoTorus = new THREE.TorusGeometry(0.5, 0.08, 10, 28);
const geoTorusThin = new THREE.TorusGeometry(0.5, 0.046, 8, 28);

const geoContactDisc = new THREE.PlaneGeometry(2, 2);
geoContactDisc.rotateX(-Math.PI / 2);

// Sloped futuristic military hull (extruded in XY, centered, rotated so +X -> +Z forward)
function makeSlopedHullGeo(len: number, height: number, width: number, bevel = 0.045): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const hl = len / 2;
  const hh = height / 2;
  s.moveTo(-hl * 0.94, -hh);
  s.lineTo(hl * 0.82, -hh);
  s.lineTo(hl, -hh * 0.18);
  s.lineTo(hl * 0.64, hh);
  s.lineTo(-hl * 0.78, hh);
  s.lineTo(-hl, hh * 0.28);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: width,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
  });
  g.center();
  g.rotateY(-Math.PI / 2);
  return g;
}

// Faceted angular wedge turret (narrower armored prow pointing toward +Z!)
function makeFacetedTurretGeo(w: number, h: number, l: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const hw = w / 2;
  const hl = l / 2;
  s.moveTo(-hw * 0.94, -hl);
  s.lineTo(hw * 0.94, -hl);
  s.lineTo(hw, -hl * 0.15);
  s.lineTo(hw * 0.72, hl * 0.78);
  s.lineTo(hw * 0.44, hl);
  s.lineTo(-hw * 0.44, hl);
  s.lineTo(-hw * 0.72, hl * 0.78);
  s.lineTo(-hw, -hl * 0.15);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: h,
    bevelEnabled: true,
    bevelThickness: 0.048,
    bevelSize: 0.042,
    bevelSegments: 2,
  });
  g.center();
  // Rotate +PI/2 around X so +Y of 2D shape maps directly to +Z (forward)!
  g.rotateX(Math.PI / 2);
  return g;
}

// Sloped armored tactical truck / harvester cab (extruded side profile, +X -> +Z)
function makeSlopedCabGeo(len: number, height: number, width: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const hl = len / 2;
  const hh = height / 2;
  s.moveTo(-hl, -hh);
  s.lineTo(hl, -hh);
  s.lineTo(hl, -hh * 0.08);
  s.lineTo(hl * 0.56, hh);
  s.lineTo(-hl * 0.88, hh);
  s.lineTo(-hl, hh * 0.72);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: width,
    bevelEnabled: true,
    bevelThickness: 0.036,
    bevelSize: 0.032,
    bevelSegments: 2,
  });
  g.center();
  g.rotateY(-Math.PI / 2);
  return g;
}

// Angular stealth cyber-arachnid carapace (+Y -> +Z forward)
function makeSpiderCarapaceGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0.34);
  s.lineTo(0.24, 0.16);
  s.lineTo(0.28, -0.14);
  s.lineTo(0.16, -0.34);
  s.lineTo(-0.16, -0.34);
  s.lineTo(-0.28, -0.14);
  s.lineTo(-0.24, 0.16);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.16,
    bevelEnabled: true,
    bevelThickness: 0.055,
    bevelSize: 0.045,
    bevelSegments: 2,
  });
  g.center();
  g.rotateX(Math.PI / 2);
  return g;
}

// Authentic curved oil-derrick pumpjack horsehead arc (+X -> +Z forward)
function makeHorseheadGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.1, -0.24);
  s.lineTo(0.05, -0.26);
  s.quadraticCurveTo(0.24, -0.04, 0.18, 0.22);
  s.lineTo(-0.08, 0.2);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.18,
    bevelEnabled: true,
    bevelThickness: 0.022,
    bevelSize: 0.02,
    bevelSegments: 2,
  });
  g.center();
  g.rotateY(-Math.PI / 2);
  return g;
}

// True curved hyperbolic cooling tower (LatheGeometry with thick recessed rim throat)
function makeCoolingTowerGeo(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const steps = 14;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Hyperbolic neck pinching smoothly around t = 0.72 and flaring gently at crown
    const r = 0.52 - 0.19 * Math.sin(t * Math.PI * 0.76) + 0.055 * Math.pow(Math.max(0, t - 0.55) / 0.45, 2);
    pts.push(new THREE.Vector2(r, t));
  }
  // Thick top rim lip & recessed interior cooling throat
  pts.push(new THREE.Vector2(0.39, 1.015));
  pts.push(new THREE.Vector2(0.32, 1.0));
  pts.push(new THREE.Vector2(0.29, 0.76));
  pts.push(new THREE.Vector2(0.002, 0.74));
  return new THREE.LatheGeometry(pts, 24);
}

// Solid double-walled curved concave parabolic dish (LatheGeometry, y=0 at bottom apex)
function makeParabolicDishGeo(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(0.002, -0.05),
    new THREE.Vector2(0.16, -0.03),
    new THREE.Vector2(0.32, 0.035),
    new THREE.Vector2(0.46, 0.14),
    new THREE.Vector2(0.51, 0.22),
    new THREE.Vector2(0.495, 0.255),
    new THREE.Vector2(0.455, 0.24),
    new THREE.Vector2(0.34, 0.125),
    new THREE.Vector2(0.18, 0.042),
    new THREE.Vector2(0.002, 0.015),
  ];
  return new THREE.LatheGeometry(pts, 28);
}

// Industrial pressurized refinery / derrick storage silo (LatheGeometry, base y=0, height=1)
function makeSiloGeo(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(0.002, 0.0),
    new THREE.Vector2(0.53, 0.0),
    new THREE.Vector2(0.52, 0.08),
    new THREE.Vector2(0.47, 0.14),
    new THREE.Vector2(0.47, 0.44),
    new THREE.Vector2(0.5, 0.47),
    new THREE.Vector2(0.5, 0.51),
    new THREE.Vector2(0.46, 0.54),
    new THREE.Vector2(0.46, 0.8),
    new THREE.Vector2(0.42, 0.88),
    new THREE.Vector2(0.28, 0.96),
    new THREE.Vector2(0.12, 0.995),
    new THREE.Vector2(0.002, 1.0),
  ];
  return new THREE.LatheGeometry(pts, 22);
}

// High-tech mineral enrichment centrifuge vessel (LatheGeometry, base y=0, height=1)
function makeCentrifugeGeo(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(0.002, 0.0),
    new THREE.Vector2(0.52, 0.0),
    new THREE.Vector2(0.49, 0.1),
    new THREE.Vector2(0.41, 0.22),
    new THREE.Vector2(0.45, 0.48),
    new THREE.Vector2(0.36, 0.68),
    new THREE.Vector2(0.42, 0.82),
    new THREE.Vector2(0.32, 0.94),
    new THREE.Vector2(0.16, 1.0),
    new THREE.Vector2(0.002, 1.0),
  ];
  return new THREE.LatheGeometry(pts, 22);
}

// Aerodynamic ogive missile warhead cone (LatheGeometry, base y=-0.5, tip y=0.5)
function makeMissileConeGeo(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const r = Math.max(0.002, 0.5 * Math.pow(1 - t, 0.72));
    pts.push(new THREE.Vector2(r, t - 0.5));
  }
  return new THREE.LatheGeometry(pts, 12);
}

// Orbital Ion Uplink curved emitter aperture collar (LatheGeometry)
function makeIonApertureGeo(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(0.56, 0.0),
    new THREE.Vector2(0.52, 0.26),
    new THREE.Vector2(0.42, 0.62),
    new THREE.Vector2(0.48, 0.92),
    new THREE.Vector2(0.44, 1.0),
    new THREE.Vector2(0.34, 0.96),
    new THREE.Vector2(0.32, 0.64),
    new THREE.Vector2(0.002, 0.6),
  ];
  return new THREE.LatheGeometry(pts, 24);
}

// Billowing faction flag anchored at x = 0 so flag.rotation.y waves smoothly from the mast
function makeFlagGeo(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(0.5, 0.26, 0.026, 8, 2, 1);
  g.translate(0.25, 0, 0);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const t = x / 0.5;
    const wave = Math.sin(t * Math.PI * 1.65) * 0.036 * t;
    // Slight swallowtail taper toward fly end
    const yScale = 1 - t * 0.08;
    pos.setY(i, y * yScale);
    pos.setZ(i, pos.getZ(i) + wave);
  }
  g.computeVertexNormals();
  return g;
}

// Faceted golden-amber ore crystal mound authored with flat base at y = 0 and peak at y = 0.42
function makeOreLoadGeo(w: number, h: number, d: number): THREE.BufferGeometry {
  const base = new THREE.BoxGeometry(w, h, d, 4, 2, 4);
  base.translate(0, h / 2, 0);
  const pos = base.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (y > 0.02) {
      const nx = x / (w * 0.5);
      const nz = z / (d * 0.5);
      const edge = Math.max(Math.abs(nx), Math.abs(nz));
      const dome = Math.max(0.28, 1 - edge * edge * 0.52);
      const crystal = Math.sin(x * 11.3 + z * 7.7) * 0.07 + Math.cos(x * 8.1 - z * 12.9) * 0.055;
      const topFactor = y / h;
      pos.setY(i, Math.max(0.05, y * dome + crystal * topFactor));
      // Taper slightly inward near peak for heaped crystal pile look
      const shrink = 1 - topFactor * 0.14;
      pos.setX(i, x * shrink);
      pos.setZ(i, z * shrink);
    }
  }
  const faceted = base.toNonIndexed();
  faceted.computeVertexNormals();
  base.dispose();
  return faceted;
}

// Sculpted geodesic-style radome shell for Iron Dome (LatheGeometry, base y=0, height=1, radius=0.5)
function makeRadomeGeo(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const steps = 12;
  pts.push(new THREE.Vector2(0.5, 0.0));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const ang = t * (Math.PI / 2);
    const r = Math.max(0.002, Math.cos(ang) * 0.5);
    const y = 0.08 + Math.sin(ang) * 0.92;
    pts.push(new THREE.Vector2(r, y));
  }
  return new THREE.LatheGeometry(pts, 12);
}

// Tall sleek futuristic faceted dark-titanium spire for Helios Laser Battery (LatheGeometry, 6-sided)
function makeLaserSpireGeo(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(0.002, 0.0),
    new THREE.Vector2(0.54, 0.0),
    new THREE.Vector2(0.46, 0.16),
    new THREE.Vector2(0.38, 0.36),
    new THREE.Vector2(0.42, 0.4),
    new THREE.Vector2(0.33, 0.44),
    new THREE.Vector2(0.24, 0.74),
    new THREE.Vector2(0.28, 0.79),
    new THREE.Vector2(0.2, 0.84),
    new THREE.Vector2(0.16, 1.0),
    new THREE.Vector2(0.002, 1.0),
  ];
  return new THREE.LatheGeometry(pts, 6);
}

// Futuristic clean-energy tokamak containment dome crown (LatheGeometry, base y=0, height=1)
function makeFusionDomeGeo(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const steps = 14;
  pts.push(new THREE.Vector2(0.52, 0.0));
  pts.push(new THREE.Vector2(0.5, 0.14));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const ang = t * (Math.PI / 2);
    const r = Math.max(0.002, Math.cos(ang) * 0.48);
    const y = 0.14 + Math.sin(ang) * 0.86;
    pts.push(new THREE.Vector2(r, y));
  }
  return new THREE.LatheGeometry(pts, 24);
}

const geoTankHull = makeSlopedHullGeo(1.78, 0.36, 0.98, 0.042);
const geoHeavyHull = makeSlopedHullGeo(2.14, 0.44, 1.28, 0.05);
const geoRailHull = makeSlopedHullGeo(2.08, 0.38, 1.16, 0.044);
const geoTankTurret = makeFacetedTurretGeo(0.76, 0.27, 0.98);
const geoHeavyTurret = makeFacetedTurretGeo(1.02, 0.33, 1.2);
const geoRailTurret = makeFacetedTurretGeo(0.92, 0.24, 1.22);
const geoSentryPod = makeFacetedTurretGeo(0.58, 0.25, 0.78);
const geoArtyCab = makeSlopedCabGeo(0.62, 0.44, 0.84);
const geoHimarsCab = makeSlopedCabGeo(0.68, 0.46, 0.86);
const geoHarvesterCab = makeSlopedCabGeo(0.74, 0.58, 0.96);
const geoSpiderCarapace = makeSpiderCarapaceGeo();
const geoHorsehead = makeHorseheadGeo();
const geoCoolingTower = makeCoolingTowerGeo();
const geoParabolicDish = makeParabolicDishGeo();
const geoSilo = makeSiloGeo();
const geoCentrifuge = makeCentrifugeGeo();
const geoMissileCone = makeMissileConeGeo();
const geoIonAperture = makeIonApertureGeo();
const geoRadome = makeRadomeGeo();
const geoLaserSpire = makeLaserSpireGeo();
const geoFusionDome = makeFusionDomeGeo();
const geoFlag = makeFlagGeo();
const geoOreLoad = makeOreLoadGeo(1.02, 0.42, 0.92);
const geoCoalHeap = makeOreLoadGeo(0.86, 0.46, 0.86);
const geoFusionPlasma = new THREE.TorusGeometry(0.68, 0.135, 14, 36);
const geoFusionPlasmaCore = new THREE.TorusGeometry(0.68, 0.062, 10, 32);
const geoSatOrbitTrack = new THREE.TorusGeometry(0.64, 0.018, 8, 36);

// ---------- Lazily Cached Contact Shadow Material ----------
let contactShadowMatCache: THREE.MeshBasicMaterial | null = null;
function getContactShadowMat(): THREE.MeshBasicMaterial {
  if (!contactShadowMatCache) {
    contactShadowMatCache = new THREE.MeshBasicMaterial({
      map: getContactShadowTex(),
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
  }
  return contactShadowMatCache;
}

// ---------- Mesh Helper Primitives ----------
function meshOf(geo: THREE.BufferGeometry, mat: THREE.Material, cast = true, receive = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}

function rbox(w: number, h: number, d: number, mat: THREE.Material, sharp = false): THREE.Mesh {
  const m = meshOf(sharp ? geoRBoxSharp : geoRBox, mat);
  m.scale.set(w, h, d);
  return m;
}

function softBox(w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh {
  const m = meshOf(geoRBoxSoft, mat);
  m.scale.set(w, h, d);
  return m;
}

function cyl(d: number, h: number, mat: THREE.Material, style: "round" | "oct" | "taper" = "round"): THREE.Mesh {
  const g = style === "oct" ? geoCylOct : style === "taper" ? geoCylTaper : geoCyl;
  const m = meshOf(g, mat);
  m.scale.set(d, h, d);
  return m;
}

function sph(d: number, mat: THREE.Material, isGlow = false): THREE.Mesh {
  const m = meshOf(geoSph, mat, !isGlow, !isGlow);
  m.scale.setScalar(d);
  return m;
}

function cone(d: number, h: number, mat: THREE.Material, isGlow = false): THREE.Mesh {
  const m = meshOf(geoCone, mat, !isGlow, !isGlow);
  m.scale.set(d, h, d);
  return m;
}

function torus(d: number, mat: THREE.Material, thin = false): THREE.Mesh {
  const m = meshOf(thin ? geoTorusThin : geoTorus, mat);
  m.scale.setScalar(d);
  return m;
}

function cap(sx: number, sy: number, sz: number, mat: THREE.Material): THREE.Mesh {
  const m = meshOf(geoCap, mat);
  m.scale.set(sx, sy, sz);
  return m;
}

function addContactShadow(parent: THREE.Group, rx: number, rz: number): void {
  const disc = new THREE.Mesh(geoContactDisc, getContactShadowMat());
  disc.scale.set(rx, 1, rz);
  disc.position.y = 0.014;
  disc.renderOrder = 2;
  disc.userData.isBar = true;
  parent.add(disc);
}

// Chamfered armored concrete foundation with recessed dark steel footing, corner bollards & contact AO
function foundationPad(w: number, d: number, colorHex: string, h = 0.22): THREE.Group {
  const g = new THREE.Group();
  const matDark = getChassisMat(GRAPHITE, 0.62, 0.5);
  const matRim = getChassisMat(CERAMIC_DK, 0.48, 0.55);
  const matAcc = getAccentMat(colorHex);

  addContactShadow(g, w * 0.62, d * 0.62);

  // Dark recessed anchoring collar
  const skirt = rbox(w - 0.02, 0.07, d - 0.02, matDark, true);
  skirt.position.y = 0.035;
  skirt.castShadow = false;
  g.add(skirt);

  // Chamfered concrete slab
  const slab = rbox(w - 0.08, h, d - 0.08, getConcreteMat(), true);
  slab.position.y = h / 2 + 0.01;
  g.add(slab);

  // Armored corner anchor bollards
  const cx = w * 0.5 - 0.14;
  const cz = d * 0.5 - 0.14;
  for (const [bx, bz] of [
    [-cx, -cz],
    [cx, -cz],
    [-cx, cz],
    [cx, cz],
  ]) {
    const post = rbox(0.18, h + 0.05, 0.18, matRim, true);
    post.position.set(bx, (h + 0.05) / 2, bz);
    g.add(post);
  }

  // Subtle military faction ID strips along front & rear kerbs
  const stripLen = Math.max(0.36, w * 0.34);
  for (const sz of [-1, 1]) {
    const strip = rbox(stripLen, 0.035, 0.06, matAcc, true);
    strip.position.set(0, h + 0.012, sz * (d * 0.5 - 0.09));
    g.add(strip);
  }

  return g;
}

function trackPowerGlow(m: THREE.Mesh, list: THREE.Mesh[]): void {
  const cloned = (m.material as THREE.Material).clone();
  m.material = cloned;
  if (cloned instanceof THREE.MeshBasicMaterial) {
    m.userData.origColor = cloned.color.clone();
  } else if (cloned instanceof THREE.MeshStandardMaterial) {
    m.userData.origColor = cloned.color.clone();
    m.userData.origEmissive = cloned.emissive.clone();
  }
  list.push(m);
}

// ---------- Articulated Futuristic Armored Soldier Builder ----------
function buildSoldierRig(
  body: THREE.Group,
  colorHex: string,
  role: "infantry" | "engineer" | "rocket",
  pulse: THREE.Mesh[],
): Partial<AnimRig> {
  const matCer = getChassisMat(CERAMIC, 0.44, 0.55);
  const matLt = getChassisMat(CERAMIC_LT, 0.38, 0.65);
  const matDk = getChassisMat(CERAMIC_DK, 0.5, 0.52);
  const matGun = getChassisMat(GUNMETAL, 0.46, 0.66);
  const matGraph = getChassisMat(GRAPHITE, 0.64, 0.42);
  const matHaz = getChassisMat(HAZARD, 0.42, 0.35);
  const matAcc = getAccentMat(colorHex);
  const matVisor = getGlassMat(role === "rocket" ? "#e89236" : "#44c2f0");

  const scale = role === "engineer" ? 0.98 : role === "rocket" ? 1.06 : 1.04;
  body.scale.setScalar(scale);

  addContactShadow(body, role === "rocket" ? 0.4 : 0.35, role === "rocket" ? 0.4 : 0.35);

  // Sculpted armored pelvis & tactical utility belt
  const pelvis = rbox(0.28, 0.1, 0.19, matGun, true);
  pelvis.position.set(0, 0.34, 0);
  body.add(pelvis);
  for (const px of [-0.145, 0.145]) {
    const pouch = rbox(0.05, 0.08, 0.09, matDk, true);
    pouch.position.set(px, 0.34, 0.02);
    body.add(pouch);
  }

  // Articulated hip-pivoted armored legs (legL, legR) with knee pads & heavy boots
  const makeLeg = (sx: number) => {
    const hip = new THREE.Group();
    hip.position.set(sx, 0.33, 0);
    // Undersuit thigh + armored thigh plate
    const thigh = cap(0.22, 0.22, 0.22, matGraph);
    thigh.position.set(0, -0.1, 0);
    hip.add(thigh);
    const thighArmor = softBox(0.115, 0.14, 0.125, matCer);
    thighArmor.position.set(sx > 0 ? 0.01 : -0.01, -0.09, 0.01);
    hip.add(thighArmor);
    // Armored angular knee pad
    const knee = softBox(0.095, 0.075, 0.085, matLt);
    knee.position.set(0, -0.175, 0.055);
    hip.add(knee);
    // Lower shin greave + heavy armored boot
    const shin = rbox(0.105, 0.12, 0.115, matDk, true);
    shin.position.set(0, -0.23, 0.005);
    hip.add(shin);
    const boot = rbox(0.118, 0.09, 0.175, matGun, true);
    boot.position.set(0, -0.285, 0.032);
    hip.add(boot);
    body.add(hip);
    return hip;
  };
  const legL = makeLeg(-0.088);
  const legR = makeLeg(0.088);

  // Armored chest rig + collar + faction chest accent
  const torsoW = role === "rocket" ? 0.36 : 0.32;
  const torso = rbox(torsoW, 0.3, 0.22, matDk);
  torso.position.set(0, 0.53, 0);
  body.add(torso);

  const cuirass = softBox(torsoW - 0.03, 0.22, 0.25, matCer);
  cuirass.position.set(0, 0.55, 0.015);
  body.add(cuirass);

  // 25% faction accent chest armor plate
  const chestPlate = rbox(torsoW - 0.1, 0.13, 0.06, matAcc, true);
  chestPlate.position.set(0, 0.57, 0.13);
  body.add(chestPlate);

  // Armored gorget / neck collar
  const collar = cyl(0.24, 0.065, matGun);
  collar.position.set(0, 0.685, -0.01);
  body.add(collar);

  // Role-specific tactical backpack
  const pack = rbox(role === "engineer" ? 0.26 : 0.23, 0.26, 0.14, role === "engineer" ? matHaz : matDk);
  pack.position.set(0, 0.55, -0.16);
  body.add(pack);
  const packCore = rbox(0.14, 0.14, 0.05, matGun, true);
  packCore.position.set(0, 0.56, -0.225);
  body.add(packCore);
  if (role === "engineer") {
    const gauge = rbox(0.07, 0.08, 0.03, getGlowMat(CYAN_GLOW, 0.88), true);
    gauge.position.set(0, 0.57, -0.245);
    body.add(gauge);
    pulse.push(gauge);
  }
  const ant = cyl(0.018, 0.24, matLt);
  ant.position.set(-0.09, 0.76, -0.17);
  body.add(ant);

  // Sculpted composite helmet head group
  const head = new THREE.Group();
  head.position.set(0, 0.765, 0);
  const cranium = sph(0.225, role === "engineer" ? matHaz : matCer);
  cranium.scale.multiply(new THREE.Vector3(1.0, 0.96, 1.08));
  head.add(cranium);

  if (role === "engineer") {
    // High-vis composite hard-hat brim + armored safety visor + bright headlamp
    const brim = cyl(0.28, 0.035, matHaz);
    brim.position.set(0, 0.025, 0.025);
    head.add(brim);
    const band = cyl(0.24, 0.04, matAcc);
    band.position.set(0, 0.05, 0);
    head.add(band);
    const visor = softBox(0.16, 0.068, 0.075, matVisor);
    visor.position.set(0, -0.015, 0.088);
    head.add(visor);
    const lampBase = rbox(0.06, 0.05, 0.05, matGun, true);
    lampBase.position.set(0, 0.08, 0.11);
    head.add(lampBase);
    const lamp = sph(0.048, getGlowMat(WHITE_GLOW, 0.96), true);
    lamp.position.set(0, 0.08, 0.135);
    head.add(lamp);
  } else {
    // Sleek futuristic armored helmet shell + faction crest + recessed glass visor
    const shell = sph(0.25, matCer);
    shell.scale.multiply(new THREE.Vector3(1.06, 0.82, 1.14));
    shell.position.set(0, 0.032, -0.012);
    head.add(shell);
    const crest = rbox(0.065, 0.055, 0.22, matAcc, true);
    crest.position.set(0, 0.12, -0.01);
    head.add(crest);
    const visor = softBox(0.165, 0.064, 0.085, matVisor);
    visor.position.set(0, -0.005, 0.09);
    head.add(visor);
    const chin = rbox(0.13, 0.05, 0.08, matGun, true);
    chin.position.set(0, -0.065, 0.075);
    head.add(chin);
  }
  body.add(head);

  // Articulated shoulder-pivoted arms (armL, armR) with sculpted pauldrons
  const makeArm = (sx: number) => {
    const sh = new THREE.Group();
    sh.position.set(sx, 0.635, 0);
    // Layered armored shoulder pauldron with faction accent
    const pauldronBase = softBox(0.14, 0.12, 0.16, matCer);
    pauldronBase.position.set(sx > 0 ? 0.02 : -0.02, 0.02, 0);
    sh.add(pauldronBase);
    const pauldronCap = rbox(0.11, 0.045, 0.14, matAcc, true);
    pauldronCap.position.set(sx > 0 ? 0.035 : -0.035, 0.07, 0);
    sh.add(pauldronCap);
    // Upper arm + armored forearm bracer
    const upper = cap(0.16, 0.18, 0.16, matGraph);
    upper.position.set(0, -0.1, 0.02);
    upper.rotation.x = -0.25;
    sh.add(upper);
    const bracer = rbox(0.085, 0.13, 0.095, matCer, true);
    bracer.position.set(0, -0.18, 0.065);
    bracer.rotation.x = -0.5;
    sh.add(bracer);
    body.add(sh);
    return sh;
  };
  const armOffset = role === "rocket" ? 0.24 : 0.215;
  const armL = makeArm(-armOffset);
  const armR = makeArm(armOffset);

  const recoil = new THREE.Group();

  if (role === "infantry") {
    // Futuristic bullpup pulse rifle with glowing ammo strip & muzzle brake (mounted at z=0.15 per anim.ts)
    armR.rotation.x = -0.55;
    armL.rotation.x = -0.45;
    recoil.position.set(0, -0.16, 0.15);
    armR.add(recoil);

    const stock = rbox(0.062, 0.088, 0.36, matGun, true);
    recoil.add(stock);
    const shroud = rbox(0.07, 0.065, 0.22, matCer, true);
    shroud.position.set(0, 0.018, 0.12);
    recoil.add(shroud);
    const ammoStrip = rbox(0.075, 0.02, 0.13, getGlowMat(CYAN_GLOW, 0.9), true);
    ammoStrip.position.set(0, 0.015, 0.06);
    recoil.add(ammoStrip);
    const barrel = cyl(0.032, 0.24, matLt);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.018, 0.29);
    recoil.add(barrel);
    const muzzle = cyl(0.05, 0.065, matGun, "oct");
    muzzle.rotation.x = Math.PI / 2;
    muzzle.position.set(0, 0.018, 0.41);
    recoil.add(muzzle);
    const optic = rbox(0.036, 0.04, 0.1, matGun, true);
    optic.position.set(0, 0.068, 0.03);
    recoil.add(optic);
    const opticLens = rbox(0.028, 0.022, 0.02, getGlowMat(CYAN_GLOW, 0.92), true);
    opticLens.position.set(0, 0.068, 0.085);
    recoil.add(opticLens);
  } else if (role === "engineer") {
    // Rugged yellow tactical equipment case in right hand + glowing plasma welder/scanner in left
    const caseBody = rbox(0.16, 0.13, 0.085, matHaz, true);
    caseBody.position.set(0.03, -0.27, 0.06);
    armR.add(caseBody);
    const caseRim = rbox(0.17, 0.03, 0.095, matGun, true);
    caseRim.position.set(0.03, -0.27, 0.06);
    armR.add(caseRim);

    const toolBody = rbox(0.065, 0.07, 0.22, matCer, true);
    toolBody.position.set(0, -0.21, 0.15);
    armL.add(toolBody);
    const nozzle = cyl(0.04, 0.1, matLt);
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.set(0, -0.21, 0.28);
    armL.add(nozzle);
    const arcTip = sph(0.052, getGlowMat(CYAN_GLOW, 0.95), true);
    arcTip.position.set(0, -0.21, 0.34);
    armL.add(arcTip);
    pulse.push(arcTip);
  } else if (role === "rocket") {
    // Twin quad-cell shoulder missile pods with visible ogive warheads (mounted at z=0 per anim.ts)
    recoil.position.set(0, 0.74, 0);
    body.add(recoil);
    const matWarhead = getGlowMat(HEAT_GLOW, 0.88);
    const yoke = rbox(0.46, 0.06, 0.14, matGun, true);
    yoke.position.set(0, -0.02, -0.06);
    recoil.add(yoke);
    for (const sx of [-0.24, 0.24]) {
      const pod = new THREE.Group();
      pod.position.set(sx, 0.05, 0.02);
      pod.rotation.x = -0.14;
      recoil.add(pod);

      const housing = rbox(0.165, 0.165, 0.46, matGun, true);
      pod.add(housing);
      const trim = rbox(0.178, 0.178, 0.13, matAcc, true);
      trim.position.z = 0.08;
      pod.add(trim);
      const exhaust = rbox(0.13, 0.13, 0.06, matDk, true);
      exhaust.position.z = -0.24;
      pod.add(exhaust);

      // 4 visible mini-missiles in 2x2 quad array
      for (const [mx, my] of [
        [-0.038, 0.038],
        [0.038, 0.038],
        [-0.038, -0.038],
        [0.038, -0.038],
      ]) {
        const tube = cyl(0.052, 0.08, matLt);
        tube.rotation.x = Math.PI / 2;
        tube.position.set(mx, my, 0.23);
        pod.add(tube);
        const wh = meshOf(geoMissileCone, matWarhead, false, false);
        wh.scale.set(0.05, 0.095, 0.05);
        wh.rotation.x = Math.PI / 2;
        wh.position.set(mx, my, 0.285);
        pod.add(wh);
      }
    }
  }

  return { legL, legR, armL, armR, head, recoil };
}

// ---------- Main Land Model Builder ----------

export function buildLandModel(kind: EntKind, colorHex: string, body: THREE.Group): BuiltModel | null {
  let turret: THREE.Group | null = null;
  let topY = 1.0;
  let spin: THREE.Group | undefined;
  let spin2: THREE.Group | undefined;
  let bin: THREE.Mesh | undefined;
  let flag: THREE.Mesh | undefined;
  let crane: THREE.Group | undefined;
  let recoil: THREE.Group | undefined;
  let spiderLegs: THREE.Group[] | undefined;
  let smokePos: THREE.Vector3 | undefined;
  let soldierParts: Partial<AnimRig> = {};
  const pulse: THREE.Mesh[] = [];
  const powerGlow: THREE.Mesh[] = [];

  const matCer = getChassisMat(CERAMIC, 0.44, 0.56);
  const matLt = getChassisMat(CERAMIC_LT, 0.36, 0.68);
  const matDk = getChassisMat(CERAMIC_DK, 0.48, 0.54);
  const matGun = getChassisMat(GUNMETAL, 0.46, 0.66);
  const matGraph = getChassisMat(GRAPHITE, 0.65, 0.42);
  const matHaz = getChassisMat(HAZARD, 0.44, 0.35);
  const matCopper = getChassisMat(COPPER, 0.28, 0.82);
  const matGold = getChassisMat(GOLD_TRIM, 0.34, 0.72);
  const matAcc = getAccentMat(colorHex);
  const matGlass = getGlassMat("#48bae8");

  const add = <T extends THREE.Object3D>(m: T, x = 0, y = 0, z = 0, parent: THREE.Object3D = body): T => {
    parent.add(m);
    m.position.set(x, y, z);
    return m;
  };

  switch (kind) {
    // =========================================================================
    // LAND INFANTRY (3)
    // =========================================================================
    case "infantry":
      soldierParts = buildSoldierRig(body, colorHex, "infantry", pulse);
      recoil = soldierParts.recoil;
      topY = 1.0;
      break;

    case "engineer":
      soldierParts = buildSoldierRig(body, colorHex, "engineer", pulse);
      topY = 0.94;
      break;

    case "rocket":
      soldierParts = buildSoldierRig(body, colorHex, "rocket", pulse);
      recoil = soldierParts.recoil;
      topY = 1.08;
      break;

    case "spy":
      // Revealed spy keeps the rifleman silhouette it was disguised as
      soldierParts = buildSoldierRig(body, colorHex, "infantry", pulse);
      recoil = soldierParts.recoil;
      topY = 1.0;
      break;

    // =========================================================================
    // LAND VEHICLES (5)
    // =========================================================================
    case "tank": {
      // Next-gen Main Battle Tank — sloped reactive-armor composite hull, faceted turret, bore evacuator
      addContactShadow(body, 0.96, 1.16);

      // Left & right armored track pods with roadwheels & ERA composite skirts
      for (const sx of [-0.57, 0.57]) {
        const tread = rbox(0.32, 0.3, 1.84, getTreadMat(), true);
        add(tread, sx, 0.19, 0);
        // Sloped front & rear track return guards
        const fGuard = rbox(0.34, 0.14, 0.28, matDk, true);
        fGuard.rotation.x = 0.38;
        add(fGuard, sx, 0.33, 0.82);
        const rGuard = rbox(0.34, 0.14, 0.26, matDk, true);
        rGuard.rotation.x = -0.35;
        add(rGuard, sx, 0.33, -0.82);
        // Layered composite side skirt + ERA armor panels + faction trim stripe
        const sideOut = sx + (sx > 0 ? 0.165 : -0.165);
        add(rbox(0.07, 0.22, 1.66, matCer, true), sideOut, 0.29, 0);
        add(rbox(0.08, 0.055, 1.48, matAcc, true), sideOut + (sx > 0 ? 0.01 : -0.01), 0.34, 0.02);
        for (const ez of [-0.54, -0.18, 0.18, 0.54]) {
          add(rbox(0.035, 0.13, 0.28, matDk, true), sideOut + (sx > 0 ? 0.032 : -0.032), 0.24, ez);
        }
        // Roadwheels & metallic hubcaps
        for (const sz of [-0.66, -0.33, 0, 0.33, 0.66]) {
          const wh = cyl(0.22, 0.34, matGraph);
          wh.rotation.z = Math.PI / 2;
          add(wh, sx, 0.15, sz);
          const hub = cyl(0.09, 0.355, matLt);
          hub.rotation.z = Math.PI / 2;
          add(hub, sx, 0.15, sz);
        }
      }

      // Sculpted sloped reactive-armor composite hull
      add(meshOf(geoTankHull, matCer), 0, 0.44, 0);
      // Lower front armored glacis bumper + driver periscope glass + headlights
      const glacis = rbox(0.84, 0.08, 0.38, matDk, true);
      glacis.rotation.x = 0.36;
      add(glacis, 0, 0.52, 0.62);
      add(rbox(0.24, 0.055, 0.07, matGlass, true), 0, 0.62, 0.54);
      for (const hx of [-0.36, 0.36]) {
        add(rbox(0.11, 0.065, 0.07, matGun, true), hx, 0.47, 0.86);
        add(rbox(0.085, 0.04, 0.03, getGlowMat(WHITE_GLOW, 0.88), true), hx, 0.47, 0.895);
      }
      // Upper hull deck trim (25% faction accent) & glowing rear engine radiator vents
      add(rbox(0.74, 0.08, 1.12, matDk, true), 0, 0.62, -0.06);
      add(rbox(0.54, 0.04, 0.42, matAcc, true), 0, 0.655, 0.22);
      add(rbox(0.62, 0.06, 0.46, matGun, true), 0, 0.65, -0.54);
      for (const rx of [-0.2, 0.2]) {
        add(rbox(0.24, 0.03, 0.3, getGlowMat(HEAT_GLOW, 0.72), true), rx, 0.675, -0.56);
      }
      add(rbox(0.66, 0.1, 0.06, getGlowMat(HEAT_GLOW, 0.72), true), 0, 0.44, -0.9);

      // Sculpted angled rotating MBT turret
      turret = new THREE.Group();
      turret.position.set(0, 0.73, -0.04);
      body.add(turret);

      turret.add(meshOf(geoTankTurret, matCer));
      // Faction-painted angled cheek armor & roof ID trim
      for (const cx of [-0.34, 0.34]) {
        const cheek = rbox(0.08, 0.19, 0.52, matAcc, true);
        cheek.rotation.y = cx > 0 ? 0.22 : -0.22;
        add(cheek, cx, 0.01, 0.1, turret);
      }
      add(rbox(0.44, 0.055, 0.48, matAcc, true), 0, 0.165, -0.06, turret);
      // Rear turret bustle stowage rack
      add(rbox(0.66, 0.16, 0.24, matDk, true), 0, 0.04, -0.56, turret);
      // Commander's cupola + panoramic glass optic + coaxial MG + smoke dischargers + radio whip
      add(cyl(0.28, 0.09, matDk), -0.14, 0.2, -0.22, turret);
      add(cyl(0.12, 0.09, matGlass), 0.16, 0.21, -0.08, turret);
      const coax = cyl(0.036, 0.34, matGun);
      coax.rotation.x = Math.PI / 2;
      add(coax, 0.2, 0.05, 0.56, turret);
      for (const sx of [-0.38, 0.38]) {
        const smokePod = rbox(0.07, 0.075, 0.14, matGun, true);
        smokePod.rotation.x = -0.4;
        smokePod.rotation.y = sx > 0 ? 0.35 : -0.35;
        add(smokePod, sx, 0.09, 0.26, turret);
      }
      add(cyl(0.02, 0.62, matLt), 0.28, 0.39, -0.44, turret);

      // Recoil main cannon assembly (mounted at z=0.35 per anim.ts)
      recoil = new THREE.Group();
      recoil.position.set(0, 0.04, 0.35);
      turret.add(recoil);
      add(rbox(0.32, 0.2, 0.22, matDk, true), 0, 0, 0, recoil);
      const barrel = cyl(0.092, 1.12, matGun);
      barrel.rotation.x = Math.PI / 2;
      add(barrel, 0, 0, 0.54, recoil);
      // Bore evacuator & slotted muzzle brake
      const evac = cyl(0.142, 0.24, matCer);
      evac.rotation.x = Math.PI / 2;
      add(evac, 0, 0, 0.48, recoil);
      const muzzle = cyl(0.148, 0.19, matLt, "oct");
      muzzle.rotation.x = Math.PI / 2;
      add(muzzle, 0, 0, 1.09, recoil);

      smokePos = new THREE.Vector3(0, 0.74, -0.74);
      topY = 1.2;
      break;
    }

    case "heavy": {
      // Mastodon Tank — Colossal Quad-Track Super-Heavy Siege Juggernaut
      addContactShadow(body, 1.2, 1.42);

      // Quad-pod armored treads (2 front + 2 rear independent track pods!)
      for (const sx of [-0.76, 0.76]) {
        for (const sz of [-0.6, 0.6]) {
          const tread = rbox(0.44, 0.38, 0.96, getTreadMat(), true);
          add(tread, sx, 0.23, sz);
          // Heavy beveled armored track pod housing & fender
          add(rbox(0.48, 0.14, 0.92, matDk, true), sx, 0.44, sz);
          add(rbox(0.09, 0.24, 0.86, matCer, true), sx + (sx > 0 ? 0.22 : -0.22), 0.35, sz);
          add(rbox(0.04, 0.075, 0.72, matAcc, true), sx + (sx > 0 ? 0.26 : -0.26), 0.39, sz);
          for (const wz of [-0.28, 0.28]) {
            const wh = cyl(0.28, 0.46, matGraph);
            wh.rotation.z = Math.PI / 2;
            add(wh, sx, 0.17, sz + wz);
          }
        }
        // Heavy suspension link beam bridging front & rear pods
        add(rbox(0.26, 0.2, 0.46, matGun, true), sx, 0.32, 0);
      }

      // Colossal reinforced sloped juggernaut hull
      add(meshOf(geoHeavyHull, matCer), 0, 0.55, 0);
      // Massive reinforced glacis ram plate + twin armored headlights
      const ram = rbox(1.16, 0.16, 0.34, matGun, true);
      ram.rotation.x = 0.42;
      add(ram, 0, 0.48, 0.98);
      for (const hx of [-0.46, 0.46]) {
        add(rbox(0.16, 0.09, 0.08, matGun, true), hx, 0.56, 1.04);
        add(rbox(0.12, 0.055, 0.03, getGlowMat(WHITE_GLOW, 0.9), true), hx, 0.56, 1.08);
      }
      // Upper hull armor deck + faction shoulder bands + glowing side thermal heat-sinks
      add(rbox(1.06, 0.14, 1.48, matDk, true), 0, 0.76, -0.06);
      add(rbox(0.76, 0.05, 0.54, matAcc, true), 0, 0.82, 0.36);
      for (const sx of [-0.66, 0.66]) {
        add(rbox(0.1, 0.16, 1.18, matGun, true), sx, 0.64, -0.06);
        add(rbox(0.03, 0.075, 0.96, getGlowMat(HEAT_GLOW, 0.8), true), sx + (sx > 0 ? 0.05 : -0.05), 0.64, -0.06);
      }

      // Huge faceted heavy siege turret
      turret = new THREE.Group();
      turret.position.set(0, 0.91, -0.06);
      body.add(turret);

      turret.add(meshOf(geoHeavyTurret, matCer));
      // Bold faction armor trim on turret brow & roof
      add(rbox(0.68, 0.065, 0.64, matAcc, true), 0, 0.195, -0.08, turret);
      add(rbox(0.86, 0.18, 0.28, matDk, true), 0, 0.04, -0.66, turret);
      // Armored commander cupola + glass sensor dome + comms mast
      add(cyl(0.36, 0.12, matDk, "oct"), 0, 0.24, -0.32, turret);
      add(cyl(0.18, 0.08, matGlass), 0, 0.31, -0.32, turret);
      add(cyl(0.028, 0.58, matLt), 0.38, 0.42, -0.52, turret);

      // Twin turret-mounted mini-rocket cheek pods with visible warheads
      const matMiniWh = getGlowMat(AMBER_GLOW, 0.88);
      for (const sx of [-0.58, 0.58]) {
        const pod = rbox(0.24, 0.24, 0.56, matGun, true);
        add(pod, sx, 0.07, -0.1, turret);
        add(rbox(0.26, 0.06, 0.38, matAcc, true), sx, 0.18, -0.1, turret);
        for (const [rx, ry] of [
          [-0.055, 0.05],
          [0.055, 0.05],
          [-0.055, -0.05],
          [0.055, -0.05],
        ]) {
          const tip = meshOf(geoMissileCone, matMiniWh, false, false);
          tip.scale.set(0.058, 0.09, 0.058);
          tip.rotation.x = Math.PI / 2;
          add(tip, sx + rx, 0.07 + ry, 0.21, turret);
        }
      }

      // Twin heavy rail-cannons (mounted at z=0.42 per anim.ts)
      recoil = new THREE.Group();
      recoil.position.set(0, 0.04, 0.42);
      turret.add(recoil);
      add(rbox(0.68, 0.24, 0.24, matDk, true), 0, 0, 0, recoil);
      for (const bx of [-0.22, 0.22]) {
        const brl = cyl(0.11, 1.26, matGun);
        brl.rotation.x = Math.PI / 2;
        add(brl, bx, 0, 0.58, recoil);
        // Electromagnetic rail shroud & subtle glowing accelerator strip
        add(rbox(0.145, 0.045, 0.84, matLt, true), bx, 0.05, 0.54, recoil);
        add(rbox(0.035, 0.025, 0.72, getGlowMat(CYAN_GLOW, 0.82), true), bx, 0.074, 0.56, recoil);
        const muz = cyl(0.165, 0.21, matLt, "oct");
        muz.rotation.x = Math.PI / 2;
        add(muz, bx, 0, 1.21, recoil);
      }

      smokePos = new THREE.Vector3(0, 0.88, -0.96);
      topY = 1.44;
      break;
    }

    case "arty": {
      // Siege Launcher — Heavy 6x6 Armored Tactical MLRS Truck
      addContactShadow(body, 0.96, 1.18);

      // 6 rugged heavy armored off-road tires with deep rims & hubcaps
      for (const [wx, wz] of [
        [-0.56, 0.62],
        [0.56, 0.62],
        [-0.56, -0.04],
        [0.56, -0.04],
        [-0.56, -0.66],
        [0.56, -0.66],
      ]) {
        const tire = cyl(0.4, 0.24, matGraph);
        tire.rotation.z = Math.PI / 2;
        add(tire, wx, 0.2, wz);
        const rim = cyl(0.21, 0.255, matLt, "oct");
        rim.rotation.z = Math.PI / 2;
        add(rim, wx, 0.2, wz);
      }

      // Armored 6x6 chassis frame & wheel-well fenders
      add(rbox(0.98, 0.22, 1.84, matGun, true), 0, 0.36, -0.02);
      add(rbox(1.12, 0.11, 1.72, matCer, true), 0, 0.49, -0.02);
      // Heavy front bumper + rear hydraulic stabilizer outriggers
      add(rbox(1.06, 0.16, 0.14, matDk, true), 0, 0.38, 0.92);
      for (const sx of [-0.56, 0.56]) {
        const leg = rbox(0.11, 0.34, 0.12, matLt, true);
        leg.rotation.z = sx > 0 ? -0.32 : 0.32;
        add(leg, sx + (sx > 0 ? 0.08 : -0.08), 0.24, -0.9);
        add(rbox(0.2, 0.055, 0.2, matHaz, true), sx + (sx > 0 ? 0.14 : -0.14), 0.045, -0.9);
      }

      // Sloped armored forward tactical cab
      add(meshOf(geoArtyCab, matCer), 0, 0.72, 0.56);
      // Faction cab roof & door stripe accents
      add(rbox(0.76, 0.06, 0.44, matAcc, true), 0, 0.96, 0.49);
      for (const sx of [-0.43, 0.43]) {
        add(rbox(0.03, 0.12, 0.38, matAcc, true), sx, 0.68, 0.54);
      }
      // Sloped armored panoramic windshield & headlights
      const glass = rbox(0.68, 0.16, 0.06, matGlass, true);
      glass.rotation.x = -0.34;
      add(glass, 0, 0.79, 0.85);
      for (const hx of [-0.34, 0.34]) {
        add(rbox(0.12, 0.06, 0.03, getGlowMat(WHITE_GLOW, 0.88), true), hx, 0.56, 0.92);
      }
      add(cyl(0.022, 0.46, matLt), -0.34, 1.16, 0.36);

      // Turntable cradle & hydraulic elevation rams
      add(cyl(0.56, 0.14, matDk, "oct"), 0, 0.59, -0.34);
      for (const px of [-0.22, 0.22]) {
        const piston = cyl(0.06, 0.42, matLt);
        piston.rotation.x = 0.28;
        add(piston, px, 0.76, -0.14);
      }

      // Elevated multi-tube MLRS rocket launcher pod (mounted at z=-0.26 per anim.ts)
      recoil = new THREE.Group();
      recoil.position.set(0, 0.86, -0.26);
      recoil.rotation.x = -0.48;
      body.add(recoil);

      add(rbox(0.66, 0.36, 1.48, matGun, true), 0, 0, 0, recoil);
      // Faction-painted upper launcher cowling & side structural ribs
      add(rbox(0.68, 0.075, 1.24, matAcc, true), 0, 0.205, -0.04, recoil);
      for (const rz of [-0.46, 0, 0.46]) {
        add(rbox(0.71, 0.38, 0.07, matCer, true), 0, 0, rz, recoil);
      }
      // 6 visible launch tubes (2x3) packed with red-tipped ogive warheads
      const matRktWh = getGlowMat(HEAT_GLOW, 0.9);
      for (const mx of [-0.2, 0, 0.2]) {
        for (const my of [-0.085, 0.085]) {
          const tube = cyl(0.145, 0.16, matLt);
          tube.rotation.x = Math.PI / 2;
          add(tube, mx, my, 0.72, recoil);
          const warhead = meshOf(geoMissileCone, matRktWh, false, false);
          warhead.scale.set(0.135, 0.24, 0.135);
          warhead.rotation.x = Math.PI / 2;
          add(warhead, mx, my, 0.84, recoil);
        }
      }

      smokePos = new THREE.Vector3(0, 0.66, -0.78);
      topY = 1.54;
      break;
    }

    case "spider": {
      // Spider Drone — Sleek Stealth Cyber-Arachnid with 4 Multi-Jointed Legs
      addContactShadow(body, 0.64, 0.64);

      // Faceted angular stealth metallic carapace
      add(meshOf(geoSpiderCarapace, matDk), 0, 0.44, -0.02);
      const upperShell = meshOf(geoSpiderCarapace, matCer);
      upperShell.scale.multiply(new THREE.Vector3(0.84, 0.78, 0.86));
      add(upperShell, 0, 0.54, -0.04);
      // Crisp 25% faction dorsal spine chevrons
      add(rbox(0.24, 0.06, 0.34, matAcc, true), 0, 0.635, -0.06);
      add(rbox(0.14, 0.05, 0.14, matGun, true), 0, 0.64, -0.26);

      // Glowing cyan optical tri-eye array on brow
      const eyeMain = sph(0.125, getGlowMat(CYAN_GLOW, 0.96), true);
      add(eyeMain, 0, 0.48, 0.285);
      pulse.push(eyeMain);
      for (const ex of [-0.115, 0.115]) {
        const subEye = sph(0.06, getGlowMat(CYAN_GLOW, 0.85), true);
        add(subEye, ex, 0.49, 0.245);
      }

      // Twin cybernetic front mandibles
      for (const mx of [-0.12, 0.12]) {
        const jaw = rbox(0.045, 0.055, 0.24, matLt, true);
        jaw.rotation.y = mx > 0 ? -0.34 : 0.34;
        add(jaw, mx, 0.38, 0.36);
      }

      // 4 multi-jointed armored mechanical legs in exact diagonal order per anim.ts
      spiderLegs = [];
      const corners: [number, number][] = [
        [-1, 1],
        [1, 1],
        [-1, -1],
        [1, -1],
      ];
      for (const [lx, lz] of corners) {
        const legPivot = new THREE.Group();
        legPivot.position.set(lx * 0.24, 0.4, lz * 0.2);

        // Hip actuator socket
        add(sph(0.1, matGun), 0, 0, 0, legPivot);

        // Upper armored femur extending outward & slightly upward
        const femur = rbox(0.072, 0.36, 0.072, matCer, true);
        femur.rotation.z = lx * -1.04;
        femur.rotation.x = lz * 0.28;
        add(femur, lx * 0.15, 0.07, lz * 0.06, legPivot);

        // Faction armor plate on femur top
        const fPlate = rbox(0.082, 0.16, 0.082, matAcc, true);
        fPlate.rotation.z = lx * -1.04;
        fPlate.rotation.x = lz * 0.28;
        add(fPlate, lx * 0.16, 0.09, lz * 0.06, legPivot);

        // Mechanical knee servo joint
        add(sph(0.095, matLt), lx * 0.3, 0.14, lz * 0.12, legPivot);

        // Lower armored blade tibia angling sharply down to talon foot
        const tibia = cone(0.085, 0.56, matGun);
        tibia.rotation.x = Math.PI + lz * -0.18;
        tibia.rotation.z = lx * -0.28;
        add(tibia, lx * 0.38, -0.12, lz * 0.16, legPivot);

        body.add(legPivot);
        spiderLegs.push(legPivot);
      }

      topY = 0.84;
      break;
    }

    case "harvester": {
      // Ore Harvester — Massive Industrial Armored Mining Crawler
      addContactShadow(body, 1.08, 1.42);

      // 6 massive rugged mining crawler wheels with planetary hubs
      for (const [wx, wz] of [
        [-0.68, 0.64],
        [0.68, 0.64],
        [-0.68, -0.14],
        [0.68, -0.14],
        [-0.68, -0.76],
        [0.68, -0.76],
      ]) {
        const wheel = cyl(0.46, 0.28, matGraph);
        wheel.rotation.z = Math.PI / 2;
        add(wheel, wx, 0.23, wz);
        const hub = cyl(0.24, 0.3, matHaz, "oct");
        hub.rotation.z = Math.PI / 2;
        add(hub, wx, 0.23, wz);
      }

      // Heavy armored chassis + reinforced side fenders
      add(rbox(1.24, 0.34, 2.04, matDk, true), 0, 0.44, -0.02);
      for (const sx of [-0.66, 0.66]) {
        add(rbox(0.22, 0.08, 1.9, matCer, true), sx, 0.5, -0.02);
      }

      // Huge reinforced rear ore hopper with external steel ribs
      add(rbox(1.32, 0.44, 1.18, matCer, true), 0, 0.76, -0.36);
      // Recessed dark bed inside hopper
      add(rbox(1.12, 0.06, 0.98, matGraph, true), 0, 0.72, -0.36);
      for (const sx of [-0.67, 0.67]) {
        add(rbox(0.05, 0.12, 1.02, matAcc, true), sx, 0.82, -0.36);
        for (const rz of [-0.76, -0.36, 0.04]) {
          add(rbox(0.07, 0.42, 0.08, matDk, true), sx, 0.76, rz);
        }
      }
      // Faceted glowing ore crystal load (scales Y from 0.05 to 1.0 from hopper bed!)
      bin = meshOf(geoOreLoad, getGlowMat(AMBER_GLOW, 0.86), false, false);
      bin.position.set(0, 0.72, -0.36);
      bin.scale.y = 0.05;
      body.add(bin);

      // Wide panoramic armored forward cab
      add(meshOf(geoHarvesterCab, matCer), 0, 0.78, 0.62);
      add(rbox(0.86, 0.08, 0.54, matAcc, true), 0, 1.08, 0.54);
      // Wraparound panoramic armored glass windshield + roll-cage brow
      const cabGlass = rbox(0.82, 0.22, 0.06, matGlass, true);
      cabGlass.rotation.x = -0.28;
      add(cabGlass, 0, 0.86, 0.96);
      add(rbox(0.92, 0.06, 0.14, matGun, true), 0, 1.01, 0.94);
      // Side vertical exhaust stack & work floodlights
      add(cyl(0.095, 0.66, matGun), 0.54, 0.88, 0.34);
      for (const lx of [-0.36, 0.36]) {
        add(rbox(0.14, 0.07, 0.04, getGlowMat(WHITE_GLOW, 0.9), true), lx, 0.62, 1.0);
      }
      // Rooftop amber strobe work beacon
      const beacon = sph(0.12, getGlowMat(AMBER_GLOW, 0.96), true);
      add(beacon, 0, 1.18, 0.58);
      pulse.push(beacon);

      // Front heavy hydraulic scoop arms + rotating spiked mining grinder drum (spins around X)
      for (const sx of [-0.54, 0.54]) {
        add(rbox(0.14, 0.18, 0.54, matDk, true), sx, 0.32, 1.08);
        const hyd = cyl(0.06, 0.42, matLt);
        hyd.rotation.x = Math.PI / 2 - 0.32;
        add(hyd, sx, 0.46, 1.04);
        add(rbox(0.06, 0.24, 0.32, matHaz, true), sx + (sx > 0 ? 0.08 : -0.08), 0.28, 1.24);
      }

      spin = new THREE.Group();
      spin.position.set(0, 0.28, 1.28);
      body.add(spin);
      const drum = cyl(0.24, 0.98, matLt);
      drum.rotation.z = Math.PI / 2;
      spin.add(drum);
      for (let i = 0; i < 4; i++) {
        const ang = (i * Math.PI) / 2;
        const blade = rbox(0.94, 0.36, 0.055, matHaz, true);
        blade.rotation.x = ang;
        spin.add(blade);
        // Tungsten mining spikes along each blade edge
        for (const tx of [-0.34, 0, 0.34]) {
          const spike = cone(0.07, 0.12, matGun);
          spike.position.set(tx, Math.cos(ang) * 0.21, Math.sin(ang) * 0.21);
          spike.rotation.x = ang;
          spin.add(spike);
        }
      }

      smokePos = new THREE.Vector3(0.54, 1.2, 0.34);
      topY = 1.32;
      break;
    }

    // =========================================================================
    // LAND BUILDINGS (14)
    // =========================================================================
    case "conyard": {
      // Construction Yard (3x3) — Monumental Armored Command Citadel
      body.add(foundationPad(3, 3, colorHex, 0.24));

      // Lower armored bunker plinth with corner buttresses
      add(rbox(2.54, 0.54, 2.54, matDk), 0, 0.51, 0);
      for (const [bx, bz] of [
        [-1.2, -1.2],
        [1.2, -1.2],
        [-1.2, 1.2],
        [1.2, 1.2],
      ]) {
        add(rbox(0.32, 0.62, 0.32, matCer, true), bx, 0.55, bz);
      }

      // Left-center elevated command citadel tower
      add(rbox(1.48, 0.74, 1.56, matCer), -0.44, 1.12, -0.08);
      // Faction-painted command roof parapet & side fascia
      add(rbox(1.56, 0.12, 1.64, matAcc, true), -0.44, 1.48, -0.08);
      // Panoramic wraparound glowing bridge glass
      add(rbox(1.24, 0.2, 0.07, matGlass, true), -0.44, 1.18, 0.71);
      add(rbox(0.07, 0.2, 0.96, matGlass, true), -1.19, 1.18, 0.06);
      add(rbox(1.14, 0.045, 0.03, getGlowMat(WHITE_GLOW, 0.78), true), -0.44, 1.07, 0.73);

      // Right armored fabrication bay + rooftop helipad emblem
      add(rbox(1.06, 0.52, 2.02, matDk), 0.76, 1.02, -0.14);
      // Front armored fabrication bay shutter
      add(rbox(0.76, 0.42, 0.08, matGraph, true), 0.76, 0.64, 0.88);
      add(rbox(0.84, 0.06, 0.08, matHaz, true), 0.76, 0.88, 0.89);
      // Helipad ring on right deck
      const heliDeck = cyl(0.84, 0.04, matGun);
      add(heliDeck, 0.76, 1.3, -0.46);
      const heliRing = torus(0.74, matAcc, true);
      heliRing.rotation.x = Math.PI / 2;
      add(heliRing, 0.76, 1.33, -0.46);

      // Articulated yellow lattice construction crane (rotates gently around Y in anim.ts)
      crane = new THREE.Group();
      crane.position.set(-0.42, 1.54, 0.18);
      body.add(crane);
      add(cyl(0.46, 0.18, matGun, "oct"), 0, 0.09, 0, crane);
      add(rbox(0.36, 0.26, 0.46, matHaz, true), 0, 0.28, -0.1, crane);
      add(rbox(0.28, 0.14, 0.06, matGlass, true), 0, 0.3, 0.14, crane);
      // Twin-chord lattice jib boom + cross-bracing
      for (const jx of [-0.075, 0.075]) {
        const chord = rbox(0.045, 0.06, 2.04, matHaz, true);
        chord.rotation.x = -0.42;
        add(chord, jx, 0.58, 0.54, crane);
      }
      for (const t of [0.1, 0.42, 0.74, 1.06]) {
        const brace = rbox(0.18, 0.04, 0.04, matGun, true);
        add(brace, 0, 0.35 + t * 0.42, 0.08 + t * 0.9, crane);
      }
      // Hoist cable & armored grapple hook
      add(cyl(0.025, 0.72, matLt), 0, 0.62, 1.38, crane);
      add(rbox(0.12, 0.1, 0.12, matHaz, true), 0, 0.24, 1.38, crane);

      // Parabolic LatheGeometry satellite dish on front-right tower (spins around Y)
      add(cyl(0.14, 1.06, matGun, "oct"), 0.86, 1.78, 0.74);
      spin = new THREE.Group();
      spin.position.set(0.86, 2.34, 0.74);
      body.add(spin);
      const dish = meshOf(geoParabolicDish, matLt);
      dish.scale.set(0.76, 0.76, 0.76);
      dish.rotation.x = 0.88;
      spin.add(dish);
      const dishRim = torus(0.75, matAcc, true);
      dishRim.rotation.x = Math.PI / 2 + 0.88;
      dishRim.position.set(0, 0.12, 0.15);
      spin.add(dishRim);
      const feed = cyl(0.036, 0.34, matGun);
      feed.rotation.x = 0.88;
      add(feed, 0, 0.15, 0.17, spin);
      add(sph(0.075, getGlowMat(CYAN_GLOW, 0.92), true), 0, 0.26, 0.29, spin);

      // Corner tactical warning beacons
      const b1 = sph(0.13, getGlowMat(colorHex, 0.9), true);
      add(b1, -1.04, 1.62, -0.78);
      pulse.push(b1);
      const b2 = sph(0.1, getGlowMat(AMBER_GLOW, 0.88), true);
      add(b2, 1.12, 1.36, -1.02);
      pulse.push(b2);

      smokePos = new THREE.Vector3(0.55, 1.55, -0.65);
      topY = 2.75;
      break;
    }

    case "power": {
      // Reactor Plant (2x2) — Twin Hyperbolic Cooling Towers & Recessed Cyan Plasma Core
      body.add(foundationPad(2, 2, colorHex, 0.22));

      // Armored turbine hall base + heat-exchanger fins
      add(rbox(1.72, 0.36, 1.72, matDk), 0, 0.4, 0);
      add(rbox(1.36, 0.14, 0.14, matAcc, true), 0, 0.56, 0.82);
      add(rbox(1.36, 0.14, 0.14, matAcc, true), 0, 0.56, -0.82);
      for (const sx of [-0.88, 0.88]) {
        for (const rz of [-0.4, 0, 0.4]) {
          add(rbox(0.08, 0.24, 0.16, matGun, true), sx, 0.42, rz);
        }
      }

      // Twin true curved LatheGeometry hyperbolic cooling towers
      for (const [tx, tz] of [
        [-0.45, -0.43],
        [0.45, 0.43],
      ]) {
        const tower = meshOf(geoCoolingTower, matCer);
        tower.scale.set(0.78, 1.24, 0.78);
        add(tower, tx, 0.44, tz);
        // Crisp faction-colored band collar near upper rim
        const collar = torus(0.62, matAcc, true);
        collar.rotation.x = Math.PI / 2;
        add(collar, tx, 1.52, tz);
        // Dark interior vent glow hint
        const throat = cyl(0.46, 0.04, matGraph);
        add(throat, tx, 1.38, tz);
      }

      // Central armored plasma containment housing + pulsing cyan plasma core & rings
      add(cyl(0.52, 0.18, matGun, "oct"), 0, 0.62, 0);
      const core = cyl(0.28, 0.84, getGlowMat(CYAN_GLOW, 0.94));
      add(core, 0, 1.0, 0);
      pulse.push(core);
      // Glazed containment glass cylinder & 3 external magnetic containment rings
      const shroud = cyl(0.4, 0.76, matGlass);
      add(shroud, 0, 1.0, 0);
      for (const ry of [0.78, 1.0, 1.22]) {
        const r = torus(0.48, ry === 1.0 ? getGlowMat(CYAN_GLOW, 0.85) : matLt, true);
        r.rotation.x = Math.PI / 2;
        add(r, 0, ry, 0);
        if (ry === 1.0) pulse.push(r);
      }
      // Top cap + 3 vertical containment struts
      add(cyl(0.48, 0.12, matCer, "oct"), 0, 1.44, 0);
      add(cyl(0.32, 0.06, matAcc, "oct"), 0, 1.52, 0);
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI * 2) / 3 + 0.4;
        add(rbox(0.065, 0.86, 0.065, matDk, true), Math.cos(a) * 0.24, 1.02, Math.sin(a) * 0.24);
      }

      smokePos = new THREE.Vector3(-0.45, 1.72, -0.43);
      topY = 1.82;
      break;
    }

    case "refinery": {
      // Ore Refinery (3x2) — Smelter Hall, Curved Silo, Molten Vents & Illuminated Docking Ramp
      body.add(foundationPad(3, 2, colorHex, 0.22));

      // Armored ore furnace & smelter building (right side)
      add(rbox(1.48, 0.66, 1.56, matDk), 0.62, 0.55, -0.06);
      add(rbox(1.24, 0.26, 1.32, matCer), 0.62, 0.98, -0.06);
      add(rbox(1.3, 0.09, 0.22, matAcc, true), 0.62, 1.12, 0.48);
      add(rbox(1.3, 0.09, 0.22, matAcc, true), 0.62, 1.12, -0.58);
      // Molten-amber glowing furnace heat vents on side & front
      for (const vz of [-0.42, 0, 0.42]) {
        add(rbox(0.05, 0.22, 0.22, getGlowMat(AMBER_GLOW, 0.86), true), 1.37, 0.56, vz);
      }
      add(rbox(0.84, 0.24, 0.06, getGlowMat(AMBER_GLOW, 0.88), true), 0.62, 0.54, 0.74);

      // Sloped harvester docking bay ramp with illuminated chevron guides (+Z)
      const ramp = rbox(1.06, 0.14, 0.58, matLt, true);
      ramp.rotation.x = 0.14;
      add(ramp, 0.62, 0.26, 0.88);
      for (const cx of [0.24, 0.62, 1.0]) {
        add(rbox(0.18, 0.03, 0.07, getGlowMat(AMBER_GLOW, 0.88), true), cx, 0.34, 0.96);
      }
      for (const bx of [0.06, 1.18]) {
        add(rbox(0.09, 0.34, 0.09, matHaz, true), bx, 0.38, 0.96);
      }

      // Massive curved LatheGeometry ore storage silo (left side) with glowing fill gauge
      const silo = meshOf(geoSilo, matCer);
      silo.scale.set(1.12, 1.56, 1.12);
      add(silo, -0.82, 0.22, -0.02);
      const gaugeRing = torus(0.99, getGlowMat(AMBER_GLOW, 0.9), true);
      gaugeRing.rotation.x = Math.PI / 2;
      add(gaugeRing, -0.82, 1.36, -0.02);
      pulse.push(gaugeRing);
      const siloCap = torus(0.76, matAcc, true);
      siloCap.rotation.x = Math.PI / 2;
      add(siloCap, -0.82, 1.58, -0.02);

      // Overhead ore transfer pipe connecting smelter hall to silo
      const pipe = cyl(0.15, 1.16, matLt);
      pipe.rotation.z = Math.PI / 2;
      add(pipe, -0.14, 1.14, -0.14);

      // Tall industrial smokestack with heat flange
      add(cyl(0.22, 1.72, matGun), 1.18, 1.12, -0.58);
      add(cyl(0.28, 0.1, matDk), 1.18, 1.78, -0.58);
      const stackTip = cyl(0.15, 0.06, getGlowMat(HEAT_GLOW, 0.85));
      add(stackTip, 1.18, 1.98, -0.58);
      pulse.push(stackTip);

      smokePos = new THREE.Vector3(1.18, 2.02, -0.58);
      topY = 2.06;
      break;
    }

    case "barracks": {
      // Barracks (2x2) — Fortified Futuristic Garrison Bunker with Animated Flag
      body.add(foundationPad(2, 2, colorHex, 0.2));

      // Armored sloped bunker walls + heavy corner buttresses
      add(rbox(1.66, 0.72, 1.58, matDk), 0, 0.56, -0.04);
      for (const [bx, bz] of [
        [-0.78, -0.78],
        [0.78, -0.78],
        [-0.78, 0.7],
        [0.78, 0.7],
      ]) {
        add(rbox(0.26, 0.78, 0.26, matCer, true), bx, 0.58, bz);
      }

      // Sloped reinforced ribbed bunker roof
      const roof = rbox(1.8, 0.2, 1.76, matCer);
      roof.rotation.x = 0.08;
      add(roof, 0, 1.0, -0.04);
      for (const rx of [-0.56, -0.19, 0.19, 0.56]) {
        const rib = rbox(0.12, 0.09, 1.66, matDk, true);
        rib.rotation.x = 0.08;
        add(rib, rx, 1.11, -0.04);
      }
      // Faction command crest & front brow bar
      add(rbox(1.16, 0.09, 0.12, matAcc, true), 0, 0.88, 0.77);
      add(rbox(0.84, 0.07, 0.56, matAcc, true), 0, 1.14, -0.22);

      // Illuminated troop deployment bay with armored blast door frame
      add(rbox(0.76, 0.58, 0.14, matGun, true), 0, 0.49, 0.74);
      add(rbox(0.56, 0.46, 0.05, getGlowMat(WHITE_GLOW, 0.82), true), 0, 0.46, 0.79);
      // Side garrison glass viewports
      for (const sx of [-0.84, 0.84]) {
        add(rbox(0.05, 0.14, 0.78, matGlass, true), sx, 0.66, -0.04);
      }

      // Rooftop comms mast & animated billowing faction flag (anchored cleanly at pole x=0)
      add(cyl(0.052, 1.24, matLt), 0.66, 1.46, 0.54);
      add(sph(0.085, matGold), 0.66, 2.08, 0.54);
      flag = meshOf(geoFlag, matAcc);
      add(flag, 0.66, 1.88, 0.54);

      // Secondary roof comms whip on opposite corner
      add(cyl(0.032, 0.62, matLt), -0.62, 1.38, -0.58);
      add(rbox(0.32, 0.035, 0.035, matLt, true), -0.62, 1.56, -0.58);

      smokePos = new THREE.Vector3(-0.42, 1.2, -0.4);
      topY = 2.12;
      break;
    }

    case "radar": {
      // Radar Uplink (2x2) — Armored Telemetry Bunker, Geodesic Dome & Sweeping Parabolic Dish
      body.add(foundationPad(2, 2, colorHex, 0.2));

      // Armored octagonal telemetry bunker base
      add(cyl(1.42, 0.56, matDk, "oct"), 0, 0.48, 0);
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        const fin = rbox(0.24, 0.52, 0.34, matCer, true);
        fin.rotation.y = -a + Math.PI / 2;
        add(fin, Math.cos(a) * 0.64, 0.46, Math.sin(a) * 0.64);
      }
      add(rbox(0.68, 0.14, 0.07, matGlass, true), 0, 0.52, 0.68);
      const baseAccent = torus(1.24, matAcc, true);
      baseAccent.rotation.x = Math.PI / 2;
      add(baseAccent, 0, 0.74, 0);

      // Sleek geodesic telemetry dome
      const dome = sph(1.28, matCer);
      dome.scale.multiply(new THREE.Vector3(1, 0.56, 1));
      add(dome, 0, 0.82, 0);
      // Glowing cyan scan ring around pedestal collar
      const scanRing = torus(0.42, getGlowMat(CYAN_GLOW, 0.88), true);
      scanRing.rotation.x = Math.PI / 2;
      add(scanRing, 0, 1.28, 0);
      pulse.push(scanRing);

      // Heavy pedestal mast & sweeping LatheGeometry parabolic radar dish
      add(cyl(0.18, 0.78, matGun, "oct"), 0, 1.48, 0);
      spin = new THREE.Group();
      spin.position.set(0, 1.9, 0);
      body.add(spin);

      const yoke = rbox(0.32, 0.22, 0.28, matDk, true);
      spin.add(yoke);
      const rdish = meshOf(geoParabolicDish, matLt);
      rdish.scale.set(1.16, 1.16, 1.16);
      rdish.rotation.x = 0.92;
      rdish.position.set(0, 0.04, 0.06);
      spin.add(rdish);
      const rRim = torus(1.14, matAcc, true);
      rRim.rotation.x = Math.PI / 2 + 0.92;
      rRim.position.set(0, 0.22, 0.28);
      spin.add(rRim);
      // Central receiver horn + stabilizer crossbar with glowing scan tips
      const horn = cyl(0.05, 0.52, matGun);
      horn.rotation.x = 0.92;
      add(horn, 0, 0.24, 0.3, spin);
      const hornOrb = sph(0.105, getGlowMat(CYAN_GLOW, 0.95), true);
      add(hornOrb, 0, 0.42, 0.5, spin);
      pulse.push(hornOrb);

      add(rbox(1.26, 0.065, 0.065, matLt, true), 0, 0.34, -0.06, spin);
      for (const sx of [-0.62, 0.62]) {
        add(sph(0.08, getGlowMat(CYAN_GLOW, 0.9), true), sx, 0.37, -0.06, spin);
      }

      smokePos = new THREE.Vector3(0, 1.25, 0);
      topY = 2.55;
      break;
    }

    case "factory":
    case "factory2": {
      // War Factory / War Factory II (3x3) — Heavy Armored Vehicle Assembly Plant
      const mk2 = kind === "factory2";
      body.add(foundationPad(3, 3, colorHex, 0.22));

      // Colossal armored assembly hall + external structural steel ribs
      add(rbox(2.62, 0.96, 2.54, matDk), 0, 0.7, -0.04);
      for (const rz of [-0.88, -0.32, 0.24, 0.8]) {
        add(rbox(2.74, 0.92, 0.14, matCer, true), 0, 0.69, rz);
      }
      // Ribbed industrial clerestory roof monitor with glass skylights
      add(rbox(2.06, 0.3, 1.84, matCer), 0, 1.3, -0.14);
      for (const sx of [-1.04, 1.04]) {
        add(rbox(0.05, 0.14, 1.56, matGlass, true), sx, 1.32, -0.14);
      }

      // Wide illuminated vehicle exit hangar bay with blast shutters (+Z)
      add(rbox(1.74, 0.8, 0.12, matGun, true), 0, 0.62, 1.24);
      add(rbox(1.56, 0.68, 0.06, matGraph, true), 0, 0.56, 1.28);
      // Partially raised ribbed steel blast shutter at top of bay
      add(rbox(1.56, 0.18, 0.08, matLt, true), 0, 0.84, 1.29);
      // Bright hangar bay overhead floodlight strip + faction header fascia
      add(rbox(1.52, 0.06, 0.04, getGlowMat(WHITE_GLOW, 0.88), true), 0, 0.96, 1.31);
      add(rbox(1.88, 0.12, 0.12, matAcc, true), 0, 1.07, 1.26);

      // Heavy overhead external gantry beam across roof
      for (const gx of [-0.94, 0.94]) {
        add(rbox(0.16, 0.36, 0.16, matGun, true), gx, 1.44, -0.68);
      }
      add(rbox(2.08, 0.15, 0.2, matAcc, true), 0, 1.62, -0.68);

      // Left pair of heavy exhaust stacks with glowing heat tips
      add(cyl(0.24, 1.02, matGun), -0.96, 1.56, 0.74);
      add(cyl(0.22, 0.82, matGun), -0.6, 1.46, 0.74);
      add(cyl(0.28, 0.08, matDk), -0.96, 1.92, 0.74);
      const f1 = sph(0.105, getGlowMat(HEAT_GLOW, 0.92), true);
      add(f1, -0.96, 2.09, 0.74);
      pulse.push(f1);

      if (mk2) {
        // MKII: Symmetrical right pair of heavy exhaust stacks
        add(cyl(0.24, 1.02, matGun), 0.96, 1.56, 0.74);
        add(cyl(0.22, 0.82, matGun), 0.6, 1.46, 0.74);
        add(cyl(0.28, 0.08, matDk), 0.96, 1.92, 0.74);
        const f2 = sph(0.105, getGlowMat(HEAT_GLOW, 0.92), true);
        add(f2, 0.96, 2.09, 0.74);
        pulse.push(f2);

        // MKII gold & faction reinforced armor parapet trim
        add(rbox(2.56, 0.09, 0.1, matGold, true), 0, 1.21, 1.25);
        for (const sx of [-1.3, 1.3]) {
          add(rbox(0.1, 0.09, 2.38, matGold, true), sx, 1.21, -0.04);
          add(rbox(0.14, 0.18, 1.44, matAcc, true), sx, 1.08, -0.08);
        }
        // Glowing roof assembly bay lights
        for (const rx of [-0.62, 0.62]) {
          add(rbox(0.38, 0.05, 0.92, getGlowMat(CYAN_GLOW, 0.84), true), rx, 1.46, -0.14);
        }
        // Tall command comms & telemetry tower on rear-right
        add(rbox(0.34, 0.36, 0.34, matCer, true), 1.04, 1.44, -0.94);
        add(cyl(0.075, 0.96, matLt), 1.04, 2.04, -0.94);
        add(rbox(0.42, 0.045, 0.045, matGold, true), 1.04, 2.26, -0.94);
        const b2 = sph(0.115, getGlowMat(CYAN_GLOW, 0.94), true);
        add(b2, 1.04, 2.55, -0.94);
        pulse.push(b2);
      }

      smokePos = new THREE.Vector3(-0.96, 2.12, 0.74);
      topY = mk2 ? 2.64 : 2.18;
      break;
    }

    case "techlab": {
      // Tech Lab (3x3) — Sleek Titanium/Glass Research Citadel & Twin-Ring Particle Accelerator Spire
      body.add(foundationPad(3, 3, colorHex, 0.24));

      // Stepped futuristic titanium-and-glass research tiers
      add(rbox(2.48, 0.66, 2.48, matDk), 0, 0.57, 0);
      // Curved / wraparound atrium glass windows on lower & mid tiers
      add(rbox(1.86, 0.24, 0.07, matGlass, true), -0.14, 0.64, 1.25);
      add(rbox(0.07, 0.24, 1.86, matGlass, true), -1.25, 0.64, -0.1);
      add(rbox(1.84, 0.64, 1.84, matCer), -0.12, 1.22, -0.14);
      add(rbox(1.52, 0.16, 0.06, matGlass, true), -0.12, 1.26, 0.79);
      add(rbox(1.22, 0.42, 1.22, matLt), -0.24, 1.74, -0.26);
      // Faction architectural accent trim bands
      add(rbox(1.92, 0.09, 1.92, matAcc, true), -0.12, 1.54, -0.14);
      add(rbox(1.28, 0.08, 1.28, matAcc, true), -0.24, 1.95, -0.26);

      // Sculpted twin-ring particle accelerator spire (front-right corner)
      const ax = 0.78;
      const az = 0.78;
      add(cyl(0.62, 0.34, matGun, "oct"), ax, 0.72, az);
      // 3 sleek titanium containment struts rising around plasma column
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI * 2) / 3 + 0.3;
        add(rbox(0.07, 1.54, 0.07, matLt, true), ax + Math.cos(a) * 0.22, 1.52, az + Math.sin(a) * 0.22);
      }
      // Restrained central cyan plasma column (tasteful glow intensity!)
      const core = cyl(0.18, 1.48, getGlowMat(CYAN_GLOW, 0.8));
      add(core, ax, 1.52, az);
      pulse.push(core);

      // Lower accelerator ring (spin rotates around Y)
      spin = new THREE.Group();
      spin.position.set(ax, 1.66, az);
      body.add(spin);
      const ring1 = torus(0.92, matAcc);
      ring1.rotation.x = Math.PI / 2 + 0.34;
      spin.add(ring1);
      const ring1Inner = torus(0.84, getGlowMat(CYAN_GLOW, 0.8), true);
      ring1Inner.rotation.x = Math.PI / 2 + 0.34;
      spin.add(ring1Inner);

      // Upper counter-rotating accelerator ring (spin2 rotates around -Y)
      spin2 = new THREE.Group();
      spin2.position.set(ax, 2.08, az);
      body.add(spin2);
      const ring2 = torus(0.7, matLt);
      ring2.rotation.x = Math.PI / 2 - 0.36;
      spin2.add(ring2);
      const ring2Glow = torus(0.64, getGlowMat(CYAN_GLOW, 0.84), true);
      ring2Glow.rotation.x = Math.PI / 2 - 0.36;
      spin2.add(ring2Glow);

      // Crown plasma focal orb
      const orb = sph(0.32, getGlowMat(CYAN_GLOW, 0.9), true);
      add(orb, ax, 2.46, az);
      pulse.push(orb);

      // Tall telemetry comms spire on rear-left penthouse
      add(cyl(0.055, 1.06, matLt), -0.68, 2.38, -0.68);
      add(sph(0.1, getGlowMat(colorHex, 0.9), true), -0.68, 2.94, -0.68);

      smokePos = new THREE.Vector3(-0.2, 1.98, -0.2);
      topY = 3.04;
      break;
    }

    case "turret": {
      // Sentry Turret (1x1) — Armored Octagonal Pillbox + Rotating Twin-Autocannon Turret
      body.add(foundationPad(1, 1, colorHex, 0.16));

      // Armored octagonal pillbox base + sloped armor collar
      add(cyl(0.84, 0.24, matDk, "oct"), 0, 0.28, 0);
      add(cyl(0.56, 0.24, matCer, "oct"), 0, 0.48, 0);
      const pwrRing = torus(0.56, getGlowMat(CYAN_GLOW, 0.85), true);
      pwrRing.rotation.x = Math.PI / 2;
      add(pwrRing, 0, 0.42, 0);
      trackPowerGlow(pwrRing, powerGlow);

      // Sleek rotating twin-autocannon armored turret
      turret = new THREE.Group();
      turret.position.set(0, 0.65, 0);
      body.add(turret);

      turret.add(meshOf(geoSentryPod, matCer));
      // Faction-painted cheek armor & top stripe
      add(rbox(0.32, 0.055, 0.46, matAcc, true), 0, 0.155, -0.06, turret);
      add(rbox(0.42, 0.14, 0.18, matDk, true), 0, 0.02, -0.44, turret);

      // Glowing target-lock optical sensor (tracked by powerGlow)
      add(rbox(0.18, 0.1, 0.16, matGun, true), 0, 0.2, -0.06, turret);
      const sight = sph(0.095, getGlowMat(CYAN_GLOW, 0.92), true);
      add(sight, 0, 0.21, 0.03, turret);
      trackPowerGlow(sight, powerGlow);

      // Recoil twin autocannons (mounted at z=0.26 per anim.ts)
      recoil = new THREE.Group();
      recoil.position.set(0, 0.02, 0.26);
      turret.add(recoil);
      add(rbox(0.38, 0.16, 0.18, matDk, true), 0, 0, 0, recoil);
      for (const bx of [-0.12, 0.12]) {
        const shroud = cyl(0.095, 0.3, matCer);
        shroud.rotation.x = Math.PI / 2;
        add(shroud, bx, 0, 0.16, recoil);
        const barrel = cyl(0.062, 0.74, matGun);
        barrel.rotation.x = Math.PI / 2;
        add(barrel, bx, 0, 0.38, recoil);
        const flash = cyl(0.088, 0.1, matLt, "oct");
        flash.rotation.x = Math.PI / 2;
        add(flash, bx, 0, 0.75, recoil);
      }

      smokePos = new THREE.Vector3(0, 0.84, 0);
      topY = 1.06;
      break;
    }

    case "arc": {
      // Arc Coil (1x1) — Iconic Futuristic Tesla/Arc Spire
      body.add(foundationPad(1, 1, colorHex, 0.16));

      // Armored octagonal insulated pedestal + faction buttress fins
      add(cyl(0.82, 0.22, matDk, "oct"), 0, 0.26, 0);
      add(cyl(0.54, 0.32, matCer, "oct"), 0, 0.48, 0);
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI * 2) / 3;
        const fin = rbox(0.11, 0.38, 0.26, matAcc, true);
        fin.rotation.y = -a + Math.PI / 2;
        add(fin, Math.cos(a) * 0.34, 0.42, Math.sin(a) * 0.34);
      }

      // Central conductive core mast
      add(cyl(0.18, 0.86, matGun), 0, 0.96, 0);

      // Stepped copper-chrome induction coils + glowing cyan inner rings (tracked by powerGlow!)
      for (const [ry, rd] of [
        [0.72, 0.7],
        [0.95, 0.56],
        [1.17, 0.43],
      ]) {
        const coil = torus(rd, matCopper);
        coil.rotation.x = Math.PI / 2;
        add(coil, 0, ry, 0);
        trackPowerGlow(coil, powerGlow);

        const arcRing = torus(rd * 0.86, getGlowMat(CYAN_GLOW, 0.82), true);
        arcRing.rotation.x = Math.PI / 2;
        add(arcRing, 0, ry + 0.04, 0);
        trackPowerGlow(arcRing, powerGlow);
      }

      // Triple lightning-rod stabilizer arms around the coils
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI * 2) / 3 + Math.PI / 3;
        const rod = cyl(0.04, 0.78, matLt);
        rod.position.set(Math.cos(a) * 0.34, 0.94, Math.sin(a) * 0.34);
        rod.rotation.z = Math.cos(a) * 0.16;
        rod.rotation.x = -Math.sin(a) * 0.16;
        body.add(rod);
        const prong = sph(0.075, matCopper);
        add(prong, Math.cos(a) * 0.27, 1.34, Math.sin(a) * 0.27);
      }

      // Crackling glowing cyan plasma crown sphere + tilted plasma hoop
      const orb = sph(0.36, getGlowMat(CYAN_GLOW, 0.94), true);
      add(orb, 0, 1.44, 0);
      trackPowerGlow(orb, powerGlow);
      pulse.push(orb);

      const halo = torus(0.5, getGlowMat(CYAN_GLOW, 0.8), true);
      halo.rotation.x = Math.PI / 2 + 0.42;
      add(halo, 0, 1.44, 0);
      trackPowerGlow(halo, powerGlow);

      smokePos = new THREE.Vector3(0, 0.96, 0);
      topY = 1.72;
      break;
    }

    case "purifier": {
      // Ore Purifier (2x2) — Twin Curved Centrifuges, Transfer Manifolds & Glowing Smelting Core
      body.add(foundationPad(2, 2, colorHex, 0.2));

      // Armored rear smelting & control house
      add(rbox(1.62, 0.62, 0.88, matDk), 0, 0.51, -0.44);
      add(rbox(1.38, 0.12, 0.74, matCer, true), 0, 0.84, -0.44);
      add(rbox(1.16, 0.08, 0.12, matAcc, true), 0, 0.91, -0.1);
      // Glowing molten-amber smelting core viewport
      add(rbox(0.76, 0.3, 0.06, getGlowMat(AMBER_GLOW, 0.88), true), 0, 0.54, 0.02);
      // Exhaust stack
      add(cyl(0.16, 0.92, matGun), 0.58, 1.24, -0.52);

      // Twin curved LatheGeometry amber-ringed centrifuges
      for (const sx of [-0.48, 0.48]) {
        const cent = meshOf(geoCentrifuge, matCer);
        cent.scale.set(0.68, 1.38, 0.68);
        add(cent, sx, 0.22, 0.46);
        const copperBand = torus(0.64, matCopper, true);
        copperBand.rotation.x = Math.PI / 2;
        add(copperBand, sx, 0.88, 0.46);
        const amberBand = torus(0.58, getGlowMat(AMBER_GLOW, 0.88), true);
        amberBand.rotation.x = Math.PI / 2;
        add(amberBand, sx, 1.24, 0.46);
        pulse.push(amberBand);
        // Feed pipe from centrifuge back into smelting core
        const feed = cyl(0.09, 0.72, matLt);
        feed.rotation.x = Math.PI / 2;
        add(feed, sx, 0.78, 0.08);
      }

      // Overhead cross-transfer manifold bridging both centrifuges
      const manifold = cyl(0.11, 1.06, matCopper);
      manifold.rotation.z = Math.PI / 2;
      add(manifold, 0, 1.44, 0.46);
      add(cyl(0.18, 0.14, matAcc, "oct"), 0, 1.44, 0.46);

      smokePos = new THREE.Vector3(0.58, 1.72, -0.52);
      topY = 1.78;
      break;
    }

    case "depot": {
      // Service Depot (3x2) — Recessed Repair Pad, Twin Heavy Gantry Arches & Sliding Welding Crane
      body.add(foundationPad(3, 2, colorHex, 0.2));

      // Recessed metallic vehicle repair floor pad + hydraulic lift deck + green status strips
      add(rbox(2.3, 0.06, 1.24, matGun, true), 0.04, 0.24, 0.14);
      add(rbox(1.54, 0.04, 0.88, matDk, true), 0.04, 0.27, 0.14);
      for (const sz of [-0.42, 0.7]) {
        add(rbox(1.86, 0.03, 0.06, getGlowMat(HEAL_GLOW, 0.84), true), 0.04, 0.28, sz);
      }

      // Twin heavy gantry arch columns & overhead structural girder rail
      for (const gx of [-1.14, 1.14]) {
        add(rbox(0.22, 1.34, 0.24, matCer, true), gx, 0.88, -0.66);
        const knee = rbox(0.16, 0.36, 0.44, matDk, true);
        knee.rotation.x = 0.45;
        add(knee, gx, 1.38, -0.44);
        // Front low anchor bollard
        add(rbox(0.2, 0.32, 0.2, matDk, true), gx, 0.38, 0.68);
      }
      add(rbox(2.56, 0.18, 0.26, matDk, true), 0, 1.56, -0.66);
      add(rbox(2.42, 0.08, 0.3, matAcc, true), 0, 1.66, -0.66);

      // Rear diagnostic control kiosk with glass terminal
      add(rbox(0.68, 0.56, 0.34, matCer, true), -0.62, 0.5, -0.64);
      add(rbox(0.48, 0.18, 0.05, matGlass, true), -0.62, 0.58, -0.45);

      // Sliding animated overhead welding crane arm (slides along X in anim.ts!)
      crane = new THREE.Group();
      crane.position.set(0.0, 1.4, -0.66);
      body.add(crane);
      add(rbox(0.42, 0.24, 0.34, matCer, true), 0, 0, 0, crane);
      add(rbox(0.44, 0.07, 0.36, matHaz, true), 0, -0.1, 0, crane);
      // Cantilevered articulated welding boom reaching over the service pad
      add(rbox(0.13, 0.13, 1.14, matLt, true), 0, -0.04, 0.56, crane);
      add(rbox(0.12, 0.28, 0.12, matGun, true), 0, -0.2, 1.04, crane);
      const weldHead = sph(0.105, getGlowMat(CYAN_GLOW, 0.94), true);
      add(weldHead, 0, -0.35, 1.04, crane);
      pulse.push(weldHead);

      // Corner heal-bay status beacons
      for (const [bx, bz] of [
        [-1.14, 0.68],
        [1.14, 0.68],
      ]) {
        const b = sph(0.09, getGlowMat(HEAL_GLOW, 0.88), true);
        add(b, bx, 0.58, bz);
        pulse.push(b);
      }

      smokePos = new THREE.Vector3(-0.82, 1.15, -0.45);
      topY = 1.82;
      break;
    }

    case "superweapon": {
      // Underground ICBM Nuclear Silo (3x3) — Reinforced Octagonal Apron, Parted Blast Doors & Towering Multi-Stage ICBM
      body.add(foundationPad(3, 3, colorHex, 0.24));

      const matIcbmWhite = getChassisMat("#e8eef4", 0.3, 0.34);
      const matIcbmCrimson = getChassisMat("#c9222b", 0.34, 0.42);

      // Massive reinforced octagonal concrete/steel launch apron
      add(cyl(2.74, 0.34, matDk, "oct"), 0, 0.4, 0);
      add(cyl(2.42, 0.16, matCer, "oct"), 0, 0.62, 0);

      // Yellow/black octagonal hazard warning trim perimeter segments around the silo apron
      for (let i = 0; i < 8; i++) {
        const ang = (i * Math.PI) / 4 + Math.PI / 8;
        const rx = Math.cos(ang) * 1.16;
        const rz = Math.sin(ang) * 1.16;
        const trimBlock = rbox(0.56, 0.06, 0.12, i % 2 === 0 ? matHaz : matGraph, true);
        trimBlock.rotation.y = -ang + Math.PI / 2;
        add(trimBlock, rx, 0.72, rz);
      }

      // Recessed circular blast shaft rim, sculpted LatheGeometry launch throat & glowing thermal bay collar
      const shaftThroat = meshOf(geoIonAperture, matGun);
      shaftThroat.scale.set(1.56, 0.38, 1.56);
      add(shaftThroat, 0, 0.44, 0);
      const shaftRim = torus(1.46, matLt);
      shaftRim.rotation.x = Math.PI / 2;
      add(shaftRim, 0, 0.78, 0);
      // Dark recessed launch well interior
      add(cyl(1.18, 0.14, matGraph), 0, 0.64, 0);
      // Glowing deep-bay amber-red launch readiness ring (`powerGlow`)
      const bayRing = torus(1.22, getGlowMat(HEAT_GLOW, 0.88), true);
      bayRing.rotation.x = Math.PI / 2;
      add(bayRing, 0, 0.72, 0);
      trackPowerGlow(bayRing, powerGlow);

      // Parted heavy armored hydraulic blast doors retracted left & right (-X, +X)
      for (const sx of [-1, 1]) {
        const doorGroup = new THREE.Group();
        doorGroup.position.set(sx * 0.94, 0.78, 0);
        body.add(doorGroup);

        // Thick beveled armored blast slab slightly angled open from the shaft rim
        const doorSlab = rbox(0.68, 0.22, 1.38, matCer, true);
        doorSlab.rotation.z = sx * -0.14;
        add(doorSlab, 0, 0.04, 0, doorGroup);
        // Inner dark steel lip + yellow hazard caution stripe facing the shaft
        const innerLip = rbox(0.1, 0.24, 1.34, matHaz, true);
        innerLip.rotation.z = sx * -0.14;
        add(innerLip, sx * -0.34, 0.01, 0, doorGroup);
        // Outer faction armored rib & structural gussets
        add(rbox(0.14, 0.12, 1.12, matAcc, true), sx * 0.24, 0.18, 0, doorGroup);
        for (const gz of [-0.46, 0, 0.46]) {
          add(rbox(0.56, 0.08, 0.1, matDk, true), 0.02 * sx, 0.16, gz, doorGroup);
        }
        // Twin hydraulic door actuator pistons anchored to the outer apron
        for (const pz of [-0.42, 0.42]) {
          const piston = cyl(0.08, 0.48, matLt);
          piston.rotation.z = Math.PI / 2;
          add(piston, sx * 0.42, -0.02, pz, doorGroup);
        }
      }

      // Exhaust flame deflector vents at front & rear (+Z, -Z) with angled concrete hoods & recessed louvers
      for (const sz of [-1, 1]) {
        const vent = new THREE.Group();
        vent.position.set(0, 0.54, sz * 1.14);
        body.add(vent);

        // Reinforced armored flame-trench deflector hood
        add(rbox(0.98, 0.44, 0.44, matDk, true), 0, 0.06, 0, vent);
        const hood = rbox(0.92, 0.14, 0.46, matCer, true);
        hood.rotation.x = sz * 0.26;
        add(hood, 0, 0.3, sz * -0.04, vent);
        // Dark recessed exhaust grate & louvered baffles
        add(rbox(0.76, 0.28, 0.08, matGraph, true), 0, 0.04, sz * 0.21, vent);
        for (const ly of [-0.05, 0.05, 0.14]) {
          add(rbox(0.74, 0.04, 0.1, matGun, true), 0, ly, sz * 0.24, vent);
        }
        // Hazard exhaust warning bar + faction trim
        add(rbox(0.84, 0.055, 0.07, matHaz, true), 0, 0.24, sz * 0.2, vent);
        add(rbox(0.42, 0.06, 0.06, matAcc, true), 0, 0.38, sz * -0.08, vent);
      }

      // 4 corner flashing radiation warning beacons (`pulse`, `powerGlow`)
      for (const [bx, bz] of [
        [-1.12, -1.12],
        [1.12, -1.12],
        [-1.12, 1.12],
        [1.12, 1.12],
      ]) {
        add(rbox(0.32, 0.56, 0.32, matDk, true), bx, 0.52, bz);
        add(rbox(0.36, 0.1, 0.36, matHaz, true), bx, 0.82, bz);
        add(cyl(0.14, 0.28, matGun, "oct"), bx, 0.98, bz);
        const radBeacon = sph(0.2, getGlowMat(AMBER_GLOW, 0.98), true);
        add(radBeacon, bx, 1.18, bz);
        trackPowerGlow(radBeacon, powerGlow);
        pulse.push(radBeacon);
      }

      // Vertical umbilical service mast beside the missile inside the shaft rim
      add(rbox(0.12, 1.85, 0.14, matGun, true), -0.52, 1.62, -0.44);
      add(rbox(0.08, 1.65, 0.08, matHaz, true), -0.52, 1.62, -0.36);
      for (const uy of [1.22, 1.82, 2.34]) {
        const arm = rbox(0.38, 0.06, 0.08, matLt, true);
        arm.rotation.y = -0.68;
        add(arm, -0.34, uy, -0.28);
      }

      // Towering White-and-Crimson Multi-Stage ICBM Thermonuclear Missile standing upright in the shaft!
      const icbm = new THREE.Group();
      icbm.position.set(0, 0.58, 0);
      body.add(icbm);

      // Engine bell & subtle warm pre-ignition core glow down inside the shaft
      add(cyl(0.5, 0.22, matGun, "taper"), 0, 0.12, 0, icbm);
      const preGlow = cyl(0.36, 0.08, getGlowMat(HEAT_GLOW, 0.86));
      add(preGlow, 0, 0.06, 0, icbm);
      trackPowerGlow(preGlow, powerGlow);

      // 4 heavy swept aerodynamic launch stabilizer fins at Stage 1 base
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        const fin = rbox(0.08, 0.54, 0.38, matIcbmCrimson, true);
        fin.position.set(Math.cos(a) * 0.36, 0.36, Math.sin(a) * 0.36);
        fin.rotation.y = -a + Math.PI / 2;
        icbm.add(fin);
      }

      // Stage 1 white main booster fuselage + bold crimson & faction strategic bands
      add(cyl(0.56, 1.02, matIcbmWhite), 0, 0.68, 0, icbm);
      add(cyl(0.585, 0.18, matIcbmCrimson), 0, 0.42, 0, icbm);
      add(cyl(0.585, 0.12, matAcc), 0, 0.94, 0, icbm);
      // Gunmetal interstage separation collar
      add(cyl(0.54, 0.16, matGun, "taper"), 0, 1.24, 0, icbm);

      // Stage 2 upper fuselage (white ceramic + crimson warhead collar)
      add(cyl(0.46, 0.86, matIcbmWhite), 0, 1.72, 0, icbm);
      add(cyl(0.485, 0.16, matIcbmCrimson), 0, 1.98, 0, icbm);
      add(cyl(0.48, 0.07, matGun), 0, 2.14, 0, icbm);

      // Glowing vertical telemetry strips running up Stage 1 & Stage 2 (`powerGlow`, `pulse`)
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2;
        const tx = Math.cos(a) * 0.255;
        const tz = Math.sin(a) * 0.255;
        const tStrip = rbox(0.045, 0.58, 0.045, getGlowMat(CYAN_GLOW, 0.95), true);
        add(tStrip, tx, 1.64, tz, icbm);
        trackPowerGlow(tStrip, powerGlow);
        if (i % 2 === 0) pulse.push(tStrip);

        const lowerLed = rbox(0.05, 0.12, 0.05, getGlowMat(AMBER_GLOW, 0.94), true);
        add(lowerLed, Math.cos(a) * 0.3, 0.72, Math.sin(a) * 0.3, icbm);
        trackPowerGlow(lowerLed, powerGlow);
      }

      // Pointed aerodynamic ogive thermonuclear warhead nosecone (crimson-and-white + metallic tip!)
      const noseBase = meshOf(geoMissileCone, matIcbmCrimson);
      noseBase.scale.set(0.46, 0.78, 0.46);
      add(noseBase, 0, 2.54, 0, icbm);
      // Crisp white heat-shield ring + gleaming titanium warhead apex needle
      const noseBand = torus(0.36, matIcbmWhite, true);
      noseBand.rotation.x = Math.PI / 2;
      add(noseBand, 0, 2.34, 0, icbm);
      add(cyl(0.06, 0.24, matLt), 0, 2.94, 0, icbm);
      const warheadTip = sph(0.11, getGlowMat(HEAT_GLOW, 0.96), true);
      add(warheadTip, 0, 3.06, 0, icbm);
      trackPowerGlow(warheadTip, powerGlow);
      pulse.push(warheadTip);

      smokePos = new THREE.Vector3(-0.85, 0.82, -0.85);
      topY = 3.72;
      break;
    }

    case "derrick": {
      // Oil Derrick (2x2) — Detailed Industrial Nodding Pumpjack
      body.add(foundationPad(2, 2, colorHex, 0.2));

      // Bolted steel machinery skid, gearbox housing & wellhead assembly (+Z)
      add(rbox(1.62, 0.15, 1.62, matDk, true), 0, 0.275, 0);
      add(rbox(0.54, 0.34, 0.56, matGun, true), 0.18, 0.52, -0.36);
      // Rotary crank flywheel on side of gearbox
      const flywheel = cyl(0.36, 0.08, matLt);
      flywheel.rotation.z = Math.PI / 2;
      add(flywheel, 0.48, 0.54, -0.38);

      // Wellhead collar & flanged drill pipe at front
      add(cyl(0.34, 0.42, matGun, "oct"), 0.18, 0.56, 0.56);
      add(cyl(0.24, 0.12, matAcc, "oct"), 0.18, 0.78, 0.56);

      // Sculpted LatheGeometry crude storage tank + connecting steel piping + faction beacon
      const tank = meshOf(geoSilo, matCer);
      tank.scale.set(0.74, 1.12, 0.74);
      add(tank, -0.48, 0.24, -0.36);
      const tankBand = torus(0.7, matAcc, true);
      tankBand.rotation.x = Math.PI / 2;
      add(tankBand, -0.48, 0.9, -0.36);
      // Connecting crude transfer pipe from wellhead to tank
      const pipe = cyl(0.08, 0.82, matLt);
      pipe.rotation.z = Math.PI / 2;
      pipe.rotation.y = 0.72;
      add(pipe, -0.15, 0.44, 0.12);
      const beacon = sph(0.115, getGlowMat(colorHex, 0.92), true);
      add(beacon, -0.48, 1.42, -0.36);
      pulse.push(beacon);

      // Steel lattice A-frame Sampson post rising to the walking-beam saddle pivot
      const pivotX = 0.18;
      const pivotY = 1.6;
      const pivotZ = -0.02;
      for (const [sx, sz] of [
        [-0.26, -0.26],
        [0.26, -0.26],
        [-0.26, 0.26],
        [0.26, 0.26],
      ]) {
        const strut = rbox(0.075, 1.32, 0.075, matLt, true);
        strut.position.set(pivotX + sx * 0.55, 0.96, pivotZ + sz * 0.55);
        strut.rotation.z = sx > 0 ? 0.2 : -0.2;
        strut.rotation.x = sz > 0 ? -0.2 : 0.2;
        body.add(strut);
      }
      add(rbox(0.46, 0.06, 0.46, matGun, true), pivotX, 0.92, pivotZ);
      add(rbox(0.32, 0.06, 0.32, matGun, true), pivotX, 1.28, pivotZ);
      add(rbox(0.26, 0.18, 0.24, matGun, true), pivotX, pivotY, pivotZ);

      // Animated nodding horsehead walking-beam (crane rocks around X in anim.ts!)
      crane = new THREE.Group();
      crane.position.set(pivotX, pivotY, pivotZ);
      body.add(crane);
      // Heavy I-beam with faction web & dark steel flanges
      add(rbox(0.14, 0.16, 1.38, matAcc, true), 0, 0, 0, crane);
      add(rbox(0.2, 0.045, 1.44, matGun, true), 0, 0.095, 0, crane);
      add(rbox(0.2, 0.045, 1.44, matGun, true), 0, -0.095, 0, crane);
      // Authentic extruded curved horsehead nose (+Z) with hazard trim
      add(meshOf(geoHorsehead, matGun), 0, -0.04, 0.66, crane);
      add(rbox(0.22, 0.09, 0.24, matHaz, true), 0, 0.06, 0.68, crane);
      // Vertical steel sucker rod descending straight into wellhead
      add(cyl(0.048, 1.18, matLt), 0, -0.62, 0.58, crane);
      // Heavy rear counterweight & pitman arm (-Z)
      add(rbox(0.34, 0.28, 0.36, matDk, true), 0, -0.08, -0.66, crane);
      add(rbox(0.36, 0.08, 0.24, matHaz, true), 0, -0.08, -0.72, crane);
      add(cyl(0.055, 0.84, matLt), 0, -0.52, -0.44, crane);

      smokePos = new THREE.Vector3(-0.48, 1.44, -0.36);
      topY = 2.24;
      break;
    }

    // =========================================================================
    // NEW MODERN DEFENSES (3): sam, irondome, lasertower
    // =========================================================================
    case "sam": {
      // Patriot SAM Battery (2x2) — Armored Radar-Trailer Pad, Quad-Tube Canister Launcher & Phased-Array Radar
      body.add(foundationPad(2, 2, colorHex, 0.2));

      const matPatriotWhite = getChassisMat("#d4dde6", 0.36, 0.32);

      // Armored launcher trailer concrete-anchored chassis deck + 4 corner hydraulic outriggers
      add(rbox(1.66, 0.2, 1.62, matDk), 0, 0.31, 0);
      for (const [ox, oz] of [
        [-0.78, -0.74],
        [0.78, -0.74],
        [-0.78, 0.74],
        [0.78, 0.74],
      ]) {
        const jack = rbox(0.16, 0.24, 0.16, matGun, true);
        add(jack, ox, 0.28, oz);
        add(rbox(0.22, 0.055, 0.22, matHaz, true), ox, 0.14, oz);
      }
      // Side armored munitions & generator cabinets
      add(rbox(0.32, 0.24, 0.74, matCer, true), -0.68, 0.5, 0.34);
      add(rbox(0.06, 0.12, 0.56, matAcc, true), -0.84, 0.52, 0.34);

      // Phased-array AN/MPQ-65 tracking radar module (front-left)
      const radarPed = new THREE.Group();
      radarPed.position.set(-0.56, 0.52, -0.44);
      radarPed.rotation.y = 0.42;
      body.add(radarPed);
      add(rbox(0.54, 0.22, 0.46, matGun, true), 0, 0.04, 0, radarPed);
      const panelTilt = new THREE.Group();
      panelTilt.position.set(0, 0.34, 0.04);
      panelTilt.rotation.x = -0.34;
      radarPed.add(panelTilt);
      add(rbox(0.56, 0.54, 0.18, matCer, true), 0, 0, 0, panelTilt);
      add(rbox(0.46, 0.44, 0.04, matLt, true), 0, 0, 0.09, panelTilt);
      // Glowing phased-array active scan emitter face & tracking beacon (powerGlow)
      const arrayFace = rbox(0.38, 0.34, 0.03, getGlowMat(CYAN_GLOW, 0.82), true);
      add(arrayFace, 0, 0, 0.115, panelTilt);
      trackPowerGlow(arrayFace, powerGlow);
      const arrayBar = rbox(0.42, 0.05, 0.04, getGlowMat(AMBER_GLOW, 0.94), true);
      add(arrayBar, 0, 0.22, 0.11, panelTilt);
      trackPowerGlow(arrayBar, powerGlow);
      pulse.push(arrayBar);
      add(cyl(0.024, 0.54, matLt), -0.22, 0.42, -0.1, panelTilt);

      // Heavy armored turntable ring + glowing power status collar
      add(cyl(0.92, 0.18, matGun, "oct"), 0.18, 0.48, 0.08);
      const pwrCollar = torus(0.88, getGlowMat(CYAN_GLOW, 0.84), true);
      pwrCollar.rotation.x = Math.PI / 2;
      add(pwrCollar, 0.18, 0.54, 0.08);
      trackPowerGlow(pwrCollar, powerGlow);

      // Rotating Patriot Quad-Tube Missile Canister Launcher (`turret`, `recoil`)
      turret = new THREE.Group();
      turret.position.set(0.18, 0.62, 0.08);
      body.add(turret);

      add(rbox(0.76, 0.18, 0.72, matDk, true), 0, 0.06, 0, turret);
      for (const sx of [-0.36, 0.36]) {
        add(rbox(0.12, 0.42, 0.46, matCer, true), sx, 0.26, -0.06, turret);
        add(rbox(0.04, 0.18, 0.34, matAcc, true), sx + (sx > 0 ? 0.06 : -0.06), 0.28, -0.06, turret);
        const ram = cyl(0.055, 0.52, matLt);
        ram.rotation.x = 0.32;
        add(ram, sx * 0.72, 0.36, 0.16, turret);
      }

      // Elevated launcher cradle angled sharply skyward
      const pitchCradle = new THREE.Group();
      pitchCradle.position.set(0, 0.46, -0.04);
      pitchCradle.rotation.x = -0.58;
      turret.add(pitchCradle);

      recoil = new THREE.Group();
      recoil.position.set(0, 0.04, 0.12);
      pitchCradle.add(recoil);

      // Structural steel clamping bands binding the 4 angled Patriot canisters
      for (const rz of [-0.38, 0.22]) {
        add(rbox(0.68, 0.58, 0.08, matGun, true), 0, 0, rz, recoil);
      }
      add(rbox(0.66, 0.07, 0.96, matAcc, true), 0, 0.31, -0.08, recoil);

      // 2x2 Quad-tube white/steel Patriot missile canisters with visible ogive warheads
      const matSamTip = getGlowMat(HEAT_GLOW, 0.88);
      for (const cx of [-0.175, 0.175]) {
        for (const cy of [-0.145, 0.145]) {
          add(rbox(0.26, 0.24, 1.24, matPatriotWhite, true), cx, cy, 0, recoil);
          add(rbox(0.28, 0.26, 0.1, matGun, true), cx, cy, 0.58, recoil);
          add(rbox(0.28, 0.26, 0.1, matDk, true), cx, cy, -0.58, recoil);
          // Crisp Patriot warhead nose peeking from launch cap
          const wh = meshOf(geoMissileCone, matSamTip, false, false);
          wh.scale.set(0.12, 0.2, 0.12);
          wh.rotation.x = Math.PI / 2;
          add(wh, cx, cy, 0.68, recoil);
        }
      }

      smokePos = new THREE.Vector3(-0.32, 1.15, -0.35);
      topY = 1.72;
      break;
    }

    case "irondome": {
      // Iron Dome Interceptor (2x2) — Geodesic Radar Dome, Twin 6-Cell Interceptor Pods & Protective Ring
      body.add(foundationPad(2, 2, colorHex, 0.2));

      // Sleek octagonal armored pedestal base + 4 radial armor ribs
      add(cyl(1.66, 0.34, matDk, "oct"), 0, 0.38, 0);
      add(cyl(1.42, 0.14, matCer, "oct"), 0, 0.58, 0);
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        const buttress = rbox(0.2, 0.38, 0.32, matCer, true);
        buttress.rotation.y = -a + Math.PI / 2;
        add(buttress, Math.cos(a) * 0.74, 0.4, Math.sin(a) * 0.74);
        const node = sph(0.09, getGlowMat(CYAN_GLOW, 0.9), true);
        add(node, Math.cos(a) * 0.84, 0.58, Math.sin(a) * 0.84);
        trackPowerGlow(node, powerGlow);
      }

      // Subtle glowing cyan protective perimeter ring around the pedestal
      const shieldRing = torus(1.78, getGlowMat(CYAN_GLOW, 0.84), true);
      shieldRing.rotation.x = Math.PI / 2;
      add(shieldRing, 0, 0.48, 0);
      trackPowerGlow(shieldRing, powerGlow);
      pulse.push(shieldRing);

      // Prominent glowing geodesic-style radar dome (rear-center)
      const domeX = 0;
      const domeZ = -0.38;
      add(cyl(0.84, 0.22, matGun, "oct"), domeX, 0.7, domeZ);
      const radome = meshOf(geoRadome, getChassisMat("#ccd8e4", 0.3, 0.42));
      radome.scale.set(0.78, 0.66, 0.78);
      add(radome, domeX, 0.78, domeZ);
      // Glowing cyan equatorial radar scan ring + meridian rib arcs
      const domeBand = torus(0.78, getGlowMat(CYAN_GLOW, 0.92), true);
      domeBand.rotation.x = Math.PI / 2;
      add(domeBand, domeX, 0.9, domeZ);
      trackPowerGlow(domeBand, powerGlow);
      pulse.push(domeBand);
      const domeCrown = sph(0.14, getGlowMat(CYAN_GLOW, 0.96), true);
      add(domeCrown, domeX, 1.46, domeZ);
      trackPowerGlow(domeCrown, powerGlow);
      pulse.push(domeCrown);

      // Rotating Twin 6-Cell Vertical-Angled Interceptor Missile Turret (`turret`, `recoil`)
      turret = new THREE.Group();
      turret.position.set(0, 0.66, 0.24);
      body.add(turret);

      add(cyl(0.68, 0.16, matGun, "oct"), 0, 0.06, 0, turret);
      add(rbox(0.42, 0.34, 0.42, matCer, true), 0, 0.28, 0, turret);
      add(rbox(0.46, 0.08, 0.44, matAcc, true), 0, 0.44, 0, turret);
      const lockSensor = rbox(0.28, 0.09, 0.06, getGlowMat(CYAN_GLOW, 0.94), true);
      add(lockSensor, 0, 0.32, 0.22, turret);
      trackPowerGlow(lockSensor, powerGlow);

      // Steep vertical-angled Tamir interceptor cradle
      const launchTilt = new THREE.Group();
      launchTilt.position.set(0, 0.34, 0);
      launchTilt.rotation.x = -0.76;
      turret.add(launchTilt);

      recoil = new THREE.Group();
      recoil.position.set(0, 0.06, 0.12);
      launchTilt.add(recoil);

      // Cross-axle linking twin 6-cell pods
      add(rbox(1.18, 0.12, 0.16, matGun, true), 0, 0, -0.06, recoil);

      const matTipCyan = getGlowMat(WHITE_GLOW, 0.95);
      for (const sx of [-0.46, 0.46]) {
        // Armored 6-cell interceptor canister pod
        add(rbox(0.42, 0.32, 0.96, matCer, true), sx, 0.06, 0.02, recoil);
        add(rbox(0.45, 0.08, 0.72, matAcc, true), sx, 0.23, 0, recoil);
        add(rbox(0.44, 0.34, 0.08, matGun, true), sx, 0.06, 0.48, recoil);
        // 6 visible vertical-angled interceptor cells (3x2 grid per pod = 12 interceptors total!)
        for (const mx of [-0.125, 0, 0.125]) {
          for (const my of [-0.07, 0.07]) {
            const cell = cyl(0.086, 0.14, matDk);
            cell.rotation.x = Math.PI / 2;
            add(cell, sx + mx, 0.06 + my, 0.51, recoil);
            const tip = meshOf(geoMissileCone, matTipCyan, false, false);
            tip.scale.set(0.072, 0.13, 0.072);
            tip.rotation.x = Math.PI / 2;
            add(tip, sx + mx, 0.06 + my, 0.6, recoil);
          }
        }
      }

      smokePos = new THREE.Vector3(0, 1.24, -0.2);
      topY = 1.92;
      break;
    }

    case "lasertower": {
      // Helios Laser Battery (2x2) — Tall Faceted Dark-Titanium Spire, Focusing Mirrors & Amber-Gold Crystal Lens
      body.add(foundationPad(2, 2, colorHex, 0.22));

      const matDarkTi = getChassisMat("#1f2630", 0.3, 0.78);

      // Heavy armored octagonal capacitor base + 4 radial cooling fin buttresses
      add(cyl(1.56, 0.38, matDarkTi, "oct"), 0, 0.41, 0);
      add(cyl(1.24, 0.22, matDk, "oct"), 0, 0.68, 0);
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        const fin = rbox(0.18, 0.58, 0.38, matCer, true);
        fin.rotation.y = -a + Math.PI / 2;
        add(fin, Math.cos(a) * 0.66, 0.56, Math.sin(a) * 0.66);
        const stripe = rbox(0.07, 0.44, 0.12, matAcc, true);
        stripe.rotation.y = -a + Math.PI / 2;
        add(stripe, Math.cos(a) * 0.8, 0.58, Math.sin(a) * 0.8);
      }

      // Dramatic tall sleek futuristic faceted dark-titanium spire
      const spire = meshOf(geoLaserSpire, matDarkTi);
      spire.scale.set(1.02, 1.56, 1.02);
      add(spire, 0, 0.62, 0);

      // 3 sleek vertical ceramic-steel structural blades rising around the spire
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI * 2) / 3 + Math.PI / 6;
        const blade = rbox(0.1, 1.44, 0.24, matCer, true);
        blade.position.set(Math.cos(a) * 0.36, 1.38, Math.sin(a) * 0.36);
        blade.rotation.y = -a + Math.PI / 2;
        blade.rotation.x = 0.08;
        body.add(blade);
        const edgeGlow = rbox(0.04, 1.12, 0.05, getGlowMat(AMBER_GLOW, 0.9), true);
        edgeGlow.position.set(Math.cos(a) * 0.45, 1.38, Math.sin(a) * 0.45);
        edgeGlow.rotation.y = -a + Math.PI / 2;
        edgeGlow.rotation.x = 0.08;
        body.add(edgeGlow);
        trackPowerGlow(edgeGlow, powerGlow);
      }

      // Glowing amber-gold capacitor rings stepped along the spire
      for (const [ry, rd] of [
        [1.14, 0.72],
        [1.56, 0.56],
        [1.92, 0.44],
      ]) {
        const ring = torus(rd, getGlowMat(AMBER_GLOW, 0.9), true);
        ring.rotation.x = Math.PI / 2;
        add(ring, 0, ry, 0);
        trackPowerGlow(ring, powerGlow);
      }

      // Crown optical assembly: twin focusing mirrors + incandescent amber-gold crystal emitter lens
      const matMirrorGlass = getGlassMat("#ffe08a");
      for (const sx of [-0.36, 0.36]) {
        const arm = rbox(0.1, 0.34, 0.1, matLt, true);
        arm.rotation.z = sx > 0 ? -0.34 : 0.34;
        add(arm, sx * 0.78, 2.16, 0);
        const mirrorBack = rbox(0.08, 0.42, 0.34, matDarkTi, true);
        mirrorBack.rotation.z = sx > 0 ? 0.28 : -0.28;
        add(mirrorBack, sx, 2.32, 0);
        const mirrorFace = rbox(0.04, 0.34, 0.28, matMirrorGlass, true);
        mirrorFace.rotation.z = sx > 0 ? 0.28 : -0.28;
        add(mirrorFace, sx > 0 ? sx - 0.045 : sx + 0.045, 2.31, 0);
      }

      // Incandescent amber-gold crystal emitter lens (pulsing & powerGlow-tracked!)
      const lensCore = sph(0.42, getGlowMat(AMBER_GLOW, 0.98), true);
      add(lensCore, 0, 2.34, 0);
      trackPowerGlow(lensCore, powerGlow);
      pulse.push(lensCore);

      const lensRing = torus(0.56, getGlowMat("#ffe580", 0.94), true);
      lensRing.rotation.x = Math.PI / 2 + 0.36;
      add(lensRing, 0, 2.34, 0);
      trackPowerGlow(lensRing, powerGlow);
      pulse.push(lensRing);

      const topRing = torus(0.36, matGold, true);
      topRing.rotation.x = Math.PI / 2;
      add(topRing, 0, 2.6, 0);

      smokePos = new THREE.Vector3(0, 1.5, 0);
      topY = 2.74;
      break;
    }

    case "thaad": {
      // THAAD Ballistic Missile Defense Battery (2x2) — AN/TPY-2 X-Band Phased-Array Radar & 8-Tube Elevated Interceptor Rack
      body.add(foundationPad(2, 2, colorHex, 0.2));

      const matThaadWhite = getChassisMat("#e2e8ee", 0.34, 0.34);
      const matThaadOlive = getChassisMat("#505c44", 0.48, 0.42);

      // Reinforced tactical concrete equipment deck + 4 corner hydraulic leveling stabilizers
      add(rbox(1.72, 0.18, 1.66, matDk), 0, 0.29, 0);
      for (const [ox, oz] of [
        [-0.8, -0.76],
        [0.8, -0.76],
        [-0.8, 0.76],
        [0.8, 0.76],
      ]) {
        add(rbox(0.15, 0.24, 0.15, matGun, true), ox, 0.28, oz);
        add(rbox(0.22, 0.055, 0.22, matHaz, true), ox, 0.14, oz);
      }

      // Armored Fire-Control / Battle-Management C2 cabinet on rear-left
      add(rbox(0.5, 0.36, 0.62, matThaadOlive, true), -0.58, 0.56, 0.44);
      add(rbox(0.52, 0.08, 0.46, matAcc, true), -0.58, 0.72, 0.44);
      add(rbox(0.06, 0.2, 0.42, matGraph, true), -0.84, 0.55, 0.44);
      // C2 status uplink mast
      add(cyl(0.032, 0.62, matLt), -0.72, 0.96, 0.62);
      const c2Beacon = sph(0.09, getGlowMat(CYAN_GLOW, 0.96), true);
      add(c2Beacon, -0.72, 1.3, 0.62);
      trackPowerGlow(c2Beacon, powerGlow);
      pulse.push(c2Beacon);

      // Prominent AN/TPY-2 Forward-Deployed Angled X-Band Phased-Array Radar Panel (`powerGlow`, `pulse`)
      const tpyBase = new THREE.Group();
      tpyBase.position.set(-0.52, 0.46, -0.34);
      tpyBase.rotation.y = 0.36;
      body.add(tpyBase);

      add(rbox(0.68, 0.22, 0.54, matGun, true), 0, 0.08, 0, tpyBase);
      // Rear hydraulic elevation braces supporting the large X-band array
      for (const bx of [-0.22, 0.22]) {
        const brace = cyl(0.052, 0.62, matLt);
        brace.rotation.x = -0.45;
        add(brace, bx, 0.42, -0.18, tpyBase);
      }

      const tpyPanel = new THREE.Group();
      tpyPanel.position.set(0, 0.52, 0.04);
      tpyPanel.rotation.x = -0.46; // Steep skyward ballistic-tracking tilt
      tpyBase.add(tpyPanel);

      // Distinctive wide beveled AN/TPY-2 phased-array housing
      add(rbox(0.84, 0.64, 0.22, matThaadOlive, true), 0, 0, 0, tpyPanel);
      add(rbox(0.88, 0.68, 0.08, matCer, true), 0, 0, 0.08, tpyPanel);
      add(rbox(0.76, 0.07, 0.24, matAcc, true), 0, 0.34, 0, tpyPanel);

      // Glowing X-band phased-array emitter face with grid ribs (`powerGlow`)
      const tpyFace = rbox(0.72, 0.52, 0.04, getGlowMat("#28c8ff", 0.8), true);
      add(tpyFace, 0, 0, 0.125, tpyPanel);
      trackPowerGlow(tpyFace, powerGlow);
      for (const gx of [-0.22, 0, 0.22]) {
        add(rbox(0.028, 0.52, 0.055, matGun, true), gx, 0, 0.132, tpyPanel);
      }
      for (const gy of [-0.14, 0.14]) {
        add(rbox(0.72, 0.028, 0.055, matGun, true), 0, gy, 0.132, tpyPanel);
      }

      // Prominent glowing cyan X-band sweep bar across the radar face (`powerGlow`, `pulse`)
      const sweepBar = rbox(0.74, 0.08, 0.055, getGlowMat(CYAN_GLOW, 0.98), true);
      add(sweepBar, 0, 0.04, 0.148, tpyPanel);
      trackPowerGlow(sweepBar, powerGlow);
      pulse.push(sweepBar);

      // Gold-cyan top IFF tracking emitter bar on AN/TPY-2 crown
      const iffBar = rbox(0.42, 0.06, 0.07, getGlowMat(AMBER_GLOW, 0.94), true);
      add(iffBar, 0, 0.37, 0.12, tpyPanel);
      trackPowerGlow(iffBar, powerGlow);
      pulse.push(iffBar);

      // Heavy armored octagonal launcher turntable ring + glowing cyan-gold shield power collar
      add(cyl(0.92, 0.16, matGun, "oct"), 0.26, 0.45, 0.08);
      const shieldCollar = torus(0.9, getGlowMat(CYAN_GLOW, 0.88), true);
      shieldCollar.rotation.x = Math.PI / 2;
      add(shieldCollar, 0.26, 0.51, 0.08);
      trackPowerGlow(shieldCollar, powerGlow);
      const goldTrimRing = torus(0.78, matGold, true);
      goldTrimRing.rotation.x = Math.PI / 2;
      add(goldTrimRing, 0.26, 0.54, 0.08);

      // Rotating Heavy 8-Tube Elongated White/Olive THAAD TEL Interceptor Canister Rack (`turret`, `recoil`)
      turret = new THREE.Group();
      turret.position.set(0.26, 0.58, 0.08);
      body.add(turret);

      // Armored launcher carriage deck & twin heavy elevation trunnions
      add(rbox(0.84, 0.16, 0.78, matThaadOlive, true), 0, 0.06, 0, turret);
      for (const sx of [-0.42, 0.42]) {
        add(rbox(0.11, 0.44, 0.48, matCer, true), sx, 0.26, -0.06, turret);
        add(rbox(0.04, 0.18, 0.36, matAcc, true), sx + (sx > 0 ? 0.06 : -0.06), 0.28, -0.06, turret);
        // Steep hydraulic launcher elevation piston
        const ram = cyl(0.054, 0.62, matLt);
        ram.rotation.x = 0.24;
        add(ram, sx * 0.74, 0.38, 0.16, turret);
      }
      // Armored rear exhaust blast deflector shield
      const blastShield = rbox(0.82, 0.34, 0.08, matDk, true);
      blastShield.rotation.x = 0.32;
      add(blastShield, 0, 0.2, -0.42, turret);

      // Steeply elevated THAAD canister cradle (~50 degrees = -0.87 rad!)
      const pitchCradle = new THREE.Group();
      pitchCradle.position.set(0, 0.46, -0.04);
      pitchCradle.rotation.x = -0.87;
      turret.add(pitchCradle);

      recoil = new THREE.Group();
      recoil.position.set(0, 0.04, 0.14);
      pitchCradle.add(recoil);

      // Heavy olive-drab & gunmetal clamping bands binding the 8 elongated THAAD launch tubes
      for (const rz of [-0.52, 0.02, 0.52]) {
        add(rbox(0.82, 0.44, 0.09, matThaadOlive, true), 0, 0, rz, recoil);
      }
      // Side stiffening rails & top faction armor bridge
      for (const sx of [-0.41, 0.41]) {
        add(rbox(0.06, 0.34, 1.38, matGun, true), sx, 0, 0, recoil);
      }
      add(rbox(0.76, 0.065, 1.12, matAcc, true), 0, 0.24, -0.04, recoil);
      const rackStatus = rbox(0.56, 0.045, 0.08, getGlowMat(CYAN_GLOW, 0.94), true);
      add(rackStatus, 0, 0.275, 0.48, recoil);
      trackPowerGlow(rackStatus, powerGlow);

      // 8-tube (4 wide x 2 high) elongated white/olive cylindrical THAAD interceptor canisters + gleaming kill-vehicle tips!
      const matKkvTip = getGlowMat(WHITE_GLOW, 0.96);
      const colXs = [-0.285, -0.095, 0.095, 0.285];
      const rowYs = [-0.098, 0.098];
      for (const cx of colXs) {
        for (const cy of rowYs) {
          // Elongated white aerodynamic interceptor canister tube
          const tube = cyl(0.165, 1.48, matThaadWhite, "oct");
          tube.rotation.x = Math.PI / 2;
          add(tube, cx, cy, 0.02, recoil);
          // Olive-drab tactical mid-collar + dark gunmetal muzzle ring + rear exhaust cap
          const midBand = cyl(0.178, 0.24, matThaadOlive, "oct");
          midBand.rotation.x = Math.PI / 2;
          add(midBand, cx, cy, -0.18, recoil);
          const muzzle = cyl(0.18, 0.1, matGun, "oct");
          muzzle.rotation.x = Math.PI / 2;
          add(muzzle, cx, cy, 0.72, recoil);
          const rearCap = cyl(0.175, 0.08, matDk, "oct");
          rearCap.rotation.x = Math.PI / 2;
          add(rearCap, cx, cy, -0.71, recoil);
          // Pointed exo-atmospheric THAAD interceptor warhead nose peeking from tube
          const tip = meshOf(geoMissileCone, matKkvTip, false, false);
          tip.scale.set(0.095, 0.2, 0.095);
          tip.rotation.x = Math.PI / 2;
          add(tip, cx, cy, 0.84, recoil);
        }
      }

      smokePos = new THREE.Vector3(-0.52, 1.05, -0.45);
      topY = 2.08;
      break;
    }

    // =========================================================================
    // NEW STRUCTURES & UPGRADES (5): coalplant, fusion, satlink, coalmine, barracks2
    // =========================================================================
    case "coalplant": {
      // Thermal Coal Plant (2x2) — Boiler Hall, Coal Bunker Hopper, Conveyor Ramp & Twin Banded Smokestacks
      body.add(foundationPad(2, 2, colorHex, 0.22));

      const matCoal = getChassisMat("#151920", 0.3, 0.44);

      // Heavy industrial boiler hall (right side)
      add(rbox(1.06, 0.82, 1.48, matDk), 0.34, 0.62, 0.02);
      add(rbox(0.88, 0.22, 1.24, matCer), 0.34, 1.1, 0.02);
      // Faction fascia bands along upper boiler hall
      add(rbox(1.1, 0.1, 0.18, matAcc, true), 0.34, 0.98, 0.68);
      add(rbox(1.1, 0.1, 0.18, matAcc, true), 0.34, 0.98, -0.64);
      // Glowing molten-orange furnace grates along front & side walls
      for (const vz of [-0.36, 0.04, 0.44]) {
        const fVent = rbox(0.05, 0.24, 0.24, getGlowMat(HEAT_GLOW, 0.92), true);
        add(fVent, 0.88, 0.56, vz);
        if (vz === 0.04) pulse.push(fVent);
      }
      const frontFurnace = rbox(0.68, 0.24, 0.06, getGlowMat(AMBER_GLOW, 0.92), true);
      add(frontFurnace, 0.34, 0.54, 0.77);
      pulse.push(frontFurnace);

      // Dark coal bunker hopper (front-left) with sculpted glossy coal mound
      add(rbox(0.76, 0.34, 0.74, matGun, true), -0.54, 0.39, 0.44);
      add(rbox(0.8, 0.06, 0.78, matHaz, true), -0.54, 0.56, 0.44);
      const bunkerCoal = meshOf(geoCoalHeap, matCoal);
      bunkerCoal.scale.set(0.76, 0.82, 0.76);
      add(bunkerCoal, -0.54, 0.46, 0.44);

      // Inclined steel coal conveyor ramp from hopper up into boiler hall
      const conv = new THREE.Group();
      conv.position.set(-0.26, 0.82, 0.36);
      conv.rotation.z = 0.54;
      body.add(conv);
      add(rbox(0.86, 0.08, 0.26, matLt, true), 0, 0, 0, conv);
      add(rbox(0.82, 0.05, 0.18, matGraph, true), 0, 0.05, 0, conv);
      for (const cx of [-0.26, 0, 0.26]) {
        add(sph(0.11, matCoal), cx, 0.09, 0, conv);
      }
      add(rbox(0.08, 0.48, 0.08, matGun, true), -0.26, 0.54, 0.36);

      // Twin tall banded industrial smokestacks (rear)
      for (const sx of [-0.46, 0.28]) {
        add(cyl(0.36, 1.72, matCer, "taper"), sx, 1.12, -0.56);
        // Bold warning / faction collar bands near stack crown
        const band1 = torus(0.31, matAcc, true);
        band1.rotation.x = Math.PI / 2;
        add(band1, sx, 1.62, -0.56);
        const band2 = torus(0.28, matHaz, true);
        band2.rotation.x = Math.PI / 2;
        add(band2, sx, 1.8, -0.56);
        add(cyl(0.32, 0.08, matGun), sx, 1.98, -0.56);
        const flueGlow = cyl(0.19, 0.04, getGlowMat(HEAT_GLOW, 0.82));
        add(flueGlow, sx, 2.01, -0.56);
      }

      smokePos = new THREE.Vector3(-0.46, 2.04, -0.56);
      topY = 2.12;
      break;
    }

    case "fusion": {
      // Tokamak Fusion Reactor (2x2 in-place Power Plant Tier-3 upgrade!)
      body.add(foundationPad(2, 2, colorHex, 0.24));

      // Compact futuristic clean-energy armored plinth sized cleanly for 2x2 upgrade footprint
      add(rbox(1.82, 0.3, 1.72, matDk), 0, 0.38, 0);
      add(rbox(1.68, 0.07, 1.56, matCer, true), 0, 0.55, 0);
      for (const sz of [-0.78, 0.78]) {
        add(rbox(1.42, 0.06, 0.08, matAcc, true), 0, 0.56, sz);
      }

      // Flanking cryogenic spherical coolant tanks (fitted inside 2x2 footprint)
      for (const sx of [-0.76, 0.76]) {
        add(cyl(0.32, 0.22, matGun, "oct"), sx, 0.62, -0.32);
        add(sph(0.48, matLt), sx, 0.96, -0.36);
        const tankBand = torus(0.49, matAcc, true);
        tankBand.rotation.x = Math.PI / 2;
        add(tankBand, sx, 0.96, -0.36);
        // Coolant feed pipe into central tokamak
        const pipe = cyl(0.085, 0.56, matLt);
        pipe.rotation.z = Math.PI / 2;
        add(pipe, sx * 0.68, 0.92, -0.22);
        // Front diagnostic cooling module
        add(rbox(0.36, 0.38, 0.52, matCer, true), sx, 0.74, 0.36);
        add(rbox(0.28, 0.14, 0.04, getGlowMat(CYAN_GLOW, 0.85), true), sx, 0.76, 0.63);
      }

      // Prominent glowing cyan magnetic-confinement TorusGeometry plasma ring (`spin` + `pulse`)
      spin = new THREE.Group();
      spin.position.set(0, 0.94, 0);
      body.add(spin);

      const plasmaOuter = meshOf(geoFusionPlasma, getGlowMat(CYAN_GLOW, 0.94), false, false);
      plasmaOuter.rotation.x = Math.PI / 2;
      spin.add(plasmaOuter);
      pulse.push(plasmaOuter);

      const plasmaCore = meshOf(geoFusionPlasmaCore, getGlowMat(WHITE_GLOW, 0.98), false, false);
      plasmaCore.rotation.x = Math.PI / 2;
      spin.add(plasmaCore);
      pulse.push(plasmaCore);

      // 4 swirling plasma node sparks riding inside the tokamak torus
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2;
        const spark = sph(0.14, getGlowMat(WHITE_GLOW, 0.96), true);
        add(spark, Math.cos(a) * 0.68, 0, Math.sin(a) * 0.68, spin);
      }

      // 8 radial superconducting D-shaped toroidal magnet coils wrapping the plasma ring
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        const coilGrp = new THREE.Group();
        coilGrp.position.set(Math.cos(a) * 0.68, 0.94, Math.sin(a) * 0.68);
        coilGrp.rotation.y = -a + Math.PI / 2;
        body.add(coilGrp);

        // Outer C-clamp superconducting magnet housing
        add(rbox(0.11, 0.56, 0.12, matCer, true), 0, 0, 0.24, coilGrp);
        add(rbox(0.12, 0.1, 0.42, matLt, true), 0, 0.26, 0.06, coilGrp);
        add(rbox(0.12, 0.1, 0.42, matLt, true), 0, -0.26, 0.06, coilGrp);
        add(rbox(0.06, 0.44, 0.06, i % 2 === 0 ? matAcc : matCopper, true), 0, 0, 0.3, coilGrp);
      }

      // Central solenoid core & sculpted clean-energy dome crown
      add(cyl(0.56, 0.96, matGun, "oct"), 0, 1.0, 0);
      add(cyl(0.44, 0.72, matGlass), 0, 1.0, 0);
      const crownDome = meshOf(geoFusionDome, matCer);
      crownDome.scale.set(1.04, 0.58, 1.04);
      add(crownDome, 0, 1.38, 0);
      const crownTrim = torus(0.98, matAcc, true);
      crownTrim.rotation.x = Math.PI / 2;
      add(crownTrim, 0, 1.46, 0);
      const topBeacon = sph(0.18, getGlowMat(CYAN_GLOW, 0.96), true);
      add(topBeacon, 0, 2.02, 0);
      pulse.push(topBeacon);

      smokePos = new THREE.Vector3(0, 1.85, 0);
      topY = 2.12;
      break;
    }

    case "satlink": {
      // Defense Satellite Uplink (3x3) — Huge Tilted Telemetry Dish, Uplink Beam Pylon & Orbiting Mini-Satellite
      body.add(foundationPad(3, 3, colorHex, 0.24));

      // Monumental armored orbital command bunker base
      add(rbox(2.56, 0.54, 2.56, matDk), 0, 0.51, 0);
      for (const [bx, bz] of [
        [-1.18, -1.18],
        [1.18, -1.18],
        [-1.18, 1.18],
        [1.18, 1.18],
      ]) {
        add(rbox(0.32, 0.62, 0.32, matCer, true), bx, 0.55, bz);
      }
      // Panoramic mission-control glass + satin faction fascia
      add(rbox(1.56, 0.18, 0.07, matGlass, true), -0.22, 0.58, 1.29);
      add(rbox(0.07, 0.18, 1.56, matGlass, true), -1.29, 0.58, -0.14);
      add(rbox(2.6, 0.1, 2.6, matAcc, true), 0, 0.8, 0);

      // Stepped orbital dish pedestal (rear-left)
      add(cyl(1.18, 0.38, matCer, "oct"), -0.44, 1.02, -0.32);
      add(cyl(0.46, 0.32, matGun, "oct"), -0.44, 1.32, -0.32);

      // Huge tilted LatheGeometry laser-telemetry dish (`spin` rotates smoothly around Y)
      spin = new THREE.Group();
      spin.position.set(-0.44, 1.56, -0.32);
      body.add(spin);
      const dishYoke = rbox(0.36, 0.24, 0.36, matDk, true);
      spin.add(dishYoke);
      const satDish = meshOf(geoParabolicDish, matLt);
      satDish.scale.set(1.58, 1.52, 1.58);
      satDish.rotation.x = 0.72;
      satDish.position.set(0, 0.08, -0.04);
      spin.add(satDish);
      const satRim = torus(1.56, matAcc, true);
      satRim.rotation.x = Math.PI / 2 + 0.72;
      satRim.position.set(0, 0.34, 0.2);
      spin.add(satRim);
      const satFeed = cyl(0.07, 0.66, matGun);
      satFeed.rotation.x = 0.72;
      add(satFeed, 0, 0.36, 0.22, spin);
      const satLaser = sph(0.14, getGlowMat(CYAN_GLOW, 0.96), true);
      add(satLaser, 0, 0.6, 0.44, spin);
      pulse.push(satLaser);

      // Glowing vertical orbital uplink beam pylon (front-right deck)
      const px = 0.78;
      const pz = 0.68;
      add(cyl(0.74, 0.36, matGun, "oct"), px, 1.02, pz);
      add(cyl(0.56, 0.22, matCer, "oct"), px, 1.28, pz);
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI * 2) / 3 + 0.4;
        add(rbox(0.08, 1.08, 0.14, matAcc, true), px + Math.cos(a) * 0.26, 1.66, pz + Math.sin(a) * 0.26);
      }
      const beamCol = cyl(0.15, 1.38, getGlowMat(CYAN_GLOW, 0.92));
      add(beamCol, px, 1.84, pz);
      pulse.push(beamCol);
      const beamCrown = torus(0.46, getGlowMat(CYAN_GLOW, 0.88), true);
      beamCrown.rotation.x = Math.PI / 2;
      add(beamCrown, px, 2.28, pz);
      pulse.push(beamCrown);

      // Levitating rotating miniature Defense Satellite orbiting gently above the roof (`spin2`)
      spin2 = new THREE.Group();
      spin2.position.set(0.14, 2.66, 0.12);
      body.add(spin2);

      // Subtle holographic orbital track ring
      const orbitTrack = meshOf(geoSatOrbitTrack, getGlowMat(CYAN_GLOW, 0.46), false, false);
      orbitTrack.rotation.x = Math.PI / 2;
      spin2.add(orbitTrack);

      // Miniature Defense Satellite offset at orbital radius r = 0.64 so it orbits around the roof!
      const miniSat = new THREE.Group();
      miniSat.position.set(0.64, 0.04, 0);
      miniSat.rotation.z = -0.18;
      spin2.add(miniSat);

      // Gold-foil octagonal satellite bus + ceramic sensor ring
      add(cyl(0.24, 0.22, matGold, "oct"), 0, 0, 0, miniSat);
      add(cyl(0.28, 0.06, matAcc, "oct"), 0, 0.06, 0, miniSat);
      // Twin unfolded photovoltaic solar-array wings
      const matSolar = getGlassMat("#2278d8");
      for (const sx of [-0.34, 0.34]) {
        add(rbox(0.46, 0.025, 0.2, matSolar, true), sx, 0, 0, miniSat);
        add(rbox(0.48, 0.018, 0.03, matLt, true), sx, 0, 0, miniSat);
        add(rbox(0.05, 0.03, 0.21, matAcc, true), sx + (sx > 0 ? 0.22 : -0.22), 0, 0, miniSat);
      }
      // Downward-pointing orbital defense laser aperture
      const satLens = sph(0.1, getGlowMat(CYAN_GLOW, 0.98), true);
      add(satLens, 0, -0.14, 0, miniSat);
      pulse.push(satLens);
      add(cyl(0.03, 0.2, matLt), 0, 0.18, 0, miniSat);

      smokePos = new THREE.Vector3(-0.55, 1.55, -0.55);
      topY = 3.04;
      break;
    }

    case "coalmine": {
      // Neutral Coal Mine (2x2) — Rugged Steel Headframe Gantry, Glossy Coal Heap, Chute & Ownership Beacon
      body.add(foundationPad(2, 2, colorHex, 0.2));

      const matCoal = getChassisMat("#141820", 0.28, 0.46);

      // Recessed armored mine shaft collar (left-rear)
      const hx = -0.24;
      const hz = -0.24;
      add(rbox(0.86, 0.18, 0.86, matGun, true), hx, 0.3, hz);
      add(rbox(0.62, 0.08, 0.62, matGraph, true), hx, 0.36, hz);

      // Rugged 4-legged inclined steel A-frame headframe gantry tower
      for (const [lx, lz] of [
        [-0.32, -0.32],
        [0.32, -0.32],
        [-0.32, 0.32],
        [0.32, 0.32],
      ]) {
        const leg = rbox(0.08, 1.52, 0.08, matLt, true);
        leg.position.set(hx + lx * 0.65, 1.06, hz + lz * 0.65);
        leg.rotation.z = lx > 0 ? 0.15 : -0.15;
        leg.rotation.x = lz > 0 ? -0.15 : 0.15;
        body.add(leg);
      }
      // Horizontal steel cross-girders & headframe crown deck
      add(rbox(0.56, 0.07, 0.56, matDk, true), hx, 0.98, hz);
      add(rbox(0.44, 0.08, 0.44, matGun, true), hx, 1.48, hz);
      add(rbox(0.48, 0.12, 0.48, matCer, true), hx, 1.82, hz);
      add(rbox(0.52, 0.06, 0.52, matAcc, true), hx, 1.9, hz);

      // Twin yellow winding sheave wheels & vertical hoist cables
      for (const sx of [-0.1, 0.1]) {
        const wheel = torus(0.36, matHaz);
        wheel.rotation.y = Math.PI / 2;
        add(wheel, hx + sx, 1.66, hz);
        add(cyl(0.025, 1.24, matLt), hx + sx, 1.0, hz);
      }

      // Hoist winch machinery house behind headframe
      add(rbox(0.52, 0.44, 0.48, matDk, true), -0.66, 0.44, 0.48);
      add(rbox(0.54, 0.07, 0.5, matAcc, true), -0.66, 0.68, 0.48);
      // Angled hoist cable running from winch house up to sheave wheel
      const backCable = cyl(0.028, 1.42, matLt);
      backCable.position.set(-0.46, 1.12, 0.12);
      backCable.rotation.x = -0.48;
      backCable.rotation.z = -0.28;
      body.add(backCable);

      // Dark glossy anthracite coal heap (front-right) + retaining kerbs
      add(rbox(0.86, 0.14, 0.86, matDk, true), 0.44, 0.28, 0.42);
      const coalPile = meshOf(geoCoalHeap, matCoal);
      coalPile.scale.set(0.94, 1.08, 0.94);
      add(coalPile, 0.44, 0.28, 0.42);

      // Angled conveyor chute from headframe hopper onto the coal heap
      const chute = new THREE.Group();
      chute.position.set(0.12, 0.86, 0.1);
      chute.rotation.y = -0.78;
      chute.rotation.z = -0.44;
      body.add(chute);
      add(rbox(0.84, 0.09, 0.26, matLt, true), 0, 0, 0, chute);
      add(rbox(0.16, 0.14, 0.28, matHaz, true), 0.36, 0.02, 0, chute);
      add(rbox(0.08, 0.56, 0.08, matGun, true), 0.18, 0.52, 0.14);

      // Pulsing faction ownership beacon atop headframe mast
      add(cyl(0.045, 0.36, matLt), hx, 2.08, hz);
      const ownerBeacon = sph(0.17, getGlowMat(colorHex, 0.96), true);
      add(ownerBeacon, hx, 2.3, hz);
      pulse.push(ownerBeacon);
      const ownerRing = torus(0.32, getGlowMat(colorHex, 0.84), true);
      ownerRing.rotation.x = Math.PI / 2;
      add(ownerRing, hx, 2.16, hz);
      pulse.push(ownerRing);

      smokePos = new THREE.Vector3(-0.66, 0.82, 0.48);
      topY = 2.46;
      break;
    }

    case "barracks2": {
      // Barracks II Elite Command (2x2) — Reinforced Bunker, Upper Command Deck, Gold Chevrons, Twin Antennas & Banner
      body.add(foundationPad(2, 2, colorHex, 0.22));

      // Reinforced lower garrison bunker + heavy sloped corner bastions
      add(rbox(1.74, 0.78, 1.66, matDk), 0, 0.61, -0.02);
      for (const [bx, bz] of [
        [-0.82, -0.78],
        [0.82, -0.78],
        [-0.82, 0.74],
        [0.82, 0.74],
      ]) {
        add(rbox(0.3, 0.86, 0.3, matCer, true), bx, 0.64, bz);
        add(rbox(0.32, 0.07, 0.32, matGold, true), bx, 1.06, bz);
      }

      // Armored upper command deck perched atop the main bunker
      add(rbox(1.38, 0.44, 1.24, matCer), 0, 1.22, -0.1);
      add(rbox(1.46, 0.09, 1.32, matAcc, true), 0, 1.46, -0.1);
      add(rbox(1.48, 0.055, 1.34, matGold, true), 0, 1.52, -0.1);
      // Panoramic wraparound elite command glass visor
      add(rbox(1.06, 0.18, 0.07, matGlass, true), 0, 1.24, 0.53);
      for (const sx of [-0.7, 0.7]) {
        add(rbox(0.06, 0.16, 0.78, matGlass, true), sx, 1.24, -0.1);
      }

      // Glowing gold/faction elite chevrons mounted prominently on front parapet
      const matEliteGlow = getGlowMat(AMBER_GLOW, 0.94);
      for (const cy of [0.96, 1.08]) {
        const chL = rbox(0.28, 0.055, 0.06, matEliteGlow, true);
        chL.rotation.z = 0.42;
        add(chL, -0.11, cy, 0.84);
        const chR = rbox(0.28, 0.055, 0.06, matEliteGlow, true);
        chR.rotation.z = -0.42;
        add(chR, 0.11, cy, 0.84);
        if (cy === 1.08) pulse.push(chL, chR);
      }
      add(rbox(1.26, 0.08, 0.12, matGold, true), 0, 0.88, 0.82);

      // Expanded illuminated troop deployment portal with armored bollards
      add(rbox(0.84, 0.62, 0.16, matGun, true), 0, 0.52, 0.78);
      add(rbox(0.64, 0.48, 0.05, getGlowMat(WHITE_GLOW, 0.88), true), 0, 0.49, 0.84);
      for (const sx of [-0.52, 0.52]) {
        add(rbox(0.1, 0.34, 0.1, matHaz, true), sx, 0.38, 0.9);
      }

      // Twin tall elite comms antennas on left upper command deck
      for (const [ax, az, ah] of [
        [-0.58, -0.56, 0.84],
        [-0.58, 0.34, 0.66],
      ]) {
        add(cyl(0.036, ah, matLt), ax, 1.54 + ah / 2, az);
        add(rbox(0.28, 0.035, 0.035, matGold, true), ax, 1.54 + ah * 0.72, az);
        const tip = sph(0.075, getGlowMat(CYAN_GLOW, 0.92), true);
        add(tip, ax, 1.56 + ah, az);
        pulse.push(tip);
      }

      // Tall gold-topped mast & waving elite faction banner (`flag`)
      add(cyl(0.058, 1.38, matLt), 0.68, 1.66, 0.54);
      add(sph(0.095, matGold), 0.68, 2.36, 0.54);
      flag = meshOf(geoFlag, matAcc);
      add(flag, 0.68, 2.14, 0.54);

      smokePos = new THREE.Vector3(-0.42, 1.58, -0.44);
      topY = 2.46;
      break;
    }

    // =========================================================================
    // NEW LAND VEHICLES (2): himars, railtank
    // =========================================================================
    case "himars": {
      // HIMARS Hypersonic Launcher — Sleek 6x6 Armored Truck, Sloped Glass Cab & Elevated 6-Tube Pod
      addContactShadow(body, 0.98, 1.24);

      // 6 rugged tactical off-road armored tires with machined alloy rims
      for (const [wx, wz] of [
        [-0.56, 0.68],
        [0.56, 0.68],
        [-0.56, -0.02],
        [0.56, -0.02],
        [-0.56, -0.68],
        [0.56, -0.68],
      ]) {
        const tire = cyl(0.41, 0.24, matGraph);
        tire.rotation.z = Math.PI / 2;
        add(tire, wx, 0.205, wz);
        const rim = cyl(0.22, 0.258, matLt, "oct");
        rim.rotation.z = Math.PI / 2;
        add(rim, wx, 0.205, wz);
      }

      // Low-slung armored 6x6 chassis, wheel-well fenders & side equipment lockers
      add(rbox(0.96, 0.2, 1.96, matGun, true), 0, 0.36, 0);
      add(rbox(1.12, 0.1, 1.82, matCer, true), 0, 0.48, 0);
      for (const sx of [-0.54, 0.54]) {
        add(rbox(0.12, 0.16, 0.64, matDk, true), sx, 0.4, 0.04);
        add(rbox(0.03, 0.06, 0.54, matAcc, true), sx + (sx > 0 ? 0.06 : -0.06), 0.42, 0.04);
      }
      // Heavy front tactical bumper & glowing LED headlights
      add(rbox(1.08, 0.14, 0.14, matDk, true), 0, 0.36, 0.98);
      for (const hx of [-0.36, 0.36]) {
        add(rbox(0.13, 0.055, 0.03, getGlowMat(WHITE_GLOW, 0.92), true), hx, 0.54, 0.98);
      }

      // Sloped modern armored forward cab with tinted panoramic glass windshield
      add(meshOf(geoHimarsCab, matCer), 0, 0.72, 0.62);
      add(rbox(0.78, 0.055, 0.48, matAcc, true), 0, 0.96, 0.54);
      const cabWind = rbox(0.74, 0.18, 0.06, matGlass, true);
      cabWind.rotation.x = -0.36;
      add(cabWind, 0, 0.8, 0.92);
      // Rooftop satellite GPS puck + comms whip
      add(cyl(0.22, 0.055, matLt), 0.18, 1.01, 0.48);
      add(cyl(0.022, 0.52, matLt), -0.34, 1.2, 0.36);

      // Rotating rear launcher slew turntable (`turret`, `recoil`)
      turret = new THREE.Group();
      turret.position.set(0, 0.56, -0.34);
      body.add(turret);

      add(cyl(0.62, 0.12, matGun, "oct"), 0, 0.04, 0, turret);
      for (const sx of [-0.34, 0.34]) {
        add(rbox(0.1, 0.34, 0.46, matDk, true), sx, 0.22, -0.04, turret);
        const hyd = cyl(0.05, 0.46, matLt);
        hyd.rotation.x = 0.32;
        add(hyd, sx * 0.72, 0.28, 0.18, turret);
      }

      // Elevated 6-tube precision hypersonic missile pod (angled upward inside turret)
      const podPitch = new THREE.Group();
      podPitch.position.set(0, 0.38, 0.02);
      podPitch.rotation.x = -0.52;
      turret.add(podPitch);

      recoil = new THREE.Group();
      recoil.position.set(0, 0.06, 0.14);
      podPitch.add(recoil);

      // Armored precision launcher pod shell with gold trim & faction shroud
      add(rbox(0.72, 0.4, 1.54, matCer, true), 0, 0, 0, recoil);
      add(rbox(0.74, 0.075, 1.32, matAcc, true), 0, 0.22, -0.02, recoil);
      add(rbox(0.76, 0.04, 1.24, matGold, true), 0, 0.26, -0.02, recoil);
      for (const rz of [-0.52, 0, 0.52]) {
        add(rbox(0.76, 0.42, 0.07, matGun, true), 0, 0, rz, recoil);
      }

      // 6 visible precision hypersonic launch tubes (2x3) with glowing red-gold nose cones
      const matHyperCone = getGlowMat(HEAT_GLOW, 0.96);
      for (const mx of [-0.21, 0, 0.21]) {
        for (const my of [-0.095, 0.095]) {
          const tube = cyl(0.15, 0.16, matLt);
          tube.rotation.x = Math.PI / 2;
          add(tube, mx, my, 0.76, recoil);
          const collar = cyl(0.155, 0.05, matGold);
          collar.rotation.x = Math.PI / 2;
          add(collar, mx, my, 0.84, recoil);
          const nose = meshOf(geoMissileCone, matHyperCone, false, false);
          nose.scale.set(0.135, 0.26, 0.135);
          nose.rotation.x = Math.PI / 2;
          add(nose, mx, my, 0.92, recoil);
          pulse.push(nose);
        }
      }

      smokePos = new THREE.Vector3(0, 0.68, -0.82);
      topY = 1.66;
      break;
    }

    case "ballistic": {
      // Ballistic Missile TEL — 8x8 transporter-erector-launcher with single elevated SRBM tube
      addContactShadow(body, 1.04, 1.34);

      // 8 rugged heavy transport tires with alloy rims
      for (const [wx, wz] of [
        [-0.56, 0.86],
        [0.56, 0.86],
        [-0.56, 0.3],
        [0.56, 0.3],
        [-0.56, -0.32],
        [0.56, -0.32],
        [-0.56, -0.86],
        [0.56, -0.86],
      ]) {
        const tire = cyl(0.4, 0.26, matGraph);
        tire.rotation.z = Math.PI / 2;
        add(tire, wx, 0.2, wz);
        const rim = cyl(0.21, 0.278, matLt, "oct");
        rim.rotation.z = Math.PI / 2;
        add(rim, wx, 0.2, wz);
      }

      // Long armored 8x8 chassis + side equipment lockers
      add(rbox(0.98, 0.22, 2.34, matGun, true), 0, 0.36, -0.04);
      add(rbox(1.14, 0.1, 2.2, matCer, true), 0, 0.49, -0.04);
      for (const sx of [-0.56, 0.56]) {
        add(rbox(0.12, 0.18, 0.9, matDk, true), sx, 0.42, -0.18);
        add(rbox(0.03, 0.07, 0.78, matAcc, true), sx + (sx > 0 ? 0.06 : -0.06), 0.44, -0.18);
      }
      // Armored prow + headlights
      add(rbox(1.1, 0.15, 0.14, matDk, true), 0, 0.37, 1.14);
      for (const hx of [-0.36, 0.36]) {
        add(rbox(0.13, 0.055, 0.03, getGlowMat(WHITE_GLOW, 0.92), true), hx, 0.55, 1.14);
      }

      // Armored forward cab (shared HIMARS cab geometry) + panoramic glass
      add(meshOf(geoHimarsCab, matCer), 0, 0.72, 0.78);
      add(rbox(0.78, 0.055, 0.48, matAcc, true), 0, 0.96, 0.7);
      const cabWind = rbox(0.74, 0.18, 0.06, matGlass, true);
      cabWind.rotation.x = -0.36;
      add(cabWind, 0, 0.8, 1.08);
      add(cyl(0.2, 0.05, matLt), 0.18, 1.01, 0.62);
      add(cyl(0.02, 0.56, matLt), -0.36, 1.22, 0.5);

      // Rotating erector turntable (`turret`)
      turret = new THREE.Group();
      turret.position.set(0, 0.56, -0.42);
      body.add(turret);
      add(cyl(0.64, 0.13, matGun, "oct"), 0, 0.04, 0, turret);
      // Twin erector hydraulic rams
      for (const sx of [-0.36, 0.36]) {
        add(rbox(0.11, 0.36, 0.5, matDk, true), sx, 0.24, -0.06, turret);
        const hyd = cyl(0.055, 0.52, matLt);
        hyd.rotation.x = 0.36;
        add(hyd, sx * 0.72, 0.3, 0.2, turret);
      }

      // Elevated single SRBM launch tube pitched upward (`recoil`)
      const podPitch = new THREE.Group();
      podPitch.position.set(0, 0.4, 0.04);
      podPitch.rotation.x = -0.58;
      turret.add(podPitch);
      recoil = new THREE.Group();
      recoil.position.set(0, 0.06, 0.12);
      podPitch.add(recoil);

      add(rbox(0.56, 0.56, 1.9, matCer, true), 0, 0, 0, recoil);
      add(rbox(0.58, 0.08, 1.6, matAcc, true), 0, 0.3, -0.04, recoil);
      for (const rz of [-0.7, -0.24, 0.24, 0.7]) {
        add(rbox(0.58, 0.58, 0.07, matGun, true), 0, 0, rz, recoil);
      }
      // Hazard chevrons down the tube flanks
      for (const rz of [-0.5, -0.14, 0.22, 0.58]) {
        add(rbox(0.59, 0.12, 0.12, matGold, true), 0, -0.24, rz, recoil);
      }
      // Big missile nose cone + glowing tip at the muzzle end
      const tube = cyl(0.24, 0.2, matLt);
      tube.rotation.x = Math.PI / 2;
      add(tube, 0, 0, 0.96, recoil);
      const collar = cyl(0.25, 0.06, matGold);
      collar.rotation.x = Math.PI / 2;
      add(collar, 0, 0, 1.04, recoil);
      const nose = meshOf(geoMissileCone, getGlowMat(HEAT_GLOW, 0.96), false, false);
      nose.scale.set(0.21, 0.44, 0.21);
      nose.rotation.x = Math.PI / 2;
      add(nose, 0, 0, 1.14, recoil);
      pulse.push(nose);

      smokePos = new THREE.Vector3(0, 0.72, -0.9);
      topY = 1.78;
      break;
    }

    case "railtank": {
      // Aegis Railgun MBT — Next-Gen Stealth-Faceted Main Battle Tank with Twin Electromagnetic Railgun Barrels
      addContactShadow(body, 1.08, 1.32);

      // Wide armored twin tracks + reactive ERA stealth side skirts
      for (const sx of [-0.66, 0.66]) {
        add(rbox(0.36, 0.32, 2.04, getTreadMat(), true), sx, 0.2, 0);
        // Sloped stealth track glacis guards
        const fGuard = rbox(0.38, 0.14, 0.32, matDk, true);
        fGuard.rotation.x = 0.42;
        add(fGuard, sx, 0.34, 0.92);
        const rGuard = rbox(0.38, 0.14, 0.28, matDk, true);
        rGuard.rotation.x = -0.38;
        add(rGuard, sx, 0.34, -0.92);
        // Faceted ERA composite reactive side armor skirt + satin faction stripe
        const sideOut = sx + (sx > 0 ? 0.18 : -0.18);
        add(rbox(0.08, 0.24, 1.84, matCer, true), sideOut, 0.31, 0);
        add(rbox(0.09, 0.06, 1.66, matAcc, true), sideOut + (sx > 0 ? 0.01 : -0.01), 0.37, 0.02);
        for (const ez of [-0.66, -0.22, 0.22, 0.66]) {
          add(rbox(0.045, 0.16, 0.34, matDk, true), sideOut + (sx > 0 ? 0.036 : -0.036), 0.24, ez);
        }
        // 5 pairs of roadwheels & metallic hubcaps
        for (const sz of [-0.74, -0.37, 0, 0.37, 0.74]) {
          const wh = cyl(0.23, 0.38, matGraph);
          wh.rotation.z = Math.PI / 2;
          add(wh, sx, 0.15, sz);
          const hub = cyl(0.095, 0.395, matLt);
          hub.rotation.z = Math.PI / 2;
          add(hub, sx, 0.15, sz);
        }
      }

      // Sleek stealth-faceted composite hull
      add(meshOf(geoRailHull, matCer), 0, 0.46, 0);
      const glacis = rbox(0.96, 0.08, 0.46, matDk, true);
      glacis.rotation.x = 0.34;
      add(glacis, 0, 0.54, 0.74);
      // Driver electro-optical glass slit + recessed cyan-white LED headlights
      add(rbox(0.3, 0.055, 0.07, matGlass, true), 0, 0.64, 0.64);
      for (const hx of [-0.42, 0.42]) {
        add(rbox(0.14, 0.055, 0.04, getGlowMat(WHITE_GLOW, 0.92), true), hx, 0.48, 1.02);
      }
      // Rear capacitor cooling deck vents (cyan reactor glow!)
      add(rbox(0.76, 0.06, 0.5, matGun, true), 0, 0.66, -0.66);
      for (const rx of [-0.22, 0.22]) {
        const vent = rbox(0.24, 0.03, 0.36, getGlowMat(CYAN_GLOW, 0.85), true);
        add(vent, rx, 0.69, -0.68);
        pulse.push(vent);
      }

      // Sleek low-profile stealth rotating railgun turret (`turret`, `recoil`)
      turret = new THREE.Group();
      turret.position.set(0, 0.74, -0.06);
      body.add(turret);

      turret.add(meshOf(geoRailTurret, matCer));
      // Dark-titanium angular cheek armor & bold faction top chevron trim
      for (const cx of [-0.44, 0.44]) {
        const cheek = rbox(0.09, 0.18, 0.62, matDk, true);
        cheek.rotation.y = cx > 0 ? 0.24 : -0.24;
        add(cheek, cx, 0.0, 0.14, turret);
      }
      add(rbox(0.56, 0.055, 0.58, matAcc, true), 0, 0.155, -0.06, turret);
      // Rear capacitor bustle with glowing cyan charge strips
      add(rbox(0.78, 0.18, 0.34, matGun, true), 0, 0.03, -0.68, turret);
      const capStrip = rbox(0.62, 0.055, 0.04, getGlowMat(CYAN_GLOW, 0.94), true);
      add(capStrip, 0, 0.06, -0.86, turret);
      pulse.push(capStrip);
      // Low-profile commander panoramic optic & twin comms whips
      add(cyl(0.22, 0.08, matDk, "oct"), -0.18, 0.18, -0.24, turret);
      add(cyl(0.13, 0.08, matGlass), 0.2, 0.19, -0.1, turret);
      for (const ax of [-0.34, 0.34]) {
        add(cyl(0.02, 0.56, matLt), ax, 0.36, -0.58, turret);
      }

      // Twin Parallel Electromagnetic Railgun Barrels lined with glowing cyan accelerator coils (`recoil`)
      recoil = new THREE.Group();
      recoil.position.set(0, 0.03, 0.4);
      turret.add(recoil);

      add(rbox(0.58, 0.2, 0.24, matDk, true), 0, 0, 0, recoil);
      const matRailGlow = getGlowMat(CYAN_GLOW, 0.96);
      for (const bx of [-0.18, 0.18]) {
        // Upper & lower parallel conductive electromagnetic rail beams
        add(rbox(0.095, 0.046, 1.44, matGun, true), bx, 0.048, 0.68, recoil);
        add(rbox(0.095, 0.046, 1.44, matGun, true), bx, -0.048, 0.68, recoil);
        // Side machined titanium shrouds near breech
        add(rbox(0.13, 0.12, 0.42, matCer, true), bx, 0, 0.24, recoil);
        // Continuous glowing cyan plasma accelerator channel between the parallel rails!
        const railCore = rbox(0.048, 0.042, 1.28, matRailGlow, true);
        add(railCore, bx, 0, 0.72, recoil);
        pulse.push(railCore);
        // 4 segmented electromagnetic accelerator coil collars along each rail barrel
        for (const cz of [0.46, 0.74, 1.02, 1.28]) {
          const coil = rbox(0.135, 0.135, 0.055, matLt, true);
          add(coil, bx, 0, cz, recoil);
          const coilGlow = rbox(0.145, 0.036, 0.03, matRailGlow, true);
          add(coilGlow, bx, 0, cz, recoil);
          pulse.push(coilGlow);
        }
      }

      smokePos = new THREE.Vector3(0, 0.76, -0.94);
      topY = 1.26;
      break;
    }

    // =========================================================================
    // LOGISTICS INFRASTRUCTURE & CONVOY (2): supplyhub, supplytruck
    // =========================================================================
    case "supplyhub": {
      // Forward Supply Hub (2x2) — Armored Forward Logistics Base, Twin Fuel Tanks, Ammo Pallets, Canopy, Comms Dish & Resupply Beacon
      body.add(foundationPad(2, 2, colorHex, 0.2));

      const matOlive = getChassisMat("#4c5c42", 0.5, 0.44);
      const matOliveDk = getChassisMat("#384531", 0.54, 0.42);
      const matCrate = getChassisMat("#566048", 0.56, 0.34);
      const matSupplyGlow = getGlowMat(HEAL_GLOW, 0.96);

      // Reinforced concrete loading bay apron & glowing emerald resupply pad strips
      add(rbox(1.64, 0.045, 0.58, matGun, true), 0, 0.225, 0.54);
      for (const sx of [-0.52, 0.52]) {
        const padStrip = rbox(0.46, 0.028, 0.055, matSupplyGlow, true);
        add(padStrip, sx, 0.255, 0.78);
        pulse.push(padStrip);
      }

      // Twin cylindrical olive/steel pressurized fuel storage tanks (left side, horizontal on saddle cradles)
      for (const tz of [-0.46, 0.04]) {
        // Twin gunmetal structural cradles
        for (const cx of [-0.66, -0.22]) {
          add(rbox(0.11, 0.22, 0.42, matGun, true), cx, 0.32, tz);
        }
        // Horizontal cylindrical olive-steel fuel tank body + domed end caps
        const tankCyl = cyl(0.42, 0.78, matOlive);
        tankCyl.rotation.z = Math.PI / 2;
        add(tankCyl, -0.44, 0.54, tz);
        for (const ex of [-0.82, -0.06]) {
          const capEnd = sph(0.415, matOliveDk);
          capEnd.scale.set(0.24, 0.415, 0.415);
          add(capEnd, ex, 0.54, tz);
        }
        // Bright industrial yellow hazard bands & steel reinforcement rings
        for (const hx of [-0.64, -0.24]) {
          const hazBand = cyl(0.435, 0.085, matHaz);
          hazBand.rotation.z = Math.PI / 2;
          add(hazBand, hx, 0.54, tz);
        }
        const centerCollar = cyl(0.43, 0.06, matDk);
        centerCollar.rotation.z = Math.PI / 2;
        add(centerCollar, -0.44, 0.54, tz);
        // Top pressure valve & gauge cap
        add(cyl(0.08, 0.1, matLt), -0.44, 0.78, tz);
        add(cyl(0.12, 0.03, matHaz), -0.44, 0.83, tz);
      }

      // Steel fuel transfer manifold pipe linking twin tanks to pump kiosk
      const manifold = cyl(0.075, 0.54, matLt);
      manifold.rotation.x = Math.PI / 2;
      add(manifold, -0.02, 0.52, -0.21);
      // Armored fuel pump dispenser kiosk at front-left
      add(rbox(0.32, 0.48, 0.28, matCer, true), -0.58, 0.44, 0.52);
      add(rbox(0.22, 0.14, 0.04, matGlass, true), -0.58, 0.54, 0.67);
      const pumpGauge = rbox(0.18, 0.04, 0.04, matSupplyGlow, true);
      add(pumpGauge, -0.58, 0.42, 0.67);
      pulse.push(pumpGauge);

      // Rugged tactical canopy awning (right side) shielding stacked armored ammo crate pallets
      const canopyCorners: [number, number][] = [
        [0.12, -0.68],
        [0.82, -0.68],
        [0.12, 0.24],
        [0.82, 0.24],
      ];
      for (const [px, pz] of canopyCorners) {
        add(rbox(0.09, 0.84, 0.09, matDk, true), px, 0.62, pz);
      }
      // Slightly pitched ribbed armored canopy roof + faction trim valance
      const canopyRoof = rbox(0.88, 0.1, 1.12, matCer, true);
      canopyRoof.rotation.z = -0.06;
      add(canopyRoof, 0.47, 1.06, -0.22);
      for (const rz of [-0.62, -0.35, -0.08, 0.19]) {
        const rib = rbox(0.86, 0.055, 0.065, matDk, true);
        rib.rotation.z = -0.06;
        add(rib, 0.47, 1.12, rz);
      }
      add(rbox(0.86, 0.08, 0.06, matAcc, true), 0.47, 1.0, 0.34);
      add(rbox(0.06, 0.08, 1.08, matAcc, true), 0.9, 1.0, -0.22);

      // Stacked armored ammo crate pallets beneath canopy & on forward apron
      const addAmmoPallet = (px: number, pz: number, stacked: boolean) => {
        // Reinforced steel/timber pallet base
        add(rbox(0.46, 0.06, 0.38, matGun, true), px, 0.24, pz);
        // Bottom pair of armored olive ammo crates with yellow hazard clasps
        for (const cx of [-0.11, 0.11]) {
          add(rbox(0.2, 0.18, 0.32, matCrate, true), px + cx, 0.36, pz);
          add(rbox(0.21, 0.035, 0.06, matHaz, true), px + cx, 0.41, pz + 0.11);
        }
        if (stacked) {
          const topCrate = rbox(0.32, 0.16, 0.26, matOlive, true);
          topCrate.rotation.y = 0.12;
          add(topCrate, px, 0.53, pz - 0.01);
          add(rbox(0.26, 0.035, 0.055, matHaz, true), px, 0.57, pz + 0.11);
        }
      };
      addAmmoPallet(0.46, -0.42, true);
      addAmmoPallet(0.48, 0.02, true);
      addAmmoPallet(0.46, 0.5, false);

      // Armored rear telemetry tower + rotating logistics comms dish (`spin`)
      add(rbox(0.38, 0.32, 0.38, matDk, true), 0.62, 1.22, -0.52);
      add(cyl(0.14, 0.22, matGun, "oct"), 0.62, 1.44, -0.52);
      spin = new THREE.Group();
      spin.position.set(0.62, 1.56, -0.52);
      body.add(spin);
      const dish = meshOf(geoParabolicDish, matLt);
      dish.scale.set(0.62, 0.62, 0.62);
      dish.rotation.x = 0.96;
      dish.position.set(0, 0.08, -0.05);
      spin.add(dish);
      const dishRim = torus(0.61, matAcc, true);
      dishRim.rotation.x = Math.PI / 2 + 0.96;
      dishRim.position.set(0, 0.16, 0.09);
      spin.add(dishRim);
      const feed = cyl(0.04, 0.28, matGun);
      feed.rotation.x = 0.96;
      add(feed, 0, 0.18, 0.1, spin);
      const feedTip = sph(0.075, matSupplyGlow, true);
      add(feedTip, 0, 0.26, 0.21, spin);
      pulse.push(feedTip);

      // Prominent glowing emerald-green resupply beacon mast (`pulse`) at front-left corner
      add(rbox(0.24, 0.28, 0.24, matDk, true), -0.68, 0.34, 0.68);
      add(cyl(0.068, 0.96, matLt), -0.68, 0.96, 0.68);
      add(cyl(0.16, 0.08, matAcc, "oct"), -0.68, 1.44, 0.68);
      const beaconRing = torus(0.22, matSupplyGlow, true);
      beaconRing.rotation.x = Math.PI / 2;
      add(beaconRing, -0.68, 1.54, 0.68);
      pulse.push(beaconRing);
      const beaconOrb = sph(0.17, matSupplyGlow, true);
      add(beaconOrb, -0.68, 1.56, 0.68);
      pulse.push(beaconOrb);

      smokePos = new THREE.Vector3(-0.78, 0.85, -0.68);
      topY = 1.88;
      break;
    }

    case "supplytruck": {
      // Supply Convoy Truck — Heavy 6x6 Military Logistics Truck with Sloped Cab, Fuel Drums, Ammo Crates, Tarp Frame & Green Beacon
      addContactShadow(body, 0.96, 1.24);

      const matOlive = getChassisMat("#4c5c42", 0.5, 0.44);
      const matOliveDk = getChassisMat("#384531", 0.54, 0.42);
      const matTarp = getChassisMat("#505c45", 0.72, 0.16);
      const matSupplyGlow = getGlowMat(HEAL_GLOW, 0.96);

      // 6 rugged off-road military 6x6 tires with machined alloy hubs
      for (const [wx, wz] of [
        [-0.55, 0.66],
        [0.55, 0.66],
        [-0.55, -0.04],
        [0.55, -0.04],
        [-0.55, -0.68],
        [0.55, -0.68],
      ]) {
        const tire = cyl(0.4, 0.23, matGraph);
        tire.rotation.z = Math.PI / 2;
        add(tire, wx, 0.2, wz);
        const hub = cyl(0.21, 0.25, matLt, "oct");
        hub.rotation.z = Math.PI / 2;
        add(hub, wx, 0.2, wz);
      }

      // Heavy 6x6 armored truck chassis, flatbed deck & side storage lockers
      add(rbox(0.94, 0.18, 1.94, matGun, true), 0, 0.35, 0);
      add(rbox(1.12, 0.09, 1.26, matDk, true), 0, 0.48, -0.34);
      // Flatbed low side-walls with faction ID trim stripe
      for (const sx of [-0.54, 0.54]) {
        add(rbox(0.06, 0.16, 1.22, matCer, true), sx, 0.57, -0.34);
        add(rbox(0.07, 0.055, 1.06, matAcc, true), sx + (sx > 0 ? 0.008 : -0.008), 0.59, -0.34);
        // Under-bed auxiliary fuel cell / tool box
        add(rbox(0.14, 0.14, 0.36, matDk, true), sx * 0.92, 0.36, 0.28);
      }
      // Rear tailgate bar
      add(rbox(1.06, 0.16, 0.06, matCer, true), 0, 0.57, -0.94);

      // Heavy front bull-bar bumper & glowing LED headlights
      add(rbox(1.06, 0.14, 0.14, matDk, true), 0, 0.35, 0.96);
      for (const hx of [-0.36, 0.36]) {
        add(rbox(0.13, 0.055, 0.03, getGlowMat(WHITE_GLOW, 0.92), true), hx, 0.52, 0.96);
      }

      // Sloped armored forward cab with tinted panoramic glass windshield
      add(meshOf(geoHimarsCab, matCer), 0, 0.72, 0.6);
      add(rbox(0.78, 0.055, 0.48, matAcc, true), 0, 0.96, 0.52);
      const wind = rbox(0.74, 0.18, 0.06, matGlass, true);
      wind.rotation.x = -0.36;
      add(wind, 0, 0.8, 0.9);
      // Side armored mirror brackets, vertical exhaust stack & comms whip
      for (const mx of [-0.46, 0.46]) {
        add(rbox(0.05, 0.12, 0.06, matGun, true), mx, 0.78, 0.76);
      }
      add(cyl(0.065, 0.58, matGun), 0.46, 0.84, 0.34);
      add(cyl(0.02, 0.48, matLt), -0.34, 1.18, 0.38);

      // Rear flatbed cargo: Twin pressurized fuel drums (forward half of flatbed) with yellow hazard bands
      for (const dx of [-0.23, 0.23]) {
        const drum = cyl(0.32, 0.54, matOlive);
        drum.rotation.x = Math.PI / 2;
        add(drum, dx, 0.69, -0.02);
        const hazBand = cyl(0.334, 0.08, matHaz);
        hazBand.rotation.x = Math.PI / 2;
        add(hazBand, dx, 0.69, -0.02);
        // Drum end caps
        for (const dz of [-0.29, 0.25]) {
          const capD = cyl(0.3, 0.03, matOliveDk);
          capD.rotation.x = Math.PI / 2;
          add(capD, dx, 0.69, dz);
        }
      }

      // Rear flatbed cargo: Stacked armored ammunition crates (rear half of flatbed)
      for (const cx of [-0.24, 0.24]) {
        add(rbox(0.36, 0.22, 0.42, matOliveDk, true), cx, 0.63, -0.64);
        add(rbox(0.28, 0.04, 0.05, matHaz, true), cx, 0.68, -0.84);
      }
      const topAmmo = rbox(0.56, 0.18, 0.34, matOlive, true);
      add(topAmmo, 0, 0.82, -0.62);
      add(rbox(0.4, 0.035, 0.045, matHaz, true), 0, 0.86, -0.79);

      // Arched tactical tarp frame (3 bowed steel roll-bars + partial ribbed canvas roof canopy)
      for (const tz of [0.22, -0.34, -0.9]) {
        for (const sx of [-0.5, 0.5]) {
          add(rbox(0.05, 0.48, 0.05, matLt, true), sx, 0.86, tz);
        }
        // Angled shoulder bows & arched crown crossbar
        const bowL = rbox(0.24, 0.045, 0.05, matLt, true);
        bowL.rotation.z = 0.42;
        add(bowL, -0.4, 1.13, tz);
        const bowR = rbox(0.24, 0.045, 0.05, matLt, true);
        bowR.rotation.z = -0.42;
        add(bowR, 0.4, 1.13, tz);
        add(rbox(0.62, 0.048, 0.05, matLt, true), 0, 1.18, tz);
      }
      // Partial olive-drab tactical canvas tarp draped across mid-top bow (leaves cargo visibly showcased!)
      add(rbox(0.66, 0.05, 0.68, matTarp, true), 0, 1.21, -0.32);
      for (const sx of [-0.4, 0.4]) {
        const flap = rbox(0.24, 0.045, 0.66, matTarp, true);
        flap.rotation.z = sx > 0 ? -0.42 : 0.42;
        add(flap, sx, 1.15, -0.32);
      }

      // Prominent glowing emerald-green rear supply indicator beacon (`pulse`) + tailgate marker strips
      add(cyl(0.13, 0.07, matGun, "oct"), 0, 1.24, -0.9);
      const rearBeacon = sph(0.15, matSupplyGlow, true);
      add(rearBeacon, 0, 1.33, -0.9);
      pulse.push(rearBeacon);
      for (const lx of [-0.36, 0.36]) {
        const tailGlow = rbox(0.16, 0.055, 0.035, matSupplyGlow, true);
        add(tailGlow, lx, 0.57, -0.98);
        pulse.push(tailGlow);
      }

      smokePos = new THREE.Vector3(0.46, 1.16, 0.34);
      topY = 1.42;
      break;
    }

    default:
      return null;
  }

  for (const p of pulse) {
    p.userData.baseScale = p.scale.clone();
  }

  const rig: Partial<AnimRig> = {
    ...soldierParts,
    turret: turret ?? undefined,
    recoil,
    spiderLegs,
    spin,
    spin2,
    pulse: pulse.length ? pulse : undefined,
    flag,
    crane,
    bin,
    smokePos,
    powerGlow: powerGlow.length ? powerGlow : undefined,
  };

  return {
    topY,
    turret,
    rig,
    powerGlow: powerGlow.length ? powerGlow : undefined,
  };
}
