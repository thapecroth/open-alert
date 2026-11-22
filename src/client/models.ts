import * as THREE from "three";
import type { CrateKind } from "../shared/gamedefs";
import { BUILDINGS, EntKind, isBuildingKind } from "./util";
import { getArmorMat, getConcreteMat, getGlowMat, getTreadMat } from "./textures";

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
}

export interface EntVis {
  root: THREE.Group;
  turret: THREE.Group | null;
  barBg: THREE.Sprite;
  barFg: THREE.Sprite;
  vetBadge: THREE.Sprite;
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

// ---------- Palette helpers ----------
function dim(hex: string, f: number): string {
  return "#" + new THREE.Color(hex).multiplyScalar(f).getHexString();
}
function lift(hex: string, amt: number): string {
  const c = new THREE.Color(hex);
  c.lerp(new THREE.Color(0xffffff), amt);
  return "#" + c.getHexString();
}

const HULL = "#242d35";
const HULL2 = "#39444e";
const GUNM = "#171b20";
const STEEL = "#586570";
const ORE_GLOW = "#ffaa28";
const CORE_GLOW = "#48d0ff";
const WIN_GLOW = "#8ee8ff";
const SKIN_HELM = "#2d3740";

// ---------- Shared beveled & sculpted geometries ----------
const geoBox = new THREE.BoxGeometry(1, 1, 1);
const geoCyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 14);
const geoCylTaper = new THREE.CylinderGeometry(0.36, 0.52, 1, 16);
const geoCylOct = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
const geoSph = new THREE.SphereGeometry(0.5, 14, 10);
const geoCap = new THREE.CapsuleGeometry(0.25, 0.5, 4, 8);
const geoRing = new THREE.RingGeometry(0.84, 1.0, 44);
const geoTorus = new THREE.TorusGeometry(0.5, 0.08, 8, 24);

// Sloped military tank hull profile (extruded along X, then centered)
function makeSlopedHullGeo(len: number, height: number, width: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const hl = len / 2;
  const hh = height / 2;
  s.moveTo(-hl * 0.92, -hh);
  s.lineTo(hl * 0.85, -hh);
  s.lineTo(hl, -hh * 0.15);
  s.lineTo(hl * 0.68, hh);
  s.lineTo(-hl * 0.82, hh);
  s.lineTo(-hl, hh * 0.2);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: width,
    bevelEnabled: true,
    bevelThickness: 0.04,
    bevelSize: 0.04,
    bevelSegments: 2,
  });
  g.center();
  // Rotate so length runs along +Z (forward) and width along X
  g.rotateY(-Math.PI / 2);
  return g;
}

// Angled polygonal turret housing
function makeTurretGeo(w: number, h: number, l: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-w * 0.48, -l * 0.5);
  s.lineTo(w * 0.48, -l * 0.5);
  s.lineTo(w * 0.36, l * 0.46);
  s.lineTo(-w * 0.36, l * 0.46);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: h,
    bevelEnabled: true,
    bevelThickness: 0.045,
    bevelSize: 0.04,
    bevelSegments: 2,
  });
  g.center();
  g.rotateX(-Math.PI / 2);
  return g;
}

const geoTankHull = makeSlopedHullGeo(1.75, 0.36, 0.96);
const geoHeavyHull = makeSlopedHullGeo(2.08, 0.42, 1.24);
const geoTankTurret = makeTurretGeo(0.72, 0.28, 0.92);
const geoHeavyTurret = makeTurretGeo(0.96, 0.32, 1.12);

// ---------- Mesh builders ----------
function box(w: number, h: number, d: number, hex: string, e = 0, metal = 0.45, rough = 0.55): THREE.Mesh {
  const m = e > 0.6 ? getGlowMat(hex, 0.85 + e * 0.45) : getArmorMat(hex, metal, rough, e);
  const b = new THREE.Mesh(geoBox, m);
  b.scale.set(w, h, d);
  b.castShadow = true;
  b.receiveShadow = true;
  return b;
}

function cyl(d: number, h: number, hex: string, e = 0, taper = false): THREE.Mesh {
  const g = taper ? geoCylTaper : geoCyl;
  const m = e > 0.6 ? getGlowMat(hex, 0.85 + e * 0.45) : getArmorMat(hex, 0.5, 0.5, e);
  const c = new THREE.Mesh(g, m);
  c.scale.set(d, h, d);
  c.castShadow = true;
  c.receiveShadow = true;
  return c;
}

function sph(d: number, hex: string, e = 0): THREE.Mesh {
  const m = e > 0.6 ? getGlowMat(hex, 0.85 + e * 0.45) : getArmorMat(hex, 0.45, 0.48, e);
  const s = new THREE.Mesh(geoSph, m);
  s.scale.setScalar(d);
  s.castShadow = true;
  s.receiveShadow = true;
  return s;
}

