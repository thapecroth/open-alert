import * as THREE from "three";
import { BUILDINGS, EntKind, isBuildingKind } from "./util";

export interface EntVis {
  root: THREE.Group;
  turret: THREE.Group | null;
  barBg: THREE.Sprite;
  barFg: THREE.Sprite;
  ring: THREE.Mesh;
  topY: number;
  /** slowly rotating parts (radar dishes) — rendered each frame by Renderer */
  spin?: THREE.Group;
  /** harvester cargo fill — scaled by cargo fraction */
  bin?: THREE.Mesh;
}

// ---------- materials ----------
const matCache = new Map<string, THREE.MeshStandardMaterial>();
function mat(hex: string, emissive = 0): THREE.MeshStandardMaterial {
  const key = hex + "|" + emissive;
  let m = matCache.get(key);
  if (!m) {
    const c = new THREE.Color(hex);
    m = new THREE.MeshStandardMaterial({
      color: c,
      roughness: 0.46,
      metalness: 0.62,
      emissive: c.clone().multiplyScalar(emissive),
    });
    matCache.set(key, m);
  }
  return m;
}
// unlit/emissive material — glows under bloom
function glowMat(hex: string, intensity = 1.6): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: hex });
  m.color.multiplyScalar(intensity);
  return m;
}
// dim saturated team hex -> darker armored variant for hull mass
function dim(hex: string, f: number): string {
  return "#" + new THREE.Color(hex).multiplyScalar(f).getHexString();
}

const HULL = "#1a2126"; // near-black armor
const HULL2 = "#2c363e"; // dark panel
const GUNM = "#111417"; // gunmetal
const ORE_GLOW = "#ffb830";
const CORE_GLOW = "#4fd8ff";
const WIN_GLOW = "#7fe4ff";

// shared geometries — units are made of a handful of primitives
const geoBox = new THREE.BoxGeometry(1, 1, 1);
const geoCyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 14);
const geoCylTaper = new THREE.CylinderGeometry(0.5, 0.36, 1, 14);
const geoSph = new THREE.SphereGeometry(0.5, 12, 8);
const geoRing = new THREE.RingGeometry(0.86, 1.0, 40);

function box(w: number, h: number, d: number, hex: string, e = 0): THREE.Mesh {
  const b = new THREE.Mesh(geoBox, e > 0.55 ? glowMat(hex, 1 + e) : mat(hex, e));
  b.scale.set(w, h, d);
  b.castShadow = true;
  return b;
}
function cyl(d: number, h: number, hex: string, e = 0, taperTop?: number): THREE.Mesh {
  const g = taperTop !== undefined ? geoCylTaper : geoCyl;
  const c = new THREE.Mesh(g, e > 0.55 ? glowMat(hex, 1 + e) : mat(hex, e));
  c.scale.set(d, h, d);
  c.castShadow = true;
  return c;
}
function sph(d: number, hex: string, e = 0): THREE.Mesh {
  const s = new THREE.Mesh(geoSph, e > 0.55 ? glowMat(hex, 1 + e) : mat(hex, e));
  s.scale.setScalar(d);
  s.castShadow = true;
  return s;
}

function makeSprite(w: number, h: number, hex: string, opacity: number): THREE.Sprite {
  const m = new THREE.SpriteMaterial({ color: hex, transparent: true, opacity, depthTest: false });
  const s = new THREE.Sprite(m);
  s.scale.set(w, h, 1);
  s.renderOrder = 20;
  return s;
}

function makeBar(w: number): { bg: THREE.Sprite; fg: THREE.Sprite } {
  const bg = makeSprite(w, 0.13, "#0a0e12", 0.85);
  const fg = makeSprite(w - 0.05, 0.07, "#26e050", 0.95);
  fg.userData.w = w - 0.05;
  bg.userData.isBar = true;
  fg.userData.isBar = true;
  return { bg, fg };
}