function foundationPad(w: number, d: number, h = 0.22): THREE.Group {
  const g = new THREE.Group();
  const base = new THREE.Mesh(geoBox, getConcreteMat());
  base.scale.set(w - 0.08, h, d - 0.08);
  base.position.y = h / 2;
  base.castShadow = true;
  base.receiveShadow = true;
  g.add(base);
  // Dark recessed footing collar to anchor firmly to terrain
  const trim = new THREE.Mesh(geoBox, getArmorMat(GUNM, 0.3, 0.8));
  trim.scale.set(w - 0.02, 0.06, d - 0.02);
  trim.position.y = 0.03;
  trim.receiveShadow = true;
  g.add(trim);
  return g;
}

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

  // Subtle dark tactical pill backdrop
  ctx.fillStyle = r === 3 ? "rgba(44, 10, 10, 0.86)" : "rgba(10, 14, 20, 0.82)";
  ctx.strokeStyle = r === 3 ? "#ff5238" : r === 2 ? "#ffd040" : "#d8c47a";
  ctx.lineWidth = r === 3 ? 2.5 : 2;
  ctx.beginPath();
  ctx.roundRect(px, 7, pillW, 34, 8);
  ctx.fill();
  ctx.stroke();

  // Radiant glow for heroic / elite stars
  ctx.font = "900 24px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = r === 3 ? "#ff3820" : r === 2 ? "#ffae00" : "#e8d890";
  ctx.shadowBlur = r === 3 ? 12 : r === 2 ? 8 : 4;
  ctx.fillStyle = r === 3 ? "#ffe066" : r === 2 ? "#ffd83a" : "#ece2b8";
  ctx.fillText(stars, W / 2, H / 2 + 1);

  if (r === 3) {
    // Crisp crimson-gold heroic outline accent
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

// ---------- Articulated Humanoid Builder ----------
function buildSoldierRig(
  body: THREE.Group,
  colorHex: string,
  role: "infantry" | "engineer" | "rocket",
): Partial<AnimRig> {
  const dark = dim(colorHex, 0.58);
  const scale = role === "engineer" ? 0.95 : 1.04;
  body.scale.setScalar(scale);

  // Pelvis / belt
  const pelvis = box(0.28, 0.1, 0.18, GUNM, 0, 0.2, 0.7);
  pelvis.position.set(0, 0.34, 0);
  body.add(pelvis);

  // Articulated legs pivoted at hips (y=0.33)
  const makeLeg = (sx: number) => {
    const hip = new THREE.Group();
    hip.position.set(sx, 0.33, 0);
    const thigh = new THREE.Mesh(geoCap, getArmorMat(HULL, 0.2, 0.72));
    thigh.scale.set(0.22, 0.22, 0.22);
    thigh.position.set(0, -0.14, 0);
    thigh.castShadow = true;
    hip.add(thigh);
    const boot = box(0.11, 0.1, 0.16, GUNM, 0, 0.25, 0.75);
    boot.position.set(0, -0.28, 0.025);
    hip.add(boot);
    body.add(hip);
    return hip;
  };
  const legL = makeLeg(-0.085);
  const legR = makeLeg(0.085);

  // Armored torso + chest plate + shoulder pads
  const torso = box(0.32, 0.3, 0.2, dark, 0, 0.4, 0.55);
  torso.position.set(0, 0.53, 0);
  body.add(torso);
  const chest = box(0.28, 0.2, 0.23, colorHex, 0, 0.5, 0.48);
  chest.position.set(0, 0.55, 0.01);
  body.add(chest);

  // Tactical backpack
  const pack = box(0.22, 0.24, 0.12, role === "engineer" ? "#b88a1e" : HULL2, 0, 0.35, 0.65);
  pack.position.set(0, 0.54, -0.15);
  body.add(pack);

  // Head group (helmet + glowing tactical visor)
  const head = new THREE.Group();
  head.position.set(0, 0.75, 0);
  const cranium = sph(0.22, role === "engineer" ? "#f0be2a" : SKIN_HELM);
  head.add(cranium);
  if (role === "engineer") {
    const brim = cyl(0.27, 0.035, "#f0be2a");
    brim.position.set(0, 0.01, 0.02);
    head.add(brim);
    const lamp = sph(0.06, WIN_GLOW, 0.85);
    lamp.position.set(0, 0.06, 0.11);
    head.add(lamp);
  } else {
    const helmet = sph(0.245, colorHex);
    helmet.scale.multiply(new THREE.Vector3(1.06, 0.78, 1.1));
    helmet.position.set(0, 0.035, -0.01);
    head.add(helmet);
    const visor = box(0.15, 0.055, 0.04, WIN_GLOW, 0.85);
    visor.position.set(0, 0.0, 0.1);
    head.add(visor);
  }
  body.add(head);

  // Articulated arms pivoted at shoulders (y=0.63)
  const makeArm = (sx: number) => {
    const sh = new THREE.Group();
    sh.position.set(sx, 0.63, 0);
    const pauldron = sph(0.13, colorHex);
    sh.add(pauldron);
    const limb = new THREE.Mesh(geoCap, getArmorMat(HULL2, 0.3, 0.65));
    limb.scale.set(0.17, 0.2, 0.17);
    limb.position.set(0, -0.14, 0.04);
    limb.rotation.x = -0.35;
    limb.castShadow = true;
    sh.add(limb);
    body.add(sh);
    return sh;
  };
  const armL = makeArm(-0.21);
  const armR = makeArm(0.21);

  const recoil = new THREE.Group();

  if (role === "infantry") {
    // Assault rifle mounted to right arm + recoil slide
    armR.rotation.x = -0.55;
    armL.rotation.x = -0.45;
    recoil.position.set(0, -0.16, 0.15);
    armR.add(recoil);
    const receiver = box(0.06, 0.08, 0.36, GUNM);
    recoil.add(receiver);
    const barrel = cyl(0.032, 0.28, STEEL);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.015, 0.26);
    recoil.add(barrel);
    const sight = box(0.035, 0.035, 0.08, colorHex, 0.7);
    sight.position.set(0, 0.055, 0.02);
    recoil.add(sight);
  } else if (role === "engineer") {
    // Tool case in right hand, scanner pad in left
    const caseBox = box(0.16, 0.11, 0.09, "#d9a226");
    caseBox.position.set(0.02, -0.26, 0.05);
    armR.add(caseBox);
    const wrench = box(0.04, 0.04, 0.24, STEEL);
    wrench.position.set(0, -0.22, 0.14);
    armL.add(wrench);
  } else if (role === "rocket") {
    // Twin shoulder-mounted AT rocket pods
    recoil.position.set(0, 0.72, 0);
    body.add(recoil);
    for (const sx of [-0.22, 0.22]) {
      const tube = cyl(0.095, 0.56, GUNM);
      tube.rotation.x = Math.PI / 2 - 0.18;
      tube.position.set(sx, 0.02, 0.02);
      recoil.add(tube);
      const band = cyl(0.105, 0.09, colorHex);
      band.rotation.x = Math.PI / 2 - 0.18;
      band.position.set(sx, 0.05, 0.14);
      recoil.add(band);
      const warhead = sph(0.065, ORE_GLOW, 0.75);
      warhead.position.set(sx, 0.07, 0.28);
      recoil.add(warhead);
    }
  }

  return { legL, legR, armL, armR, head, recoil };
}

// ---------- Main Entity Visual Factory ----------