export function makeEntVis(kind: EntKind, colorHex: string, scene: THREE.Scene): EntVis {
  const root = new THREE.Group();
  let turret: THREE.Group | null = null;
  let topY = 1.0;
  let spin: THREE.Group | undefined;
  let bin: THREE.Mesh | undefined;
  const dark = dim(colorHex, 0.55);
  const add = (m: THREE.Object3D, x = 0, y = 0, z = 0) => {
    root.add(m);
    m.position.set(x, y, z);
    return m;
  };

  switch (kind) {
    case "tank": {
      // track pods with wheel bumps
      add(box(0.38, 0.34, 1.8, GUNM), -0.58, 0.24);
      add(box(0.38, 0.34, 1.8, GUNM), 0.58, 0.24);
      for (const sx of [-0.6, 0.6])
        for (const sz of [-0.55, 0, 0.55]) add(sph(0.34, "#0a0c0e"), sx, 0.18, sz);
      // stepped hull + team deck
      add(box(1.02, 0.32, 1.6, dark), 0, 0.44);
      add(box(0.74, 0.18, 1.12, colorHex), 0, 0.64, -0.05);
      // glowing side strips
      add(box(0.03, 0.08, 1.34, colorHex, 1.0), -0.53, 0.46);
      add(box(0.03, 0.08, 1.34, colorHex, 1.0), 0.53, 0.46);
      turret = new THREE.Group();
      turret.position.y = 0.74;
      root.add(turret);
      const tb = box(0.62, 0.28, 0.82, colorHex);
      tb.position.z = -0.05;
      turret.add(tb);
      const hatch = cyl(0.32, 0.1, HULL2);
      hatch.position.set(0, 0.18, -0.2);
      turret.add(hatch);
      const barrel = cyl(0.09, 1.05, GUNM);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.06, 0.62);
      turret.add(barrel);
      const tip = cyl(0.14, 0.14, colorHex, 0.9);
      tip.rotation.x = Math.PI / 2;
      tip.position.set(0, 0.06, 1.12);
      turret.add(tip);
      topY = 1.08;
      break;
    }
    case "infantry": {
      add(box(0.1, 0.26, 0.11, GUNM), -0.08, 0.13);
      add(box(0.1, 0.26, 0.11, GUNM), 0.08, 0.13);
      add(box(0.28, 0.32, 0.17, colorHex), 0, 0.42);
      add(box(0.18, 0.2, 0.09, HULL2), 0, 0.44, -0.13);
      add(sph(0.22, HULL2), 0, 0.66);
      add(box(0.14, 0.05, 0.03, WIN_GLOW, 1.0), 0, 0.67, 0.1);
      const rifle = cyl(0.04, 0.44, GUNM);
      rifle.rotation.x = Math.PI / 2;
      add(rifle, 0.17, 0.4, 0.11);
      topY = 0.86;
      break;
    }
    case "harvester": {
      for (const [wx, wz] of [
        [-0.62, 0.65],
        [0.62, 0.65],
        [-0.62, -0.65],
        [0.62, -0.65],
      ]) {
        const w = cyl(0.44, 0.24, "#0a0c0e");
        w.rotation.z = Math.PI / 2;
        add(w, wx, 0.22, wz);
      }
      add(box(1.18, 0.32, 1.95, HULL), 0, 0.44);
      add(box(1.28, 0.36, 1.08, dark), 0, 0.7, -0.35);
      // ore cargo glow — scales with load
      bin = box(1.02, 0.32, 0.88, ORE_GLOW, 0.9);
      bin.position.set(0, 0.9, -0.35);
      bin.scale.y = 0.05;
      root.add(bin);
      add(box(0.88, 0.52, 0.62, colorHex), 0, 0.7, 0.66);
      add(box(0.72, 0.2, 0.04, WIN_GLOW, 1.0), 0, 0.8, 0.98);
      add(box(0.13, 0.13, 0.52, HULL2), -0.52, 0.34, 1.08);
      add(box(0.13, 0.13, 0.52, HULL2), 0.52, 0.34, 1.08);
      topY = 1.08;
      break;
    }
    case "engineer": {
      // slim infantry — satchel + hard hat + hand toolbox, no rifle
      add(box(0.09, 0.24, 0.1, GUNM), -0.07, 0.12);
      add(box(0.09, 0.24, 0.1, GUNM), 0.07, 0.12);
      add(box(0.24, 0.3, 0.14, colorHex), 0, 0.39);
      add(box(0.18, 0.24, 0.09, HULL2), 0, 0.42, -0.12);
      add(cyl(0.25, 0.035, "#f0c020"), 0, 0.56, 0.01);
      add(sph(0.18, "#f0c020"), 0, 0.6);
      add(box(0.15, 0.1, 0.08, HULL2), 0.15, 0.3, 0.05);
      topY = 0.8;
      break;
    }
    case "rocket": {
      add(box(0.1, 0.26, 0.11, GUNM), -0.08, 0.13);
      add(box(0.1, 0.26, 0.11, GUNM), 0.08, 0.13);
      add(box(0.28, 0.32, 0.17, colorHex), 0, 0.42);
      add(sph(0.22, HULL2), 0, 0.66);
      add(box(0.14, 0.05, 0.03, WIN_GLOW, 1.0), 0, 0.67, 0.1);
      // twin shoulder launch tubes, tilted up-forward
      for (const sx of [-0.19, 0.19]) {
        const tube = cyl(0.075, 0.52, GUNM);
        tube.rotation.x = Math.PI / 2 - 0.28;
        add(tube, sx, 0.68, -0.04);
        add(sph(0.06, colorHex, 0.9), sx, 0.75, 0.21);
      }
      topY = 0.92;
      break;
    }
    case "arty": {
      for (const [wx, wz] of [
        [-0.52, 0.55],
        [0.52, 0.55],
        [-0.52, -0.55],
        [0.52, -0.55],
      ]) {
        const w = cyl(0.38, 0.2, "#0a0c0e");
        w.rotation.z = Math.PI / 2;
        add(w, wx, 0.19, wz);
      }
      add(box(0.95, 0.22, 1.6, HULL), 0, 0.36);
      add(box(0.88, 0.08, 1.5, dark), 0, 0.51);
      add(box(0.7, 0.4, 0.45, colorHex), 0, 0.62, 0.52);
      add(box(0.5, 0.12, 0.04, WIN_GLOW, 1.0), 0, 0.68, 0.75);
      // long launch rail angled up-forward + rear strut
      const rail = box(0.3, 0.14, 1.55, GUNM);
      rail.rotation.x = -0.55;
      add(rail, 0, 0.92, -0.22);
      const rstrip = box(0.33, 0.05, 1.3, colorHex, 0.8);
      rstrip.rotation.x = -0.55;
      add(rstrip, 0, 0.98, -0.16);
      const strut = box(0.1, 0.34, 0.1, HULL2);
      strut.rotation.x = -0.5;
      add(strut, 0, 0.62, -0.62);
      topY = 1.5;
      break;
    }
    case "heavy": {
      // scaled-up tank — wider hull, twin barrels
      add(box(0.46, 0.4, 2.1, GUNM), -0.72, 0.28);
      add(box(0.46, 0.4, 2.1, GUNM), 0.72, 0.28);
      for (const sx of [-0.74, 0.74])
        for (const sz of [-0.68, 0, 0.68]) add(sph(0.4, "#0a0c0e"), sx, 0.2, sz);
      add(box(1.3, 0.38, 1.9, dark), 0, 0.52);
      add(box(0.95, 0.2, 1.3, colorHex), 0, 0.78, -0.05);
      add(box(0.03, 0.09, 1.6, colorHex, 1.0), -0.67, 0.55);
      add(box(0.03, 0.09, 1.6, colorHex, 1.0), 0.67, 0.55);
      turret = new THREE.Group();
      turret.position.y = 0.92;
      root.add(turret);
      const htb = box(0.85, 0.3, 1.0, colorHex);
      htb.position.z = -0.08;
      turret.add(htb);
      const hhatch = cyl(0.36, 0.1, HULL2);
      hhatch.position.set(0, 0.19, -0.3);
      turret.add(hhatch);
      for (const bx of [-0.19, 0.19]) {
        const hb = cyl(0.1, 1.2, GUNM);
        hb.rotation.x = Math.PI / 2;
        hb.position.set(bx, 0.05, 0.68);
        turret.add(hb);
        const htp = cyl(0.15, 0.16, colorHex, 0.9);
        htp.rotation.x = Math.PI / 2;
        htp.position.set(bx, 0.05, 1.26);
        turret.add(htp);
      }
      topY = 1.18;
      break;
    }
    case "spider": {
      // squat drone — low body, dome back, glow eye, 4 splayed legs
      add(box(0.5, 0.26, 0.44, HULL), 0, 0.38);
      add(sph(0.44, dark), 0, 0.5);
      add(box(0.3, 0.08, 0.26, colorHex), 0, 0.58);
      add(sph(0.12, CORE_GLOW, 1.0), 0, 0.42, 0.24);
      for (const [lx, lz] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ]) {
        const leg = box(0.05, 0.5, 0.05, GUNM);
        leg.rotation.z = 0.75 * lx;
        leg.rotation.x = -0.45 * lz;
        add(leg, lx * 0.36, 0.22, lz * 0.26);
      }
      topY = 0.74;
      break;
    }
    case "conyard": {
      add(box(2.9, 0.35, 2.9, HULL2), 0, 0.17);
      add(box(2.5, 0.45, 2.5, dark), 0, 0.57);
      add(box(1.5, 0.7, 1.4, colorHex), -0.35, 1.15);
      add(box(1.0, 0.5, 1.8, HULL2), 0.85, 1.0, -0.3);
      const crane = box(0.14, 0.14, 1.9, HULL2);
      crane.rotation.x = -0.5;
      add(crane, -0.4, 1.9, 0.55);
      add(cyl(0.07, 1.3, GUNM), 0.85, 1.9, 0.8);
      spin = new THREE.Group();
      spin.position.set(0.85, 2.55, 0.8);
      root.add(spin);
      const dish = cyl(0.55, 0.06, dim(colorHex, 0.8));
      dish.rotation.x = 0.9;
      spin.add(dish);
      add(sph(0.16, colorHex, 1.0), -0.9, 1.75, -0.9);
      topY = 2.7;
      break;
    }
    case "power": {
      add(box(1.9, 0.4, 1.9, HULL2), 0, 0.2);
      const t1 = cyl(0.72, 1.1, HULL, 0, 0.42);
      add(t1, -0.45, 0.95, -0.45);
      const t2 = cyl(0.72, 1.1, HULL, 0, 0.42);
      add(t2, 0.45, 0.95, 0.45);
      add(cyl(0.34, 0.9, CORE_GLOW, 1.0), 0.05, 0.85, 0.05);
      add(box(0.5, 0.06, 0.5, colorHex, 0.8), 0.05, 1.28, 0.05);
      topY = 1.6;
      break;
    }
    case "refinery": {
      add(box(2.9, 0.4, 1.9, HULL2), 0, 0.2);
      add(box(1.4, 0.5, 1.7, dark), 0.65, 0.65);
      add(box(0.7, 0.35, 0.5, colorHex), 0.75, 0.6, 1.05);
      const silo = cyl(1.0, 1.5, HULL, 0, 0.8);
      add(silo, -0.85, 1.05);
      add(cyl(1.04, 0.14, ORE_GLOW, 0.9), -0.85, 1.5);
      add(cyl(0.16, 1.7, GUNM), 1.15, 1.1, -0.6);
      topY = 1.95;
      break;
    }
    case "barracks": {
      add(box(1.9, 0.3, 1.9, HULL2), 0, 0.15);
      add(box(1.6, 0.75, 1.6, dark), 0, 0.68);
      const roof = box(1.85, 0.16, 1.85, HULL);
      roof.rotation.z = 0.06;
      add(roof, 0, 1.12);
      add(box(0.45, 0.5, 0.05, WIN_GLOW, 0.85), 0, 0.55, 0.81);
      add(box(0.9, 0.06, 0.04, colorHex, 0.9), 0, 0.95, 0.79);
      add(cyl(0.045, 1.1, GUNM), 0.62, 1.55, 0.62);
      add(box(0.38, 0.22, 0.025, colorHex, 0.8), 0.81, 1.98, 0.62);
      topY = 1.35;
      break;
    }
    case "factory": {
      add(box(2.9, 0.3, 2.9, HULL2), 0, 0.15);
      add(box(2.6, 0.95, 2.6, dark), 0, 0.78);
      add(box(1.6, 0.75, 0.06, GUNM), 0, 0.62, 1.31);
      add(box(1.5, 0.07, 0.03, WIN_GLOW, 1.0), 0, 0.95, 1.33);
      add(box(1.8, 0.12, 0.14, colorHex), 0, 1.35, -0.6);
      add(box(0.1, 0.25, 0.1, HULL2), -0.85, 1.2, -0.6);
      add(box(0.1, 0.25, 0.1, HULL2), 0.85, 1.2, -0.6);
      add(cyl(0.2, 0.9, GUNM), -0.9, 1.4, 0.9);
      add(cyl(0.2, 0.7, GUNM), -0.55, 1.3, 0.9);
      add(sph(0.1, "#ff6a3d", 1.0), -0.9, 1.88, 0.9);
      topY = 1.6;
      break;
    }
    case "turret": {
      add(cyl(0.85, 0.25, HULL2), 0, 0.12);
      add(cyl(0.4, 0.3, dark), 0, 0.36);
      turret = new THREE.Group();
      turret.position.y = 0.55;
      root.add(turret);
      const pod = box(0.55, 0.3, 0.85, colorHex);
      pod.position.z = 0.08;
      turret.add(pod);
      for (const bx of [-0.12, 0.12]) {
        const b = cyl(0.07, 0.75, GUNM);
        b.rotation.x = Math.PI / 2;
        b.position.set(bx, 0.05, 0.68);
        turret.add(b);
      }
      const sight = cyl(0.14, 0.05, colorHex, 1.0);
      sight.position.set(0, 0.2, -0.15);
      turret.add(sight);
      topY = 0.95;
      break;
    }
    case "radar": {
      add(box(1.9, 0.3, 1.9, HULL2), 0, 0.15);
      add(cyl(1.15, 0.55, dark, 0, 0.6), 0, 0.58);
      const dome = sph(1.3, HULL);
      dome.scale.y = 0.62;
      add(dome, 0, 0.95);
      add(cyl(0.09, 1.05, GUNM), 0, 1.5);
      // rotating dish + antenna array — spun per-frame by Renderer
      spin = new THREE.Group();
      spin.position.set(0, 1.95, 0);
      root.add(spin);
      const rdish = cyl(0.72, 0.06, dim(colorHex, 0.8));
      rdish.rotation.x = 0.9;
      rdish.position.z = 0.08;
      spin.add(rdish);
      const rbar = box(1.05, 0.07, 0.06, HULL2);
      rbar.position.y = 0.3;
      spin.add(rbar);
      for (const sx of [-0.5, 0.5]) {
        const tip = box(0.06, 0.18, 0.06, colorHex, 0.9);
        tip.position.set(sx, 0.36, 0);
        spin.add(tip);
      }
      topY = 2.45;
      break;
    }
    case "factory2": {
      // upgraded war factory — same silhouette + second stack pair, antenna, trim
      add(box(2.9, 0.3, 2.9, HULL2), 0, 0.15);
      add(box(2.6, 0.95, 2.6, dark), 0, 0.78);
      add(box(1.6, 0.75, 0.06, GUNM), 0, 0.62, 1.31);
      add(box(1.5, 0.07, 0.03, WIN_GLOW, 1.0), 0, 0.95, 1.33);
      add(box(1.8, 0.12, 0.14, colorHex), 0, 1.35, -0.6);
      add(box(0.1, 0.25, 0.1, HULL2), -0.85, 1.2, -0.6);
      add(box(0.1, 0.25, 0.1, HULL2), 0.85, 1.2, -0.6);
      add(cyl(0.2, 0.9, GUNM), -0.9, 1.4, 0.9);
      add(cyl(0.2, 0.7, GUNM), -0.55, 1.3, 0.9);
      add(sph(0.1, "#ff6a3d", 1.0), -0.9, 1.88, 0.9);
      add(cyl(0.2, 0.9, GUNM), 0.9, 1.4, 0.9);
      add(cyl(0.2, 0.7, GUNM), 0.55, 1.3, 0.9);
      add(sph(0.1, "#ff6a3d", 1.0), 0.9, 1.88, 0.9);
      add(cyl(0.05, 1.0, GUNM), 1.1, 1.75, -1.0);
      add(sph(0.09, colorHex, 1.0), 1.1, 2.28, -1.0);
      add(box(2.2, 0.06, 0.05, colorHex, 0.9), 0, 1.28, 1.31);
      add(box(0.05, 0.06, 2.2, colorHex, 0.9), 1.31, 1.28, 0);
      topY = 2.45;
      break;
    }
    case "techlab": {
      add(box(2.9, 0.35, 2.9, HULL2), 0, 0.17);
      add(box(2.4, 0.7, 2.4, dark), 0, 0.7);
      add(box(1.8, 0.7, 1.8, HULL), 0, 1.38, -0.15);
      add(box(1.2, 0.45, 1.2, colorHex), -0.2, 1.95, -0.3);
      add(box(1.5, 0.1, 0.05, WIN_GLOW, 1.0), 0, 0.8, 1.21);
      // glowing core spire
      add(cyl(0.45, 1.9, CORE_GLOW, 1.0), 0.8, 1.6, 0.8);
      add(sph(0.5, CORE_GLOW, 1.0), 0.8, 2.65, 0.8);
      // antenna on the top step
      add(cyl(0.045, 1.2, GUNM), -0.7, 2.3, -0.7);
      add(sph(0.09, colorHex, 1.0), -0.7, 2.92, -0.7);
      topY = 3.1;
      break;
    }
    case "arc": {
      // tesla-coil analog — stacked winding + orb tip; zaps all dirs, no turret
      add(cyl(0.85, 0.22, HULL2), 0, 0.11);
      add(cyl(0.5, 0.4, dark), 0, 0.4);
      for (const [ry, rd] of [
        [0.66, 0.62],
        [0.88, 0.5],
        [1.08, 0.38],
      ]) {
        add(cyl(rd, 0.15, colorHex, 0.5, 1), 0, ry);
      }
      add(cyl(0.15, 0.6, GUNM), 0, 0.85);
      add(sph(0.4, CORE_GLOW, 1.0), 0, 1.3);
      for (const a of [0, 1, 2, 3]) {
        const f = box(0.05, 0.34, 0.24, HULL2);
        f.rotation.y = (a * Math.PI) / 2;
        add(f, Math.sin((a * Math.PI) / 2) * 0.42, 0.3, Math.cos((a * Math.PI) / 2) * 0.42);
      }
      topY = 1.55;
      break;
    }
    case "purifier": {
      add(box(1.9, 0.3, 1.9, HULL2), 0, 0.15);
      add(box(1.5, 0.6, 0.85, dark), 0, 0.6, -0.45);
      add(box(0.6, 0.32, 0.05, ORE_GLOW, 0.85), 0, 0.62, -0.01);
      add(cyl(0.14, 0.8, GUNM), 0.55, 1.3, -0.5);
      // twin silos + glow bands + connecting pipework
      for (const sx of [-0.5, 0.5]) {
        add(cyl(0.6, 1.35, HULL, 0, 0.7), sx, 0.98, 0.5);
        add(cyl(0.64, 0.13, ORE_GLOW, 0.9), sx, 1.32, 0.5);
      }
      const pipe = cyl(0.11, 1.15, GUNM);
      pipe.rotation.z = Math.PI / 2;
      add(pipe, 0, 1.46, 0.5);
      add(cyl(0.1, 1.15, GUNM), 0, 0.87, 0.5);
      topY = 1.72;
      break;
    }
    case "depot": {
      add(box(2.9, 0.22, 1.9, HULL2), 0, 0.11);
      add(box(2.2, 0.05, 1.1, dim(colorHex, 0.8)), 0.1, 0.245, 0.15);
      // gantry crane over the pad
      add(box(0.14, 1.3, 0.14, GUNM), -1.15, 0.87, -0.7);
      add(box(0.14, 1.3, 0.14, GUNM), 1.15, 0.87, -0.7);
      add(box(2.45, 0.16, 0.18, colorHex), 0, 1.55, -0.7);
      add(box(0.34, 0.26, 0.26, HULL), 0.3, 1.38, -0.7);
      add(box(0.12, 0.12, 1.15, HULL2), 0.3, 1.32, -0.12);
      add(box(0.06, 0.32, 0.06, GUNM), 0.3, 1.1, 0.38);
      add(box(1.9, 0.05, 0.06, WIN_GLOW, 1.0), 0, 1.46, -0.6);
      // tools & drums scattered on the pad
      add(box(0.42, 0.32, 0.34, colorHex), -0.55, 0.38, 0.45);
      add(box(0.3, 0.24, 0.3, HULL), 0.9, 0.34, 0.55);
      add(box(0.28, 0.44, 0.28, dark), 1.1, 0.44, -0.15);
      add(cyl(0.24, 0.5, GUNM), -1.0, 0.47, 0.5);
      topY = 1.7;
      break;
    }
  }

  const barW = isBuildingKind(kind) ? Math.max(BUILDINGS[kind].w, 1.4) : 1.0;
  const { bg, fg } = makeBar(barW);
  bg.position.y = topY + 0.38;
  fg.position.y = topY + 0.38;
  root.add(bg, fg);

  const ringSize = isBuildingKind(kind) ? Math.max(BUILDINGS[kind].w, BUILDINGS[kind].h) * 0.78 : 0.68;
  const ring = new THREE.Mesh(geoRing, new THREE.MeshBasicMaterial({ color: 0x66e8ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.scale.setScalar(ringSize);
  ring.position.y = 0.06;
  ring.visible = false;
  ring.userData.isBar = true; // excluded from icon renders, like the bars
  root.add(ring);

  return { root, turret, barBg: bg, barFg: fg, ring, topY, spin, bin };
}

export function tagEntity(root: THREE.Group, id: number) {
  root.userData.entityId = id;
  root.traverse((o) => (o.userData.entityId = id));
}

export function applyFacing(node: THREE.Object3D, d: number) {
  // models are built facing +z; server d = atan2(dy,dx) in map coords (x→x, y→z)
  node.rotation.y = Math.PI / 2 - d;
}