export function makeEntVis(kind: EntKind, colorHex: string, _scene?: THREE.Scene): EntVis {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

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
  const pulse: THREE.Mesh[] = [];
  let soldierParts: Partial<AnimRig> = {};

  const dark = dim(colorHex, 0.52);
  const bright = lift(colorHex, 0.22);

  const add = (m: THREE.Object3D, x = 0, y = 0, z = 0, parent: THREE.Object3D = body) => {
    parent.add(m);
    m.position.set(x, y, z);
    return m;
  };

  switch (kind) {
    case "infantry":
      soldierParts = buildSoldierRig(body, colorHex, "infantry");
      recoil = soldierParts.recoil;
      topY = 0.96;
      break;

    case "engineer":
      soldierParts = buildSoldierRig(body, colorHex, "engineer");
      topY = 0.9;
      break;

    case "rocket":
      soldierParts = buildSoldierRig(body, colorHex, "rocket");
      recoil = soldierParts.recoil;
      topY = 1.02;
      break;

    case "tank": {
      // Armored tread pods with textured treads + roadwheels + side skirts
      for (const sx of [-0.56, 0.56]) {
        const tread = new THREE.Mesh(geoBox, getTreadMat());
        tread.scale.set(0.32, 0.3, 1.82);
        tread.castShadow = true;
        tread.receiveShadow = true;
        add(tread, sx, 0.19, 0);
        // Side armor skirt
        add(box(0.08, 0.2, 1.66, dark), sx + (sx > 0 ? 0.16 : -0.16), 0.27, 0);
        for (const sz of [-0.62, -0.2, 0.22, 0.62]) {
          const wh = cyl(0.24, 0.34, GUNM);
          wh.rotation.z = Math.PI / 2;
          add(wh, sx, 0.15, sz);
        }
      }
      // Sloped beveled glacis hull
      const hull = new THREE.Mesh(geoTankHull, getArmorMat(dark, 0.48, 0.52));
      hull.castShadow = true;
      hull.receiveShadow = true;
      add(hull, 0, 0.44, 0);
      // Top painted deck + engine louver + headlights
      add(box(0.76, 0.12, 1.15, colorHex), 0, 0.62, -0.08);
      add(box(0.56, 0.06, 0.42, GUNM), 0, 0.66, -0.52);
      add(box(0.12, 0.06, 0.04, WIN_GLOW, 0.8), -0.34, 0.46, 0.84);
      add(box(0.12, 0.06, 0.04, WIN_GLOW, 0.8), 0.34, 0.46, 0.84);
      // Independent rotating turret
      turret = new THREE.Group();
      turret.position.set(0, 0.72, -0.02);
      body.add(turret);
      const tMesh = new THREE.Mesh(geoTankTurret, getArmorMat(colorHex, 0.5, 0.48));
      tMesh.castShadow = true;
      tMesh.receiveShadow = true;
      turret.add(tMesh);
      const hatch = cyl(0.3, 0.09, HULL2);
      hatch.position.set(-0.1, 0.18, -0.18);
      turret.add(hatch);
      const ant = cyl(0.025, 0.55, STEEL);
      ant.position.set(0.24, 0.34, -0.34);
      turret.add(ant);
      // Recoil barrel assembly
      recoil = new THREE.Group();
      recoil.position.set(0, 0.05, 0.35);
      turret.add(recoil);
      const mantlet = box(0.28, 0.18, 0.2, HULL2);
      recoil.add(mantlet);
      const barrel = cyl(0.09, 1.08, GUNM);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0, 0.52);
      recoil.add(barrel);
      const muzzle = cyl(0.145, 0.18, STEEL);
      muzzle.rotation.x = Math.PI / 2;
      muzzle.position.set(0, 0, 1.05);
      recoil.add(muzzle);
      smokePos = new THREE.Vector3(0, 0.72, -0.7);
      topY = 1.15;
      break;
    }

    case "heavy": {
      // Mastodon Twin-Cannon Heavy Tank
      for (const sx of [-0.74, 0.74]) {
        const tread = new THREE.Mesh(geoBox, getTreadMat());
        tread.scale.set(0.42, 0.38, 2.18);
        tread.castShadow = true;
        tread.receiveShadow = true;
        add(tread, sx, 0.24, 0);
        add(box(0.1, 0.26, 1.98, dark), sx + (sx > 0 ? 0.21 : -0.21), 0.34, 0);
        for (const sz of [-0.76, -0.26, 0.26, 0.76]) {
          const wh = cyl(0.3, 0.44, GUNM);
          wh.rotation.z = Math.PI / 2;
          add(wh, sx, 0.18, sz);
        }
      }
      const hull = new THREE.Mesh(geoHeavyHull, getArmorMat(dark, 0.52, 0.48));
      hull.castShadow = true;
      hull.receiveShadow = true;
      add(hull, 0, 0.54, 0);
      add(box(0.98, 0.16, 1.38, colorHex), 0, 0.76, -0.08);
      // Glowing side armor accent strips (restrained)
      add(box(0.04, 0.08, 1.5, bright, 0.65), -0.65, 0.56, 0);
      add(box(0.04, 0.08, 1.5, bright, 0.65), 0.65, 0.56, 0);
      turret = new THREE.Group();
      turret.position.set(0, 0.9, -0.04);
      body.add(turret);
      const tMesh = new THREE.Mesh(geoHeavyTurret, getArmorMat(colorHex, 0.54, 0.45));
      tMesh.castShadow = true;
      tMesh.receiveShadow = true;
      turret.add(tMesh);
      const cup = cyl(0.36, 0.12, HULL2);
      cup.position.set(0, 0.2, -0.28);
      turret.add(cup);
      // Missile side pods on turret cheeks
      for (const sx of [-0.52, 0.52]) {
        const pod = box(0.2, 0.22, 0.52, HULL);
        pod.position.set(sx, 0.06, -0.1);
        turret.add(pod);
      }
      recoil = new THREE.Group();
      recoil.position.set(0, 0.04, 0.42);
      turret.add(recoil);
      for (const bx of [-0.21, 0.21]) {
        const brl = cyl(0.105, 1.24, GUNM);
        brl.rotation.x = Math.PI / 2;
        brl.position.set(bx, 0, 0.56);
        recoil.add(brl);
        const muz = cyl(0.16, 0.2, STEEL);
        muz.rotation.x = Math.PI / 2;
        muz.position.set(bx, 0, 1.18);
        recoil.add(muz);
      }
      smokePos = new THREE.Vector3(0, 0.85, -0.92);
      topY = 1.34;
      break;
    }

    case "arty": {
      // Siege Launcher — armored 6x6 chassis + elevated rocket rack
      for (const [wx, wz] of [
        [-0.56, 0.6],
        [0.56, 0.6],
        [-0.56, 0],
        [0.56, 0],
        [-0.56, -0.6],
        [0.56, -0.6],
      ]) {
        const w = cyl(0.38, 0.22, GUNM);
        w.rotation.z = Math.PI / 2;
        add(w, wx, 0.19, wz);
      }
      add(box(1.02, 0.24, 1.72, HULL), 0, 0.36, 0);
      add(box(0.92, 0.1, 1.56, dark), 0, 0.52, 0);
      // Forward armored cab
      add(box(0.8, 0.42, 0.54, colorHex), 0, 0.68, 0.54);
      add(box(0.62, 0.14, 0.04, WIN_GLOW, 0.85), 0, 0.74, 0.82);
      // Articulated launcher rail
      recoil = new THREE.Group();
      recoil.position.set(0, 0.82, -0.26);
      recoil.rotation.x = -0.48;
      body.add(recoil);
      const rack = box(0.46, 0.22, 1.48, GUNM);
      recoil.add(rack);
      const cap = box(0.48, 0.06, 1.24, colorHex);
      cap.position.y = 0.13;
      recoil.add(cap);
      for (const mx of [-0.14, 0, 0.14]) {
        const tip = sph(0.08, ORE_GLOW, 0.75);
        tip.position.set(mx, 0, 0.76);
        recoil.add(tip);
      }
      smokePos = new THREE.Vector3(0, 0.6, -0.7);
      topY = 1.45;
      break;
    }

    case "harvester": {
      // Heavy industrial Ore Harvester with spinning front ore-scoop drum
      for (const [wx, wz] of [
        [-0.66, 0.64],
        [0.66, 0.64],
        [-0.66, -0.15],
        [0.66, -0.15],
        [-0.66, -0.74],
        [0.66, -0.74],
      ]) {
        const w = cyl(0.44, 0.26, GUNM);
        w.rotation.z = Math.PI / 2;
        add(w, wx, 0.22, wz);
      }
      add(box(1.22, 0.34, 2.02, HULL), 0, 0.44, 0);
      // Armored ore hopper walls
      add(box(1.3, 0.4, 1.15, dark), 0, 0.74, -0.34);
      bin = box(1.04, 0.36, 0.92, ORE_GLOW, 0.75);
      bin.position.set(0, 0.92, -0.34);
      bin.scale.y = 0.05;
      body.add(bin);
      // Forward cab + amber work beacon
      add(box(0.94, 0.56, 0.68, colorHex), 0, 0.74, 0.62);
      add(box(0.76, 0.2, 0.05, WIN_GLOW, 0.85), 0, 0.84, 0.97);
      const beacon = sph(0.11, ORE_GLOW, 0.9);
      add(beacon, 0, 1.07, 0.62);
      pulse.push(beacon);
      // Front hydraulic scoop arms + rotating grinder drum
      add(box(0.12, 0.14, 0.48, HULL2), -0.5, 0.3, 1.08);
      add(box(0.12, 0.14, 0.48, HULL2), 0.5, 0.3, 1.08);
      spin = new THREE.Group();
      spin.position.set(0, 0.28, 1.24);
      body.add(spin);
      const drum = cyl(0.24, 0.94, STEEL);
      drum.rotation.z = Math.PI / 2;
      spin.add(drum);
      for (const a of [0, Math.PI / 2]) {
        const blade = box(0.9, 0.32, 0.05, "#d89c28");
        blade.rotation.x = a;
        spin.add(blade);
      }
      smokePos = new THREE.Vector3(0.45, 0.95, 0.35);
      topY = 1.22;
      break;
    }

    case "spider": {
      // Articulated 4-leg cybernetic drone
      add(box(0.46, 0.22, 0.46, HULL), 0, 0.4, 0);
      const dome = sph(0.46, dark);
      dome.scale.multiply(new THREE.Vector3(1.05, 0.72, 1.1));
      add(dome, 0, 0.5, -0.02);
      add(box(0.26, 0.08, 0.3, colorHex), 0, 0.62, -0.04);
      const eye = sph(0.12, CORE_GLOW, 0.95);
      add(eye, 0, 0.46, 0.25);
      pulse.push(eye);
      spiderLegs = [];
      const corners: [number, number][] = [
        [-1, 1],
        [1, 1],
        [-1, -1],
        [1, -1],
      ];
      for (const [lx, lz] of corners) {
        const legPivot = new THREE.Group();
        legPivot.position.set(lx * 0.24, 0.38, lz * 0.2);
        // Upper femur extending out & slightly up
        const femur = box(0.06, 0.34, 0.06, colorHex);
        femur.rotation.z = lx * -1.05;
        femur.rotation.x = lz * 0.3;
        femur.position.set(lx * 0.14, 0.06, lz * 0.06);
        legPivot.add(femur);
        // Lower tibia angled down to ground
        const tibia = box(0.05, 0.46, 0.05, GUNM);
        tibia.rotation.z = lx * 0.32;
        tibia.rotation.x = lz * -0.18;
        tibia.position.set(lx * 0.32, -0.16, lz * 0.14);
        legPivot.add(tibia);
        body.add(legPivot);
        spiderLegs.push(legPivot);
      }
      topY = 0.8;
      break;
    }

    case "conyard": {
      body.add(foundationPad(3, 3, 0.24));
      add(box(2.46, 0.52, 2.46, dark), 0, 0.5, 0);
      add(box(1.52, 0.68, 1.44, colorHex), -0.34, 1.06, -0.1);
      add(box(1.04, 0.52, 1.88, HULL2), 0.78, 0.96, -0.2);
      // Command windows
      add(box(1.1, 0.16, 0.05, WIN_GLOW, 0.8), -0.34, 1.12, 0.64);
      // Animated gantry crane arm
      crane = new THREE.Group();
      crane.position.set(-0.4, 1.44, 0.25);
      body.add(crane);
      const jib = box(0.16, 0.16, 2.0, "#c89624");
      jib.rotation.x = -0.45;
      jib.position.set(0, 0.42, 0.45);
      crane.add(jib);
      const cable = cyl(0.03, 0.65, STEEL);
      cable.position.set(0, 0.48, 1.25);
      crane.add(cable);
      // Rotating radar dish
      add(cyl(0.09, 1.1, GUNM), 0.82, 1.72, 0.74);
      spin = new THREE.Group();
      spin.position.set(0.82, 2.3, 0.74);
      body.add(spin);
      const dish = cyl(0.62, 0.08, bright, 0, true);
      dish.rotation.x = 0.95;
      spin.add(dish);
      // Warning beacon
      const bcn = sph(0.16, colorHex, 0.9);
      add(bcn, -0.88, 1.56, -0.85);
      pulse.push(bcn);
      smokePos = new THREE.Vector3(0.5, 1.5, -0.6);
      topY = 2.65;
      break;
    }

    case "power": {
      body.add(foundationPad(2, 2, 0.22));
      add(box(1.66, 0.36, 1.66, dark), 0, 0.4, 0);
      // Twin hyperbolic-style tapered cooling towers
      add(cyl(0.76, 1.18, HULL, 0, true), -0.42, 1.02, -0.42);
      add(cyl(0.76, 1.18, HULL, 0, true), 0.42, 1.02, 0.42);
      add(cyl(0.56, 0.08, colorHex), -0.42, 1.61, -0.42);
      add(cyl(0.56, 0.08, colorHex), 0.42, 1.61, 0.42);
      // Pulsing central containment core
      const core = cyl(0.36, 0.88, CORE_GLOW, 0.75);
      add(core, 0, 0.88, 0);
      pulse.push(core);
      add(box(0.54, 0.08, 0.54, colorHex), 0, 1.34, 0);
      smokePos = new THREE.Vector3(-0.42, 1.68, -0.42);
      topY = 1.72;
      break;
    }

    case "refinery": {
      body.add(foundationPad(3, 2, 0.22));
      add(box(1.42, 0.62, 1.62, dark), 0.64, 0.53, 0);
      add(box(1.06, 0.3, 1.24, colorHex), 0.64, 0.94, 0);
      // Unloading bay ramp on front
      add(box(0.95, 0.14, 0.56, STEEL), 0.64, 0.28, 0.88);
      add(box(0.72, 0.26, 0.06, ORE_GLOW, 0.75), 0.64, 0.52, 0.83);
      // Twin ore silos with glowing fill gauge ring
      const silo = cyl(1.02, 1.48, HULL, 0, true);
      add(silo, -0.82, 0.96, 0);
      const ring = cyl(0.92, 0.14, ORE_GLOW, 0.8);
      add(ring, -0.82, 1.38, 0);
      pulse.push(ring);
      // Exhaust stack
      add(cyl(0.18, 1.68, GUNM), 1.18, 1.06, -0.58);
      smokePos = new THREE.Vector3(1.18, 1.92, -0.58);
      topY = 1.95;
      break;
    }

    case "barracks": {
      body.add(foundationPad(2, 2, 0.2));
      add(box(1.62, 0.7, 1.56, dark), 0, 0.55, -0.04);
      // Sloped reinforced bunker roof
      const roof = box(1.78, 0.18, 1.74, HULL);
      roof.rotation.x = 0.08;
      add(roof, 0, 0.98, -0.04);
      // Illuminated troop exit bay
      add(box(0.56, 0.46, 0.06, WIN_GLOW, 0.75), 0, 0.45, 0.75);
      add(box(0.96, 0.08, 0.06, colorHex), 0, 0.82, 0.74);
      // Flagpole + waving faction banner
      add(cyl(0.045, 1.15, STEEL), 0.66, 1.42, 0.56);
      flag = box(0.44, 0.24, 0.03, colorHex, 0.35);
      add(flag, 0.88, 1.84, 0.56);
      smokePos = new THREE.Vector3(-0.4, 1.15, -0.4);
      topY = 2.02;
      break;
    }

    case "factory":
    case "factory2": {
      const mk2 = kind === "factory2";
      body.add(foundationPad(3, 3, 0.22));
      add(box(2.58, 0.94, 2.52, dark), 0, 0.69, -0.04);
      // Sloped industrial roof monitor
      add(box(2.1, 0.28, 1.8, HULL), 0, 1.28, -0.14);
      // Vehicle exit hangar bay with bright strip
      add(box(1.56, 0.72, 0.08, GUNM), 0, 0.58, 1.23);
      add(box(1.48, 0.08, 0.05, WIN_GLOW, 0.85), 0, 0.94, 1.26);
      // Overhead assembly gantry
      add(box(1.9, 0.14, 0.18, colorHex), 0, 1.5, -0.68);
      add(box(0.12, 0.28, 0.12, HULL2), -0.88, 1.34, -0.68);
      add(box(0.12, 0.28, 0.12, HULL2), 0.88, 1.34, -0.68);
      // Smokestacks (left pair always; right pair + trim + comms mast on MKII)
      add(cyl(0.22, 0.98, GUNM), -0.94, 1.52, 0.76);
      add(cyl(0.22, 0.78, GUNM), -0.58, 1.42, 0.76);
      const f1 = sph(0.1, "#ff7638", 0.9);
      add(f1, -0.94, 2.04, 0.76);
      pulse.push(f1);
      if (mk2) {
        add(cyl(0.22, 0.98, GUNM), 0.94, 1.52, 0.76);
        add(cyl(0.22, 0.78, GUNM), 0.58, 1.42, 0.76);
        const f2 = sph(0.1, "#ff7638", 0.9);
        add(f2, 0.94, 2.04, 0.76);
        pulse.push(f2);
        // MKII gold/faction armor trim & command mast
        add(box(2.4, 0.08, 0.08, "#f0b830", 0.5), 0, 1.18, 1.24);
        add(box(0.08, 0.08, 2.3, "#f0b830", 0.5), 1.28, 1.18, -0.04);
        add(box(0.08, 0.08, 2.3, "#f0b830", 0.5), -1.28, 1.18, -0.04);
        add(cyl(0.06, 1.05, STEEL), 1.06, 1.88, -0.94);
        const b2 = sph(0.11, CORE_GLOW, 0.9);
        add(b2, 1.06, 2.44, -0.94);
        pulse.push(b2);
      }
      smokePos = new THREE.Vector3(-0.94, 2.06, 0.76);
      topY = mk2 ? 2.52 : 2.1;
      break;
    }

    case "turret": {
      body.add(foundationPad(1, 1, 0.16));
      add(cyl(0.8, 0.24, HULL2), 0, 0.28, 0);
      add(cyl(0.46, 0.24, dark), 0, 0.48, 0);
      turret = new THREE.Group();
      turret.position.set(0, 0.64, 0);
      body.add(turret);
      const pod = new THREE.Mesh(makeTurretGeo(0.58, 0.26, 0.76), getArmorMat(colorHex, 0.5, 0.48));
      pod.castShadow = true;
      turret.add(pod);
      recoil = new THREE.Group();
      recoil.position.set(0, 0.02, 0.26);
      turret.add(recoil);
      for (const bx of [-0.12, 0.12]) {
        const b = cyl(0.07, 0.72, GUNM);
        b.rotation.x = Math.PI / 2;
        b.position.set(bx, 0, 0.36);
        recoil.add(b);
      }
      const sight = sph(0.11, CORE_GLOW, 0.85);
      sight.position.set(0, 0.19, -0.1);
      turret.add(sight);
      smokePos = new THREE.Vector3(0, 0.8, 0);
      topY = 1.0;
      break;
    }

    case "radar": {
      body.add(foundationPad(2, 2, 0.2));
      add(cyl(1.26, 0.56, dark, 0, true), 0, 0.48, 0);
      const dome = sph(1.32, HULL);
      dome.scale.y *= 0.56;
      add(dome, 0, 0.82, 0);
      add(cyl(0.12, 1.0, GUNM), 0, 1.4, 0);
      spin = new THREE.Group();
      spin.position.set(0, 1.9, 0);
      body.add(spin);
      const rdish = cyl(0.84, 0.08, bright, 0, true);
      rdish.rotation.x = 0.92;
      rdish.position.z = 0.08;
      spin.add(rdish);
      const rbar = box(1.16, 0.07, 0.07, STEEL);
      rbar.position.y = 0.32;
      spin.add(rbar);
      for (const sx of [-0.55, 0.55]) {
        const tip = sph(0.08, CORE_GLOW, 0.9);
        tip.position.set(sx, 0.36, 0);
        spin.add(tip);
      }
      smokePos = new THREE.Vector3(0, 1.2, 0);
      topY = 2.45;
      break;
    }

    case "techlab": {
      body.add(foundationPad(3, 3, 0.24));
      add(box(2.44, 0.66, 2.44, dark), 0, 0.57, 0);
      add(box(1.86, 0.62, 1.86, HULL), -0.1, 1.2, -0.12);
      add(box(1.22, 0.42, 1.22, colorHex), -0.22, 1.72, -0.24);
      add(box(1.5, 0.12, 0.06, WIN_GLOW, 0.78), 0, 0.76, 1.24);
      // Restrained sci-fi energy spire with counter-rotating accelerator rings (no blinding bloom!)
      add(cyl(0.28, 1.65, HULL2), 0.78, 1.42, 0.78);
      const core = cyl(0.18, 1.5, CORE_GLOW, 0.55);
      add(core, 0.78, 1.46, 0.78);
      pulse.push(core);
      spin = new THREE.Group();
      spin.position.set(0.78, 1.62, 0.78);
      body.add(spin);
      const ring1 = new THREE.Mesh(geoTorus, getArmorMat(bright, 0.65, 0.35, 0.25));
      ring1.scale.setScalar(0.82);
      ring1.rotation.x = Math.PI / 2 + 0.32;
      spin.add(ring1);
      spin2 = new THREE.Group();
      spin2.position.set(0.78, 2.02, 0.78);
      body.add(spin2);
      const ring2 = new THREE.Mesh(geoTorus, getArmorMat(CORE_GLOW, 0.65, 0.35, 0.35));
      ring2.scale.setScalar(0.62);
      ring2.rotation.x = Math.PI / 2 - 0.35;
      spin2.add(ring2);
      const orb = sph(0.32, CORE_GLOW, 0.65);
      add(orb, 0.78, 2.38, 0.78);
      pulse.push(orb);
      // Roof comms spire
      add(cyl(0.05, 1.1, STEEL), -0.68, 2.25, -0.68);
      add(sph(0.09, colorHex, 0.85), -0.68, 2.82, -0.68);
      smokePos = new THREE.Vector3(-0.2, 1.95, -0.2);
      topY = 2.95;
      break;
    }

    case "arc": {
      body.add(foundationPad(1, 1, 0.16));
      add(cyl(0.78, 0.22, HULL2), 0, 0.26, 0);
      add(cyl(0.5, 0.34, dark), 0, 0.48, 0);
      for (const [ry, rd] of [
        [0.72, 0.66],
        [0.94, 0.54],
        [1.14, 0.42],
      ]) {
        const coil = new THREE.Mesh(geoTorus, getArmorMat(colorHex, 0.65, 0.35, 0.2));
        coil.rotation.x = Math.PI / 2;
        coil.scale.setScalar(rd);
        add(coil, 0, ry, 0);
      }
      add(cyl(0.16, 0.72, GUNM), 0, 0.94, 0);
      const orb = sph(0.36, CORE_GLOW, 0.85);
      add(orb, 0, 1.38, 0);
      pulse.push(orb);
      smokePos = new THREE.Vector3(0, 0.9, 0);
      topY = 1.62;
      break;
    }

    case "purifier": {
      body.add(foundationPad(2, 2, 0.2));
      add(box(1.56, 0.58, 0.86, dark), 0, 0.49, -0.44);
      add(box(0.68, 0.32, 0.06, ORE_GLOW, 0.75), 0, 0.54, 0.0);
      add(cyl(0.15, 0.84, GUNM), 0.56, 1.2, -0.5);
      for (const sx of [-0.48, 0.48]) {
        add(cyl(0.62, 1.32, HULL, 0, true), sx, 0.88, 0.46);
        const band = cyl(0.56, 0.14, ORE_GLOW, 0.8);
        add(band, sx, 1.22, 0.46);
        pulse.push(band);
      }
      const pipe = cyl(0.11, 1.12, STEEL);
      pipe.rotation.z = Math.PI / 2;
      add(pipe, 0, 1.36, 0.46);
      smokePos = new THREE.Vector3(0.56, 1.65, -0.5);
      topY = 1.7;
      break;
    }

    case "depot": {
      body.add(foundationPad(3, 2, 0.2));
      add(box(2.24, 0.06, 1.18, dark), 0.08, 0.24, 0.14);
      // Repair gantry frame + moving repair arm
      add(box(0.16, 1.3, 0.16, GUNM), -1.14, 0.85, -0.68);
      add(box(0.16, 1.3, 0.16, GUNM), 1.14, 0.85, -0.68);
      add(box(2.48, 0.16, 0.2, colorHex), 0, 1.52, -0.68);
      crane = new THREE.Group();
      crane.position.set(0.2, 1.36, -0.68);
      body.add(crane);
      const trolley = box(0.36, 0.24, 0.28, HULL);
      crane.add(trolley);
      const arm = box(0.12, 0.12, 1.1, HULL2);
      arm.position.set(0, -0.05, 0.55);
      crane.add(arm);
      const weld = sph(0.09, CORE_GLOW, 0.9);
      weld.position.set(0, -0.26, 1.02);
      crane.add(weld);
      pulse.push(weld);
      // Pad corner beacons
      for (const [bx, bz] of [
        [-1.08, 0.68],
        [1.08, 0.68],
      ]) {
        const b = sph(0.08, "#3dd97a", 0.8);
        add(b, bx, 0.3, bz);
        pulse.push(b);
      }
      smokePos = new THREE.Vector3(-0.8, 1.1, -0.4);
      topY = 1.72;
      break;
    }

    case "superweapon": {
      // Monumental Orbital Ion Uplink (3x3)
      body.add(foundationPad(3, 3, 0.24));
      // Armored stepped command bunker base
      add(box(2.54, 0.46, 2.54, dark), 0, 0.47, 0);
      add(box(2.08, 0.34, 2.08, HULL), 0, 0.87, 0);
      add(box(1.62, 0.18, 1.62, colorHex), 0, 1.12, 0);
      // Glowing cyan command viewports on all 4 flanks
      add(box(1.16, 0.1, 0.05, WIN_GLOW, 0.82), 0, 0.56, 1.28);
      add(box(1.16, 0.1, 0.05, WIN_GLOW, 0.82), 0, 0.56, -1.28);
      add(box(0.05, 0.1, 1.16, WIN_GLOW, 0.82), 1.28, 0.56, 0);
      add(box(0.05, 0.1, 1.16, WIN_GLOW, 0.82), -1.28, 0.56, 0);

      // Central sky-beam aperture pedestal + glowing plasma core
      const ped = cyl(1.24, 0.46, GUNM, 0, true);
      add(ped, 0, 1.38, 0);
      const apertureRing = new THREE.Mesh(geoTorus, getArmorMat(colorHex, 0.6, 0.38, 0.2));
      apertureRing.rotation.x = Math.PI / 2;
      apertureRing.scale.setScalar(1.02);
      add(apertureRing, 0, 1.62, 0);
      const skyCore = cyl(0.54, 0.26, CORE_GLOW, 0.92);
      add(skyCore, 0, 1.62, 0);
      pulse.push(skyCore);

      // Huge tilted orbital emitter dish assembly (spins smoothly)
      spin = new THREE.Group();
      spin.position.set(0, 1.98, 0);
      body.add(spin);
      const gimbal = new THREE.Mesh(geoTorus, getArmorMat(STEEL, 0.65, 0.35));
      gimbal.rotation.x = Math.PI / 2;
      gimbal.scale.setScalar(1.26);
      spin.add(gimbal);
      const dish = cyl(1.62, 0.18, bright, 0, true);
      dish.rotation.x = 0.52;
      dish.position.set(0, 0.22, -0.14);
      spin.add(dish);
      const dishRim = new THREE.Mesh(geoTorus, getArmorMat(CORE_GLOW, 0.6, 0.3, 0.5));
      dishRim.rotation.x = Math.PI / 2 + 0.52;
      dishRim.scale.setScalar(1.48);
      dishRim.position.set(0, 0.26, -0.16);
      spin.add(dishRim);
      // Emitter focus spire jutting from dish center
      const focusRod = cyl(0.1, 0.78, STEEL);
      focusRod.rotation.x = 0.52;
      focusRod.position.set(0, 0.56, 0.04);
      spin.add(focusRod);
      const focusOrb = sph(0.24, CORE_GLOW, 0.95);
      focusOrb.position.set(0, 0.86, 0.22);
      spin.add(focusOrb);
      pulse.push(focusOrb);

      // Counter-rotating cyan plasma accelerator ring orbiting the upper array
      spin2 = new THREE.Group();
      spin2.position.set(0, 2.28, 0);
      body.add(spin2);
      const accel1 = new THREE.Mesh(geoTorus, getArmorMat(CORE_GLOW, 0.65, 0.28, 0.55));
      accel1.rotation.x = Math.PI / 2 + 0.28;
      accel1.scale.setScalar(1.68);
      spin2.add(accel1);
      const accel2 = new THREE.Mesh(geoTorus, getArmorMat(bright, 0.65, 0.32, 0.35));
      accel2.rotation.x = Math.PI / 2 - 0.28;
      accel2.scale.setScalar(1.36);
      spin2.add(accel2);

      // 3 tall charging pylon spires positioned symmetrically at 120°
      for (let i = 0; i < 3; i++) {
        const ang = (i * Math.PI * 2) / 3 + Math.PI / 6;
        const px = Math.cos(ang) * 1.06;
        const pz = Math.sin(ang) * 1.06;
        const pylon = cyl(0.24, 1.92, HULL2, 0, true);
        add(pylon, px, 1.64, pz);
        const fin = box(0.12, 1.26, 0.36, colorHex);
        fin.rotation.y = -ang + Math.PI / 2;
        add(fin, Math.cos(ang) * 1.18, 1.38, Math.sin(ang) * 1.18);
        // Glowing plasma insulator collars along each spire
        for (const ry of [1.82, 2.18, 2.52]) {
          const coil = new THREE.Mesh(geoTorus, getArmorMat(CORE_GLOW, 0.6, 0.3, 0.65));
          coil.rotation.x = Math.PI / 2;
          coil.scale.setScalar(0.32);
          add(coil, px, ry, pz);
        }
        const tip = sph(0.18, CORE_GLOW, 0.95);
        add(tip, px, 2.72, pz);
        pulse.push(tip);
      }

      smokePos = new THREE.Vector3(-0.75, 1.65, -0.75);
      topY = 3.18;
      break;
    }

    case "derrick": {
      // Classic Nodding Industrial Oil Derrick (2x2)
      body.add(foundationPad(2, 2, 0.2));
      // Steel machinery skid & wellhead housing
      add(box(1.56, 0.16, 1.56, HULL), 0, 0.28, 0);
      add(box(0.54, 0.32, 0.56, GUNM), 0.18, 0.52, -0.34);
      // Wellhead collar + drill pipe at front (+Z)
      add(cyl(0.34, 0.42, GUNM), 0.18, 0.56, 0.56);
      add(cyl(0.2, 0.12, colorHex), 0.18, 0.78, 0.56);

      // Cylindrical crude oil storage tank with faction-colored trim band
      add(cyl(0.68, 0.88, HULL2), -0.48, 0.8, -0.36);
      add(cyl(0.71, 0.16, colorHex), -0.48, 0.92, -0.36);
      const capDome = sph(0.66, STEEL);
      capDome.scale.multiply(new THREE.Vector3(1, 0.34, 1));
      add(capDome, -0.48, 1.24, -0.36);
      // Faction status beacon on tank top
      const beacon = sph(0.12, colorHex, 0.85);
      add(beacon, -0.48, 1.42, -0.36);
      pulse.push(beacon);

      // Steel A-frame lattice Sampson post rising to the walking-beam pivot
      const pivotX = 0.18;
      const pivotY = 1.58;
      const pivotZ = -0.02;
      for (const [sx, sz] of [
        [-0.26, -0.26],
        [0.26, -0.26],
        [-0.26, 0.26],
        [0.26, 0.26],
      ]) {
        const strut = box(0.08, 1.28, 0.08, STEEL);
        strut.position.set(pivotX + sx * 0.55, 0.96, pivotZ + sz * 0.55);
        strut.rotation.z = sx > 0 ? 0.2 : -0.2;
        strut.rotation.x = sz > 0 ? -0.2 : 0.2;
        body.add(strut);
      }
      // Cross braces on Sampson post
      add(box(0.46, 0.06, 0.46, GUNM), pivotX, 0.92, pivotZ);
      add(box(0.26, 0.16, 0.24, GUNM), pivotX, pivotY, pivotZ);

      // Animated nodding horsehead walking-beam (crane rocks around X in anim.ts!)
      crane = new THREE.Group();
      crane.position.set(pivotX, pivotY, pivotZ);
      body.add(crane);
      // Horizontal I-beam
      const beam = box(0.16, 0.16, 1.38, colorHex);
      crane.add(beam);
      const beamTop = box(0.2, 0.05, 1.42, HULL);
      beamTop.position.set(0, 0.1, 0);
      crane.add(beamTop);
      // Industrial curved horsehead nose at front (+Z)
      const headMain = box(0.22, 0.44, 0.28, GUNM);
      headMain.position.set(0, -0.06, 0.64);
      headMain.rotation.x = 0.18;
      crane.add(headMain);
      const headAccent = box(0.24, 0.12, 0.3, "#d89c28");
      headAccent.position.set(0, 0.04, 0.66);
      crane.add(headAccent);
      // Vertical steel sucker rod descending into the wellhead
      const rod = cyl(0.05, 1.15, STEEL);
      rod.position.set(0, -0.62, 0.58);
      crane.add(rod);
      // Heavy rear counterweight & crank housing (-Z)
      const counter = box(0.32, 0.28, 0.34, dark);
      counter.position.set(0, -0.1, -0.64);
      crane.add(counter);

      smokePos = new THREE.Vector3(-0.48, 1.38, -0.36);
      topY = 2.18;
      break;
    }
  }

  // Health bar sprites (tagged isBar so icon renderer & raycaster ignore them)
  const barW = isBuildingKind(kind) ? Math.max(BUILDINGS[kind].w, 1.4) : 0.96;
  const { bg, fg } = makeBar(barW);
  bg.position.y = topY + 0.38;
  fg.position.y = topY + 0.38;
  root.add(bg, fg);

  // Veterancy badge sprite (centered cleanly above HP bar; hidden until rank >= 1)
  const vetMat = new THREE.SpriteMaterial({ transparent: true, opacity: 0.98, depthTest: false });
  const vetBadge = new THREE.Sprite(vetMat);
  vetBadge.position.set(0, topY + 0.58, 0);
  vetBadge.scale.set(0.76, 0.285, 1);
  vetBadge.renderOrder = 22;
  vetBadge.visible = false;
  vetBadge.userData.isBar = true;
  vetBadge.userData.vetRank = 0;
  root.add(vetBadge);

  // Crisp selection ring
  const ringSize = isBuildingKind(kind) ? Math.max(BUILDINGS[kind].w, BUILDINGS[kind].h) * 0.78 : 0.68;
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
  ring.position.y = 0.05;
  ring.visible = false;
  ring.userData.isBar = true;
  root.add(ring);

  for (const p of pulse) p.userData.baseScale = p.scale.clone();

  const rig: AnimRig = {
    body,
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
  };

  return { root, turret, barBg: bg, barFg: fg, vetBadge, ring, topY, spin, bin, rig, kind };
}

// ---------- Battlefield Supply Crate 3D Model ----------

const CRATE_ACCENTS: Record<CrateKind, string> = {
  cash: "#ffbe2e",
  vet: "#3ce8ff",
  heal: "#34e870",
  unit: "#ff5436",
};

const geoCrateBeacon = new THREE.CylinderGeometry(0.12, 0.34, 1.35, 12, 1, true);

export function makeCrateVis(kind: CrateKind): CrateVis {
  const accent = CRATE_ACCENTS[kind] ?? "#ffbe2e";
  const accentHex = new THREE.Color(accent).getHex();
  const root = new THREE.Group();

  // Hovering rotating armored drop-crate body
  const crateBox = new THREE.Group();
  crateBox.position.y = 0.48;
  root.add(crateBox);

  const hull = box(0.68, 0.56, 0.68, HULL, 0, 0.55, 0.45);
  crateBox.add(hull);
  // Glowing faction-neutral energy stripe band around crate center
  const band = box(0.72, 0.14, 0.72, accent, 0.95);
  crateBox.add(band);
  // Armored corner bumper frames
  for (const [cx, cz] of [
    [-0.31, -0.31],
    [0.31, -0.31],
    [-0.31, 0.31],
    [0.31, 0.31],
  ]) {
    const post = box(0.11, 0.62, 0.11, STEEL, 0, 0.6, 0.4);
    post.position.set(cx, 0, cz);
    crateBox.add(post);
  }
  // Top cap + glowing status diamond
  const lid = box(0.56, 0.08, 0.56, GUNM);
  lid.position.y = 0.31;
  crateBox.add(lid);
  const topCore = sph(0.18, accent, 1.0);
  topCore.position.y = 0.39;
  crateBox.add(topCore);

  // Pulsing ground beacon ring
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

  // Soft vertical light beacon column
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

  slab.userData.wireMat = wireMat;
  return slab;
}

export function setGhostColor(ghost: THREE.Mesh, ok: boolean) {
  (ghost.material as THREE.MeshBasicMaterial).color.setHex(ok ? 0x22e060 : 0xf03030);
  const wire = ghost.userData.wireMat as THREE.LineBasicMaterial | undefined;
  if (wire) wire.color.setHex(ok ? 0x55ff90 : 0xffc8c8);
}

// Keep unused-import warning away for geoCylOct
void geoCylOct;
