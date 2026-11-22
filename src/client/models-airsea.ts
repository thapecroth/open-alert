import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { EntKind } from "./util";
import type { AnimRig, BuiltModel } from "./models";
import {
  getAccentMat,
  getChassisMat,
  getConcreteMat,
  getGlassMat,
  getGlowMat,
} from "./textures";

// ---------- Palette & Material Helpers (75% Military Titanium/Steel + 25% Satin Faction Accent) ----------

function dim(hex: string, f: number): string {
  return "#" + new THREE.Color(hex).multiplyScalar(f).getHexString();
}
function lift(hex: string, amt: number): string {
  const c = new THREE.Color(hex);
  c.lerp(new THREE.Color(0xffffff), amt);
  return "#" + c.getHexString();
}

const TITANIUM = "#4a5866";
const TITANIUM_LT = "#6a7b8c";
const TITANIUM_DK = "#2e3843";
const STEALTH = "#232b34";
const GUNM = "#171c22";
const STEEL = "#7c8c9b";
const CRANE_YEL = "#dfa626";
const CRANE_DK = "#9e7216";
const BRASS = "#cfa038";
const ASPHALT = "#232a31";
const ORE_GLOW = "#ffaa2c";
const CORE_GLOW = "#48dcff";
const AFTERBURN = "#ff8528";
const CRIMSON = "#ff4526";
const EMERALD = "#3af082";

// ---------- Cached Shared Primitives & Sculpted Geometries ----------

const geoBox = new THREE.BoxGeometry(1, 1, 1);
const geoCyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 16);
const geoCylTaper = new THREE.CylinderGeometry(0.35, 0.52, 1, 16);
const geoSph = new THREE.SphereGeometry(0.5, 16, 12);
const geoCone = new THREE.ConeGeometry(0.5, 1, 12);
const geoRotorDisc = new THREE.CircleGeometry(1, 28);
geoRotorDisc.rotateX(-Math.PI / 2);

const rotorDiscMat = new THREE.MeshBasicMaterial({
  color: 0x26323c,
  transparent: true,
  opacity: 0.17,
  side: THREE.DoubleSide,
  depthWrite: false,
});

const rotorRingGeo = new THREE.RingGeometry(0.84, 1.0, 28);
rotorRingGeo.rotateX(-Math.PI / 2);
const rotorRingMat = new THREE.MeshBasicMaterial({
  color: 0xdca828,
  transparent: true,
  opacity: 0.24,
  side: THREE.DoubleSide,
  depthWrite: false,
});

const rboxCache = new Map<string, RoundedBoxGeometry>();
function getRoundedBoxGeo(w: number, h: number, d: number, r = 0.04): RoundedBoxGeometry {
  const rad = Math.min(r, w * 0.42, h * 0.42, d * 0.42);
  const key = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}|${rad.toFixed(3)}`;
  let g = rboxCache.get(key);
  if (!g) {
    g = new RoundedBoxGeometry(w, h, d, 2, rad);
    rboxCache.set(key, g);
  }
  return g;
}

// --- Sculpted Extrude & Lathe Geometries (built once, shared across all instances) ---

// 1. Stealth Hangar Arched Shell (extruded along X)
function makeHangarArchGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.42, 0);
  s.lineTo(-0.42, 0.34);
  s.lineTo(-0.24, 0.62);
  s.lineTo(0.24, 0.62);
  s.lineTo(0.42, 0.34);
  s.lineTo(0.42, 0);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 1.48,
    bevelEnabled: true,
    bevelThickness: 0.04,
    bevelSize: 0.03,
    bevelSegments: 2,
  });
  g.center();
  g.rotateY(Math.PI / 2);
  return g;
}

// 2. Valkyrie Jet: Sculpted Faceted Stealth Delta Fuselage + Swept Wings (planform, +Y -> +Z)
function makeInterceptorPlanformGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  // Start at sharp nose (+y = +1.12), sweep clockwise around starboard wing, trailing edge, port wing
  s.moveTo(0, 1.12);
  s.lineTo(0.14, 0.64);
  s.lineTo(0.26, 0.34); // chined LERX strake
  s.lineTo(0.96, -0.34); // swept delta wingtip leading
  s.lineTo(0.92, -0.56); // wingtip trailing
  s.lineTo(0.42, -0.44); // forward-swept trailing notch
  s.lineTo(0.32, -0.74); // rear fuselage edge
  s.lineTo(0.16, -0.78);
  s.lineTo(0, -0.66); // twin-engine cleft
  s.lineTo(-0.16, -0.78);
  s.lineTo(-0.32, -0.74);
  s.lineTo(-0.42, -0.44);
  s.lineTo(-0.92, -0.56);
  s.lineTo(-0.96, -0.34);
  s.lineTo(-0.26, 0.34);
  s.lineTo(-0.14, 0.64);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.085,
    bevelEnabled: true,
    bevelThickness: 0.032,
    bevelSize: 0.025,
    bevelSegments: 2,
  });
  g.center();
  g.rotateX(Math.PI / 2);
  return g;
}

// 3. Valkyrie Jet: Swept Trapezoidal Tail Stabilizer Fin
function makeJetTailFinGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.22, 0);
  s.lineTo(0.22, 0);
  s.lineTo(0.06, 0.36);
  s.lineTo(-0.18, 0.36);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.028,
    bevelEnabled: true,
    bevelThickness: 0.01,
    bevelSize: 0.008,
    bevelSegments: 1,
  });
  g.center();
  g.rotateY(-Math.PI / 2);
  return g;
}

// 4. Hornet Gunship: Faceted Stealth Comanche/Apache Fuselage Side Profile (+x -> +Z)
function makeChopperHullGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0.92, -0.06); // sharp stealth sensor nose
  s.lineTo(0.72, 0.08);
  s.lineTo(0.46, 0.14); // forward cockpit sill
  s.lineTo(0.22, 0.24); // tandem upper canopy sill
  s.lineTo(-0.32, 0.24); // engine deck
  s.lineTo(-0.56, 0.1);
  s.lineTo(-1.38, 0.08); // tapered stealth tail boom top
  s.lineTo(-1.38, -0.05); // tail boom bottom
  s.lineTo(-0.48, -0.14);
  s.lineTo(0.44, -0.18); // armored belly
  s.lineTo(0.84, -0.13); // chin gun bay
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.34,
    bevelEnabled: true,
    bevelThickness: 0.055,
    bevelSize: 0.035,
    bevelSegments: 2,
  });
  g.center();
  g.rotateY(-Math.PI / 2);
  return g;
}

// 5. Hornet Gunship: Enclosed Fenestron Stealth Tail Fin
function makeFenestronFinGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.24, -0.12);
  s.lineTo(0.16, -0.12);
  s.lineTo(0.02, 0.38);
  s.lineTo(-0.26, 0.34);
  s.closePath();
  // Circular fenestron rotor duct cutout
  const hole = new THREE.Path();
  hole.absarc(-0.06, 0.1, 0.135, 0, Math.PI * 2, true);
  s.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.055,
    bevelEnabled: true,
    bevelThickness: 0.012,
    bevelSize: 0.01,
    bevelSegments: 1,
  });
  g.center();
  g.rotateY(-Math.PI / 2);
  return g;
}

// 6. Tempest Bomber: B-2 / Next-Gen Stealth Flying-Wing Planform (+y -> +Z)
function makeBomberWingGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0.96); // sharp stealth flying-wing apex
  s.lineTo(1.38, -0.22); // broad swept leading edge
  s.lineTo(1.26, -0.52); // clipped wingtip
  // Iconic stealth sawtooth W-serrated trailing edge
  s.lineTo(0.76, -0.26);
  s.lineTo(0.48, -0.56);
  s.lineTo(0.18, -0.34);
  s.lineTo(0, -0.52);
  s.lineTo(-0.18, -0.34);
  s.lineTo(-0.48, -0.56);
  s.lineTo(-0.76, -0.26);
  s.lineTo(-1.26, -0.52);
  s.lineTo(-1.38, -0.22);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.11,
    bevelEnabled: true,
    bevelThickness: 0.045,
    bevelSize: 0.035,
    bevelSegments: 2,
  });
  g.center();
  g.rotateX(Math.PI / 2);
  return g;
}

// 7. Leviathan Zeppelin: True Smooth Aerodynamic Ellipsoidal Dirigible Hull (LatheGeometry along +Z)
function makeZeppelinHullGeo(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const steps = 26;
  const halfLen = 1.44;
  const maxR = 0.56;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps; // 0 = stern (-Z), 1 = nose (+Z)
    const y = -halfLen + u * halfLen * 2;
    // Slight teardrop bias: fuller toward forward-midship, tapered smoothly to stern
    const t = Math.sin(u * Math.PI);
    const fullness = 0.86 + 0.24 * Math.sin(u * Math.PI * 0.82);
    const r = Math.max(0.002, maxR * Math.pow(t, 0.72) * fullness);
    pts.push(new THREE.Vector2(r, y));
  }
  const g = new THREE.LatheGeometry(pts, 28);
  g.rotateX(Math.PI / 2); // +Y -> +Z (nose points +Z)
  return g;
}

// 8. Leviathan Zeppelin: Streamlined Side Engine Nacelle Pod (LatheGeometry along +Z)
function makeNacelleGeo(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const steps = 14;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const y = -0.28 + u * 0.56;
    const r = Math.max(0.01, 0.115 * Math.pow(Math.sin(u * Math.PI), 0.58) * (0.85 + 0.22 * u));
    pts.push(new THREE.Vector2(r, y));
  }
  const g = new THREE.LatheGeometry(pts, 14);
  g.rotateX(Math.PI / 2);
  return g;
}

// 9. Leviathan Zeppelin: Sculpted Swept Stabilizer Fin
function makeZeppelinFinGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.34, 0);
  s.lineTo(0.36, 0);
  s.lineTo(0.06, 0.48);
  s.lineTo(-0.32, 0.42);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.04,
    bevelEnabled: true,
    bevelThickness: 0.014,
    bevelSize: 0.012,
    bevelSegments: 2,
  });
  g.center();
  g.rotateY(-Math.PI / 2);
  return g;
}

// 10. Viper Hydrofoil: Sharp Wave-Piercing Stealth Patrol Boat Hull (planform, +y -> +Z)
function makeGunboatHullGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 1.08); // razor-sharp stealth prow
  s.lineTo(0.28, 0.48);
  s.lineTo(0.34, -0.34);
  s.lineTo(0.29, -0.82); // angled transom stern
  s.lineTo(-0.29, -0.82);
  s.lineTo(-0.34, -0.34);
  s.lineTo(-0.28, 0.48);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.2,
    bevelEnabled: true,
    bevelThickness: 0.045,
    bevelSize: 0.03,
    bevelSegments: 2,
  });
  g.center();
  g.rotateX(Math.PI / 2);
  return g;
}

// 11. Aegis Destroyer: Zumwalt-Inspired Stealth Warship Hull (planform, +y -> +Z)
function makeDestroyerHullGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 1.56); // wave-piercing tumblehome bow
  s.lineTo(0.34, 0.84);
  s.lineTo(0.45, 0.14);
  s.lineTo(0.42, -0.78);
  s.lineTo(0.34, -1.12); // helicopter flight-deck transom
  s.lineTo(-0.34, -1.12);
  s.lineTo(-0.42, -0.78);
  s.lineTo(-0.45, 0.14);
  s.lineTo(-0.34, 0.84);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.28,
    bevelEnabled: true,
    bevelThickness: 0.055,
    bevelSize: 0.04,
    bevelSegments: 2,
  });
  g.center();
  g.rotateX(Math.PI / 2);
  return g;
}

// 12. Kraken Submarine: Smooth Hydrodynamic Torpedo-Shaped Hull (LatheGeometry along +Z)
function makeSubHullGeo(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const steps = 28;
  const sternZ = -1.32;
  const bowZ = 1.18;
  const span = bowZ - sternZ;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps; // 0 = stern, 1 = bow
    const y = sternZ + u * span;
    let r: number;
    if (u > 0.78) {
      // Smooth rounded acoustic sonar-dome nose
      const v = (u - 0.78) / 0.22;
      r = 0.29 * Math.sqrt(Math.max(0, 1 - v * v));
    } else if (u > 0.34) {
      // Cylindrical midbody with subtle hydrodynamic swell
      const mid = (u - 0.34) / 0.44;
      r = 0.29 + 0.015 * Math.sin(mid * Math.PI);
    } else {
      // Smooth tapered hydrodynamic stern cone into propeller shaft
      const v = u / 0.34;
      r = 0.035 + 0.255 * Math.pow(v, 0.74);
    }
    pts.push(new THREE.Vector2(Math.max(0.002, r), y));
  }
  const g = new THREE.LatheGeometry(pts, 24);
  g.rotateX(Math.PI / 2); // +Y -> +Z
  return g;
}

// 13. Kraken Submarine: Streamlined Airfoil Conning Tower / Sail (vertical Extrude)
function makeSubSailGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0.34); // smooth rounded leading edge
  s.quadraticCurveTo(0.14, 0.28, 0.13, 0.04);
  s.lineTo(0.09, -0.32); // tapered trailing edge
  s.lineTo(-0.09, -0.32);
  s.lineTo(-0.13, 0.04);
  s.quadraticCurveTo(-0.14, 0.28, 0, 0.34);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.42,
    bevelEnabled: true,
    bevelThickness: 0.03,
    bevelSize: 0.02,
    bevelSegments: 2,
  });
  g.center();
  g.rotateX(Math.PI / 2);
  return g;
}

// 14. Poseidon Dreadnought: Flared Modern Missile Battleship Hull (planform, +y -> +Z)
function makeDreadnoughtHullGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 1.94); // imposing flared armored bow
  s.lineTo(0.46, 1.24);
  s.lineTo(0.62, 0.42);
  s.lineTo(0.62, -0.88);
  s.lineTo(0.48, -1.38); // heavy armored transom
  s.lineTo(-0.48, -1.38);
  s.lineTo(-0.62, -0.88);
  s.lineTo(-0.62, 0.42);
  s.lineTo(-0.46, 1.24);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.38,
    bevelEnabled: true,
    bevelThickness: 0.065,
    bevelSize: 0.045,
    bevelSegments: 2,
  });
  g.center();
  g.rotateX(Math.PI / 2);
  return g;
}

// 15. Faceted Stealth Naval Turret Housing
function makeNavalTurretGeo(w: number, h: number, l: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-w * 0.46, -l * 0.5);
  s.lineTo(w * 0.46, -l * 0.5);
  s.lineTo(w * 0.32, l * 0.46);
  s.lineTo(-w * 0.32, l * 0.46);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: h,
    bevelEnabled: true,
    bevelThickness: 0.04,
    bevelSize: 0.035,
    bevelSegments: 2,
  });
  g.center();
  g.rotateX(Math.PI / 2);
  return g;
}

const geoHangarArch = makeHangarArchGeo();
const geoInterceptorPlanform = makeInterceptorPlanformGeo();
const geoJetTailFin = makeJetTailFinGeo();
const geoChopperHull = makeChopperHullGeo();
const geoFenestronFin = makeFenestronFinGeo();
const geoBomberWing = makeBomberWingGeo();
const geoZeppelinHull = makeZeppelinHullGeo();
const geoNacelle = makeNacelleGeo();
const geoZeppelinFin = makeZeppelinFinGeo();
const geoGunboatHull = makeGunboatHullGeo();
const geoDestroyerHull = makeDestroyerHullGeo();
const geoSubHull = makeSubHullGeo();
const geoSubSail = makeSubSailGeo();
const geoDreadnoughtHull = makeDreadnoughtHullGeo();
const geoGunboatTurret = makeNavalTurretGeo(0.36, 0.16, 0.44);
const geoDestroyerTurret = makeNavalTurretGeo(0.5, 0.22, 0.6);
const geoSubShroud = new THREE.TorusGeometry(0.17, 0.024, 8, 20);
const geoZepRingTable: { z: number; geo: THREE.TorusGeometry; isAccent: boolean }[] = (
  [
    [-0.78, 0.44, false],
    [-0.36, 0.56, true],
    [0.14, 0.59, false],
    [0.64, 0.53, true],
    [1.04, 0.39, false],
  ] as [number, number, boolean][]
).map(([z, rad, isAccent]) => ({
  z,
  geo: new THREE.TorusGeometry(rad, isAccent ? 0.042 : 0.026, 8, 28),
  isAccent,
}));

// ---------- Clean Sculpted Mesh Builders ----------

function mesh(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  cast = true,
  receive = true,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}

function rbox(
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
  r = 0.04,
  cast = true,
): THREE.Mesh {
  return mesh(getRoundedBoxGeo(w, h, d, r), mat, cast, cast);
}

function box(w: number, h: number, d: number, mat: THREE.Material, cast = true): THREE.Mesh {
  const m = mesh(geoBox, mat, cast, cast);
  m.scale.set(w, h, d);
  return m;
}

function cyl(d: number, h: number, mat: THREE.Material, taper = false, cast = true): THREE.Mesh {
  const m = mesh(taper ? geoCylTaper : geoCyl, mat, cast, cast);
  m.scale.set(d, h, d);
  return m;
}

function sph(d: number, mat: THREE.Material, cast = true): THREE.Mesh {
  const m = mesh(geoSph, mat, cast, cast);
  m.scale.setScalar(d);
  return m;
}

function cone(d: number, h: number, mat: THREE.Material, cast = true): THREE.Mesh {
  const m = mesh(geoCone, mat, cast, cast);
  m.scale.set(d, h, d);
  return m;
}

// ---------- Air & Sea Model Factory (10 Sculpted 2026 Models) ----------

export function buildAirSeaModel(
  kind: EntKind,
  colorHex: string,
  body: THREE.Group,
): BuiltModel | null {
  const accent = getAccentMat(colorHex);
  const accentDark = getAccentMat(dim(colorHex, 0.62));
  const accentBright = getAccentMat(lift(colorHex, 0.22));
  const hull = getChassisMat(TITANIUM, 0.36, 0.62);
  const hullLt = getChassisMat(TITANIUM_LT, 0.32, 0.68);
  const hullDk = getChassisMat(TITANIUM_DK, 0.42, 0.56);
  const stealth = getChassisMat(STEALTH, 0.38, 0.6);
  const gunm = getChassisMat(GUNM, 0.48, 0.72);
  const steel = getChassisMat(STEEL, 0.3, 0.75);

  let turret: THREE.Group | null = null;
  let spin: THREE.Group | undefined;
  let spin2: THREE.Group | undefined;
  let crane: THREE.Group | undefined;
  let recoil: THREE.Group | undefined;
  let smokePos: THREE.Vector3 | undefined;
  let altitude: number | undefined;
  let subMats: THREE.Material[] | undefined;
  const pulse: THREE.Mesh[] = [];
  let topY = 1.2;

  const add = <T extends THREE.Object3D>(
    obj: T,
    x = 0,
    y = 0,
    z = 0,
    parent: THREE.Object3D = body,
  ): T => {
    parent.add(obj);
    obj.position.set(x, y, z);
    return obj;
  };

  switch (kind) {
    // =========================================================================
    // 1. AIR COMMAND (3x2) — Beveled Concrete Runway, Stealth Hangar, Glass ATC
    // =========================================================================
    case "airfield": {
      // Beveled concrete foundation slab + dark recessed footing collar
      add(rbox(2.94, 0.2, 1.94, getConcreteMat(), 0.045), 0, 0.1, 0);
      add(box(2.98, 0.055, 1.98, gunm), 0, 0.028, 0);

      // Dark weathered asphalt runway tarmac across front (+Z)
      const tarmacMat = getChassisMat(ASPHALT, 0.88, 0.1);
      add(rbox(2.74, 0.055, 1.02, tarmacMat, 0.015), 0, 0.21, 0.36);

      // Illuminated landing chevrons & threshold markings
      const stripeMat = getChassisMat("#dce6ef", 0.55, 0.12);
      const chevronGlow = getGlowMat("#72e4ff", 1.15);
      const amberBar = getChassisMat(CRANE_YEL, 0.5, 0.2);

      // Threshold piano keys at both runway ends
      for (const tx of [-1.22, 1.22]) {
        for (const tz of [0.06, 0.24, 0.42, 0.6]) {
          add(box(0.16, 0.014, 0.09, amberBar, false), tx, 0.242, tz);
        }
      }
      // Illuminated angled landing chevrons along runway centerline
      for (const cx of [-0.66, 0, 0.66]) {
        const chA = box(0.24, 0.016, 0.055, cx === 0 ? chevronGlow : stripeMat, false);
        chA.rotation.y = 0.55;
        add(chA, cx, 0.244, 0.31);
        const chB = box(0.24, 0.016, 0.055, cx === 0 ? chevronGlow : stripeMat, false);
        chB.rotation.y = -0.55;
        add(chB, cx, 0.244, 0.41);
        if (cx === 0) {
          pulse.push(chA, chB);
        }
      }

      // Pulsing runway approach & border LED beacons
      const greenGlow = getGlowMat(EMERALD, 1.35);
      const amberGlow = getGlowMat(ORE_GLOW, 1.35);
      for (const [lx, lz, isApproach] of [
        [-1.32, 0.84, true],
        [-0.45, 0.84, false],
        [0.45, 0.84, false],
        [1.32, 0.84, true],
        [-1.32, -0.12, true],
        [1.32, -0.12, true],
      ] as [number, number, boolean][]) {
        add(cyl(0.08, 0.08, gunm), lx, 0.24, lz);
        const lt = sph(0.082, isApproach ? greenGlow : amberGlow, false);
        add(lt, lx, 0.295, lz);
        pulse.push(lt);
      }

      // Arched Reinforced Stealth Aircraft Hangar (back-left: -X, -Z)
      const hangar = mesh(geoHangarArch, hull);
      add(hangar, -0.56, 0.52, -0.52);
      // Heavy structural steel arch ribs framing the hangar
      for (const rx of [-1.14, -0.56, 0.02]) {
        const rib = mesh(geoHangarArch, hullDk);
        rib.scale.set(0.085, 1.05, 1.05);
        add(rib, rx, 0.52, -0.52);
      }
      // Satin faction hangar fascia header + armored recessed aircraft bay mouth
      add(rbox(1.52, 0.11, 0.12, accent, 0.02), -0.56, 0.68, -0.11);
      add(box(1.16, 0.44, 0.06, gunm), -0.56, 0.41, -0.12);
      // Glowing interior aircraft bay ceiling light strip
      add(box(1.06, 0.045, 0.04, getGlowMat("#82e8ff", 1.25), false), -0.56, 0.6, -0.1);
      // Roof ventilation pods
      add(rbox(0.42, 0.1, 0.22, steel, 0.02), -0.78, 0.87, -0.56);

      // Glass-Wrapped ATC Control Tower (back-right: +X, -Z)
      add(rbox(0.58, 0.96, 0.54, hullDk, 0.05), 0.96, 0.68, -0.52);
      add(rbox(0.64, 0.12, 0.6, accent, 0.025), 0.96, 1.14, -0.52);
      // External steel utility/stair spine
      add(rbox(0.14, 0.92, 0.22, steel, 0.02), 1.26, 0.66, -0.52);
      // Flared glass-wrapped panoramic ATC observation cab
      add(rbox(0.8, 0.32, 0.7, getGlassMat("#78d6ff"), 0.05), 0.96, 1.38, -0.52);
      // Structural window corner mullions
      for (const [mx, mz] of [
        [0.58, -0.2],
        [1.34, -0.2],
        [0.58, -0.84],
        [1.34, -0.84],
      ]) {
        add(box(0.05, 0.34, 0.05, hullDk), mx, 1.38, mz);
      }
      // Overhanging stealth ATC roof cap
      add(rbox(0.92, 0.1, 0.82, hull, 0.03), 0.96, 1.58, -0.52);
      add(rbox(0.76, 0.06, 0.66, accentDark, 0.02), 0.96, 1.65, -0.52);

      // Rotating Surveillance Radar Assembly (`spin`)
      add(cyl(0.08, 0.4, steel), 0.96, 1.86, -0.52);
      spin = new THREE.Group();
      spin.position.set(0.96, 2.08, -0.52);
      body.add(spin);
      const rBoom = rbox(0.84, 0.12, 0.14, hullLt, 0.03);
      spin.add(rBoom);
      const rAccent = box(0.76, 0.04, 0.16, accentBright);
      spin.add(rAccent);
      const rDish = cyl(0.46, 0.06, steel, true);
      rDish.rotation.x = 0.82;
      rDish.position.set(0, 0.1, 0.1);
      spin.add(rDish);

      // Blinking crimson aviation warning beacon
      const obLight = sph(0.09, getGlowMat(CRIMSON, 1.45), false);
      add(obLight, 1.34, 1.68, -0.84);
      pulse.push(obLight);

      smokePos = new THREE.Vector3(-0.56, 1.12, -0.52);
      topY = 2.46;
      break;
    }

    // =========================================================================
    // 2. NAVAL SHIPYARD (3x3) — Floating Pontoons, Bridge, Twin Overhead Cranes
    // =========================================================================
    case "shipyard": {
      const yellowMat = getChassisMat(CRANE_YEL, 0.42, 0.45);
      const yellowDk = getChassisMat(CRANE_DK, 0.48, 0.42);

      // Left & right heavy floating beveled steel drydock pontoons (open water slipway in center!)
      for (const sx of [-1.06, 1.06]) {
        add(rbox(0.7, 0.36, 2.78, hullDk, 0.05), sx, 0.24, 0);
        add(rbox(0.62, 0.08, 2.66, hullLt, 0.025), sx, 0.44, 0);
        // Waterline rubber bumper fender rail
        add(box(0.08, 0.14, 2.62, gunm), sx + (sx > 0 ? -0.35 : 0.35), 0.18, 0);
        // Satin faction inner slipway edge trim
        add(rbox(0.14, 0.06, 2.52, accent, 0.015), sx + (sx > 0 ? -0.22 : 0.22), 0.49, 0);
        // Industrial crane rail tracks along pontoon tops
        add(box(0.12, 0.08, 2.44, yellowDk), sx, 0.51, 0.06);
        // Heavy yellow mooring bollards along slipway edge
        for (const bz of [-0.66, 0.1, 0.86]) {
          add(cyl(0.1, 0.15, yellowMat), sx + (sx > 0 ? -0.25 : 0.25), 0.54, bz);
        }
      }

      // Rear cross-pier bulkhead (-Z) + Naval Operations Command Bridge
      add(rbox(2.82, 0.42, 0.68, hull, 0.05), 0, 0.27, -1.06);
      add(rbox(1.32, 0.54, 0.54, hullDk, 0.05), -0.18, 0.72, -1.08);
      add(rbox(1.36, 0.1, 0.58, accent, 0.025), -0.18, 0.98, -1.08);
      // Glossy angled naval command bridge glass
      add(rbox(1.02, 0.2, 0.1, getGlassMat("#78d4ff"), 0.02), -0.18, 0.78, -0.8);

      // Naval sensor mast & rotating marine radar (`spin`)
      add(cyl(0.08, 1.02, steel), 0.96, 0.96, -1.04);
      spin = new THREE.Group();
      spin.position.set(0.96, 1.52, -1.04);
      body.add(spin);
      spin.add(rbox(0.82, 0.08, 0.12, hullLt, 0.025));
      spin.add(box(0.7, 0.04, 0.14, accentBright));

      // Twin Tall Yellow Overhead Shipyard Gantry Cranes (`crane` slides along slipway Z)
      crane = new THREE.Group();
      crane.position.set(0, 0.52, 0.1);
      body.add(crane);
      for (const sx of [-1.06, 1.06]) {
        // Sloped A-frame heavy steel truss legs
        const legA = rbox(0.12, 1.42, 0.12, yellowMat, 0.02);
        legA.position.set(sx, 0.69, -0.24);
        legA.rotation.x = 0.17;
        crane.add(legA);
        const legB = rbox(0.12, 1.42, 0.12, yellowMat, 0.02);
        legB.position.set(sx, 0.69, 0.24);
        legB.rotation.x = -0.17;
        crane.add(legB);
        // Horizontal cross-brace + bogie truck
        const brace = box(0.1, 0.08, 0.44, yellowDk);
        brace.position.set(sx, 0.64, 0);
        crane.add(brace);
        const bogie = rbox(0.22, 0.12, 0.62, gunm, 0.025);
        bogie.position.set(sx, 0.04, 0);
        crane.add(bogie);
      }
      // Twin overhead bridge box-girders
      for (const gz of [-0.14, 0.14]) {
        const girder = rbox(2.5, 0.16, 0.12, yellowMat, 0.025);
        girder.position.set(0, 1.38, gz);
        crane.add(girder);
      }
      // Central winch trolley + cables + heavy spreader hook
      const trolley = rbox(0.5, 0.22, 0.44, accent, 0.04);
      trolley.position.set(0, 1.26, 0);
      crane.add(trolley);
      for (const cx of [-0.12, 0.12]) {
        const cable = cyl(0.028, 0.68, steel);
        cable.position.set(cx, 0.84, 0);
        crane.add(cable);
      }
      const hook = rbox(0.32, 0.1, 0.16, gunm, 0.025);
      hook.position.set(0, 0.48, 0);
      crane.add(hook);

      // Pulsing harbor entry navigation buoys at slipway mouth (+Z)
      const gGlow = getGlowMat(EMERALD, 1.35);
      const aGlow = getGlowMat(ORE_GLOW, 1.35);
      for (const [bx, bz, isGreen] of [
        [-1.12, 1.38, true],
        [1.12, 1.38, true],
        [-0.76, 1.28, false],
        [0.76, 1.28, false],
      ] as [number, number, boolean][]) {
        add(cyl(0.16, 0.22, hullDk, true), bx, 0.18, bz);
        const buoy = sph(0.105, isGreen ? gGlow : aGlow, false);
        add(buoy, bx, 0.35, bz);
        pulse.push(buoy);
      }

      smokePos = new THREE.Vector3(-0.6, 1.15, -1.08);
      topY = 2.24;
      break;
    }

    // =========================================================================
    // 3. VALKYRIE JET — Sculpted Stealth Delta Fighter + Glass Canopy + Burners
    // =========================================================================
    case "interceptor": {
      altitude = 3.25;
      body.position.y = altitude;

      // Sculpted faceted stealth fuselage + swept delta wings (ExtrudeGeometry)
      add(mesh(geoInterceptorPlanform, hull), 0, 0, 0);

      // Sleek raised dorsal avionics spine in satin faction accent
      add(rbox(0.24, 0.13, 1.02, accent, 0.045), 0, 0.08, -0.06);
      // Sculpted needle radar nose cone
      const nose = cone(0.2, 0.5, hullLt);
      nose.rotation.x = Math.PI / 2;
      add(nose, 0, 0.01, 1.08);

      // Glossy tinted fighter bubble canopy
      const canopy = sph(0.24, getGlassMat("#4db8f0"));
      canopy.scale.multiply(new THREE.Vector3(0.76, 0.62, 2.05));
      add(canopy, 0, 0.13, 0.34);

      for (const sx of [-1, 1]) {
        // Wing accent chevron stripes + wingtip rails
        const wStripe = box(0.64, 0.095, 0.14, accent);
        wStripe.rotation.y = sx * -0.62;
        add(wStripe, sx * 0.52, 0.01, -0.14);
        add(rbox(0.045, 0.05, 0.36, steel, 0.01), sx * 0.95, 0, -0.44);

        // Side DSI stealth air intakes
        add(rbox(0.14, 0.12, 0.46, hullDk, 0.03), sx * 0.21, -0.02, 0.1);

        // Outward-canted twin stealth vertical tail stabilizers (ExtrudeGeometry)
        const fin = mesh(geoJetTailFin, hullLt);
        fin.rotation.z = sx * -0.36;
        add(fin, sx * 0.25, 0.2, -0.56);
        const finCap = box(0.036, 0.09, 0.22, accent);
        finCap.rotation.z = sx * -0.36;
        add(finCap, sx * 0.31, 0.34, -0.6);

        // Underwing AAM missile rails + missiles
        const msl = cyl(0.05, 0.56, getChassisMat("#d4dee8", 0.35, 0.45));
        msl.rotation.x = Math.PI / 2;
        add(msl, sx * 0.5, -0.09, -0.06);
        const mTip = cone(0.05, 0.12, getGlowMat(ORE_GLOW, 1.15), false);
        mTip.rotation.x = Math.PI / 2;
        add(mTip, sx * 0.5, -0.09, 0.27);

        // Twin thrust-vectoring jet exhaust nozzles + pulsing cyan-orange afterburners
        const noz = cyl(0.14, 0.32, gunm, true);
        noz.rotation.x = Math.PI / 2;
        add(noz, sx * 0.15, -0.01, -0.74);

        const outerFlame = cone(0.135, 0.48, getGlowMat(AFTERBURN, 1.55), false);
        outerFlame.rotation.x = -Math.PI / 2;
        add(outerFlame, sx * 0.15, -0.01, -1.12);
        pulse.push(outerFlame);

        const innerCore = cone(0.08, 0.3, getGlowMat(CORE_GLOW, 1.75), false);
        innerCore.rotation.x = -Math.PI / 2;
        add(innerCore, sx * 0.15, -0.01, -1.03);
        pulse.push(innerCore);
      }

      smokePos = new THREE.Vector3(0, altitude, -0.8);
      topY = altitude + 0.62;
      break;
    }

    // =========================================================================
    // 4. HORNET GUNSHIP — Faceted Comanche/Apache + 4-Blade Rotor + Fenestron
    // =========================================================================
    case "chopper": {
      altitude = 2.88;
      body.position.y = altitude;

      // Faceted armored stealth fuselage (ExtrudeGeometry)
      add(mesh(geoChopperHull, hull), 0, 0, -0.18);
      // Faction armored side cheek panels & engine spine
      add(rbox(0.46, 0.14, 0.86, accent, 0.03), 0, 0.06, 0.04);
      add(rbox(0.36, 0.16, 0.62, hullDk, 0.04), 0, 0.24, -0.14);

      // Stepped tandem glossy glass gunship canopy
      const cFront = rbox(0.32, 0.16, 0.36, getGlassMat("#52b8f0"), 0.035, false);
      cFront.rotation.x = 0.22;
      add(cFront, 0, 0.14, 0.56);
      const cRear = rbox(0.36, 0.18, 0.34, getGlassMat("#52b8f0"), 0.035, false);
      cRear.rotation.x = 0.08;
      add(cRear, 0, 0.22, 0.26);
      // Canopy structural frame bar
      add(box(0.38, 0.04, 0.045, gunm), 0, 0.22, 0.42);

      // Under-nose FLIR targeting turret + chin 30mm rotary autocannon
      const flir = sph(0.14, gunm);
      add(flir, 0, -0.14, 0.78);
      const flirLens = sph(0.06, getGlowMat(CORE_GLOW, 1.3), false);
      add(flirLens, 0, -0.14, 0.85);
      const chinGun = cyl(0.055, 0.52, gunm);
      chinGun.rotation.x = Math.PI / 2 + 0.15;
      add(chinGun, 0, -0.23, 0.84);

      // Stub weapon wings + twin rocket pods + AGM missiles + skids
      for (const sx of [-1, 1]) {
        const stub = rbox(0.5, 0.065, 0.28, hullLt, 0.02);
        stub.rotation.z = sx * -0.14;
        add(stub, sx * 0.44, -0.01, 0.08);
        add(box(0.42, 0.072, 0.08, accent), sx * 0.44, 0, 0.15);

        // Twin shrouded engine nacelles
        const nac = cyl(0.16, 0.54, hullDk);
        nac.rotation.x = Math.PI / 2;
        add(nac, sx * 0.24, 0.2, -0.18);

        // Multi-tube rocket pod
        const pod = cyl(0.17, 0.44, gunm);
        pod.rotation.x = Math.PI / 2;
        add(pod, sx * 0.58, -0.09, 0.12);
        const podFace = cyl(0.13, 0.04, getGlowMat(ORE_GLOW, 1.3), false, false);
        podFace.rotation.x = Math.PI / 2;
        add(podFace, sx * 0.58, -0.09, 0.35);

        // Outboard AGM missile
        const agm = cyl(0.045, 0.44, steel);
        agm.rotation.x = Math.PI / 2;
        add(agm, sx * 0.72, -0.08, 0.08);

        // Armored landing skids
        const skid = cyl(0.04, 0.98, steel);
        skid.rotation.x = Math.PI / 2;
        add(skid, sx * 0.29, -0.34, 0.08);
        add(box(0.038, 0.2, 0.04, gunm), sx * 0.25, -0.24, 0.3);
        add(box(0.038, 0.2, 0.04, gunm), sx * 0.25, -0.24, -0.14);
      }

      // Enclosed Fenestron stealth tail fin (ExtrudeGeometry with circular duct hole)
      const tailFin = mesh(geoFenestronFin, hull);
      add(tailFin, 0, 0.16, -1.36);
      add(box(0.068, 0.09, 0.24, accent), 0, 0.41, -1.42);
      // Horizontal tail stabilizer plane
      add(rbox(0.56, 0.04, 0.16, hullLt, 0.01), 0, 0.04, -1.2);

      // Enclosed spinning Fenestron tail rotor (`spin2` rotates around X, centered inside duct)
      spin2 = new THREE.Group();
      spin2.position.set(0, 0.13, -1.37);
      body.add(spin2);
      const tHub = sph(0.06, steel);
      spin2.add(tHub);
      for (let i = 0; i < 4; i++) {
        const tb = box(0.022, 0.21, 0.036, steel);
        tb.rotation.x = (i * Math.PI) / 4;
        spin2.add(tb);
      }

      // 4-Blade Composite Main Rotor + Translucent Motion-Blur Disc (`spin` rotates around Y)
      add(cyl(0.11, 0.24, gunm), 0, 0.38, 0.02);
      spin = new THREE.Group();
      spin.position.set(0, 0.5, 0.02);
      body.add(spin);
      spin.add(cyl(0.2, 0.08, steel, true));
      for (let i = 0; i < 4; i++) {
        const ang = (i * Math.PI) / 2;
        const blade = box(0.085, 0.022, 1.06, gunm);
        blade.position.set(Math.sin(ang) * 0.54, 0, Math.cos(ang) * 0.54);
        blade.rotation.y = ang;
        spin.add(blade);
        const tip = box(0.09, 0.024, 0.14, getChassisMat(CRANE_YEL, 0.4, 0.3));
        tip.position.set(Math.sin(ang) * 1.02, 0, Math.cos(ang) * 1.02);
        tip.rotation.y = ang;
        spin.add(tip);
      }
      const blurDisc = new THREE.Mesh(geoRotorDisc, rotorDiscMat);
      blurDisc.scale.setScalar(1.1);
      blurDisc.position.y = -0.012;
      spin.add(blurDisc);
      const blurRim = new THREE.Mesh(rotorRingGeo, rotorRingMat);
      blurRim.scale.setScalar(1.1);
      blurRim.position.y = -0.01;
      spin.add(blurRim);

      smokePos = new THREE.Vector3(0, altitude + 0.18, -0.38);
      topY = altitude + 0.72;
      break;
    }

    // =========================================================================
    // 5. TEMPEST BOMBER — Stealth B-2 Flying-Wing Strategic Heavy Bomber
    // =========================================================================
    case "bomber": {
      altitude = 3.4;
      body.position.y = altitude;

      // Broad sculpted stealth flying-wing delta hull (ExtrudeGeometry with sawtooth trailing edge)
      add(mesh(geoBomberWing, stealth), 0, 0, 0);

      // Sculpted blended central fuselage dorsal spine & subtle titanium panels
      add(rbox(0.54, 0.16, 1.24, hullDk, 0.06), 0, 0.08, 0.04);
      add(rbox(0.32, 0.08, 1.04, accent, 0.03), 0, 0.16, 0.02);

      // Glossy recessed stealth flight-deck cockpit visor
      const visor = rbox(0.4, 0.11, 0.28, getGlassMat("#58c0ff"), 0.03, false);
      visor.rotation.x = 0.28;
      add(visor, 0, 0.13, 0.56);

      // Ventral armored bomb-bay fairing & glowing precision targeting pod
      add(rbox(0.44, 0.12, 0.86, gunm, 0.03), 0, -0.1, -0.04);
      const tPod = sph(0.12, getGlowMat(ORE_GLOW, 1.4), false);
      add(tPod, 0, -0.14, 0.54);
      pulse.push(tPod);

      for (const sx of [-1, 1]) {
        // Sharp geometric wing faction accent chevron stripe
        const wStripe = box(0.92, 0.14, 0.14, accent);
        wStripe.rotation.y = sx * -0.7;
        add(wStripe, sx * 0.72, 0.01, -0.04);

        // Sunken dorsal stealth jet intakes flanking the center spine
        add(rbox(0.24, 0.12, 0.62, hull, 0.035), sx * 0.36, 0.08, 0.02);
        add(box(0.18, 0.07, 0.06, gunm), sx * 0.36, 0.09, 0.33);

        // Recessed twin stealth exhaust troughs + glowing rear afterburners (`pulse`)
        add(rbox(0.22, 0.09, 0.24, gunm, 0.02), sx * 0.34, 0.04, -0.4);
        const exh = cone(0.15, 0.4, getGlowMat(AFTERBURN, 1.5), false);
        exh.rotation.x = -Math.PI / 2;
        add(exh, sx * 0.34, 0.03, -0.68);
        pulse.push(exh);

        const exhCore = cone(0.085, 0.24, getGlowMat(CORE_GLOW, 1.7), false);
        exhCore.rotation.x = -Math.PI / 2;
        add(exhCore, sx * 0.34, 0.03, -0.6);
        pulse.push(exhCore);

        // Subtle wingtip nav strobes
        const nav = sph(0.06, getGlowMat(sx < 0 ? CRIMSON : EMERALD, 1.35), false);
        add(nav, sx * 1.32, 0.01, -0.34);
        pulse.push(nav);
      }

      smokePos = new THREE.Vector3(0, altitude, -0.78);
      topY = altitude + 0.66;
      break;
    }

    // =========================================================================
    // 6. LEVIATHAN AIRSHIP — Smooth LatheGeometry War Dirigible + Twin Props
    // =========================================================================
    case "zeppelin": {
      altitude = 3.65;
      body.position.y = altitude;

      // True smooth LatheGeometry aerodynamic ellipsoidal zeppelin hull
      const zHull = mesh(geoZeppelinHull, hull);
      zHull.scale.set(0.96, 0.9, 1.0);
      add(zHull, 0, 0.14, 0);

      // Armored circumferential steel ribs & bold satin faction war-stripes
      for (const { z: rz, geo, isAccent } of geoZepRingTable) {
        const ring = mesh(geo, isAccent ? accent : hullDk);
        ring.scale.set(0.97, 0.91, isAccent ? 2.4 : 1.0);
        add(ring, 0, 0.14, rz);
      }

      // Dorsal armored spine keel
      add(rbox(0.18, 0.1, 1.92, accentDark, 0.03), 0, 0.65, -0.02);

      // Armored prow cap & glowing prow searchlight
      const prow = sph(0.46, accent);
      prow.scale.multiply(new THREE.Vector3(0.88, 0.84, 0.72));
      add(prow, 0, 0.14, 1.3);
      const lamp = sph(0.17, getGlowMat(ORE_GLOW, 1.55), false);
      add(lamp, 0, 0.14, 1.5);
      pulse.push(lamp);

      // 4 Sculpted Cruciform Aerodynamic Tail Fins (ExtrudeGeometry)
      const finTop = mesh(geoZeppelinFin, accent);
      add(finTop, 0, 0.64, -1.04);
      const finBot = mesh(geoZeppelinFin, hullDk);
      finBot.rotation.z = Math.PI;
      add(finBot, 0, -0.34, -1.04);
      const finL = mesh(geoZeppelinFin, accent);
      finL.rotation.z = Math.PI / 2;
      add(finL, -0.6, 0.14, -1.04);
      const finR = mesh(geoZeppelinFin, accent);
      finR.rotation.z = -Math.PI / 2;
      add(finR, 0.6, 0.14, -1.04);

      // Heavily Armored Underslung Command & Bomb Gondola + Glowing Viewports
      add(rbox(0.48, 0.34, 1.24, hullDk, 0.06), 0, -0.58, 0.08);
      add(rbox(0.5, 0.08, 1.18, accent, 0.025), 0, -0.46, 0.08);
      // Glossy bridge windshield
      add(rbox(0.42, 0.15, 0.08, getGlassMat("#78d4ff"), 0.02), 0, -0.54, 0.7);
      // Side gondola porthole glow strips
      for (const sx of [-1, 1]) {
        add(box(0.03, 0.06, 0.56, getGlowMat(ORE_GLOW, 1.15), false), sx * 0.245, -0.56, 0.12);
      }
      // Ventral heavy bomb-bay doors
      add(rbox(0.34, 0.12, 0.72, gunm, 0.03), 0, -0.78, -0.02);
      // Steel suspension bracing struts
      for (const [sx, sz] of [
        [-0.2, 0.38],
        [0.2, 0.38],
        [-0.2, -0.26],
        [0.2, -0.26],
      ]) {
        const strut = cyl(0.048, 0.36, steel);
        strut.rotation.z = sx > 0 ? -0.28 : 0.28;
        add(strut, sx, -0.34, sz);
      }

      // Twin Side Outrigger Engine Nacelles (LatheGeometry) + Spinning Propellers (`spin`, `spin2`)
      const brassMat = getChassisMat(BRASS, 0.32, 0.78);
      for (const sx of [-1, 1]) {
        add(rbox(0.48, 0.08, 0.18, steel, 0.02), sx * 0.56, -0.16, -0.12);
        add(mesh(geoNacelle, gunm), sx * 0.78, -0.16, -0.14);
        add(cyl(0.18, 0.08, accent), sx * 0.78, -0.16, -0.02);

        const prop = new THREE.Group();
        prop.position.set(sx * 0.78, -0.16, -0.45);
        body.add(prop);
        prop.add(sph(0.095, steel));
        for (let i = 0; i < 3; i++) {
          const b = box(0.055, 0.38, 0.022, brassMat);
          b.rotation.z = (i * Math.PI * 2) / 3;
          prop.add(b);
        }
        if (sx < 0) spin = prop;
        else spin2 = prop;
      }

      smokePos = new THREE.Vector3(0, altitude - 0.15, -1.18);
      topY = altitude + 0.98;
      break;
    }

    // =========================================================================
    // 7. VIPER HYDROFOIL — Sharp Stealth Patrol Boat + Hydrofoils + Autocannon
    // =========================================================================
    case "gunboat": {
      body.position.y = 0.08;

      // Sleek pointed wave-piercing stealth hull (ExtrudeGeometry)
      add(mesh(geoGunboatHull, hull), 0, 0.15, 0.04);
      // Satin faction deck accent & bow stripe
      add(rbox(0.48, 0.06, 1.12, accent, 0.02), 0, 0.28, -0.08);
      add(box(0.14, 0.05, 0.62, accentBright), 0, 0.28, 0.56);

      // Sloped stealth bridge cabin + wrap-around glossy glass windshield
      const bridge = rbox(0.46, 0.26, 0.54, hullDk, 0.05);
      add(bridge, 0, 0.44, -0.22);
      const wind = rbox(0.44, 0.13, 0.14, getGlassMat("#6ecaff"), 0.025, false);
      wind.rotation.x = -0.35;
      add(wind, 0, 0.48, 0.04);
      // Compact mast & whip antenna
      add(cyl(0.026, 0.46, steel), 0.16, 0.76, -0.34);
      add(box(0.24, 0.04, 0.05, hullLt), 0, 0.68, -0.32);

      // Hydrofoil side struts & swept foil blades + twin waterjet thrusters
      for (const sx of [-1, 1]) {
        const strut = box(0.05, 0.24, 0.18, steel);
        strut.rotation.z = sx * 0.36;
        add(strut, sx * 0.42, 0.06, 0.16);
        const foil = rbox(0.44, 0.04, 0.2, hullLt, 0.015);
        foil.rotation.y = sx * -0.22;
        add(foil, sx * 0.58, 0.02, 0.14);
        const jet = cyl(0.11, 0.2, gunm);
        jet.rotation.x = Math.PI / 2;
        add(jet, sx * 0.17, 0.13, -0.82);
      }

      // Forward rapid-fire rotating deck autocannon (`turret`, `recoil`)
      turret = new THREE.Group();
      turret.position.set(0, 0.38, 0.46);
      body.add(turret);
      turret.add(mesh(geoGunboatTurret, accent));

      recoil = new THREE.Group();
      recoil.position.set(0, 0.02, 0.18);
      turret.add(recoil);
      const barrel = cyl(0.055, 0.58, gunm);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0, 0.28);
      recoil.add(barrel);
      const brake = cyl(0.082, 0.1, steel);
      brake.rotation.x = Math.PI / 2;
      brake.position.set(0, 0, 0.56);
      recoil.add(brake);

      smokePos = new THREE.Vector3(0, 0.56, -0.62);
      topY = 1.06;
      break;
    }

    // =========================================================================
    // 8. AEGIS DESTROYER — Zumwalt Stealth Warship + Aegis Bridge + Twin Turret
    // =========================================================================
    case "destroyer": {
      body.position.y = 0.08;

      // Zumwalt-inspired stealth-faceted warship hull (ExtrudeGeometry)
      add(mesh(geoDestroyerHull, hull), 0, 0.18, 0.12);
      // Faction armor belt & main deck trim
      add(rbox(0.76, 0.07, 1.72, hullLt, 0.025), 0, 0.36, -0.02);
      add(rbox(0.88, 0.07, 1.48, accent, 0.02), 0, 0.26, 0.02);
      // Stern helideck landing pad
      add(box(0.6, 0.025, 0.54, getChassisMat("#262d34", 0.85, 0.12)), 0, 0.405, -0.74);
      add(box(0.36, 0.012, 0.04, getChassisMat("#dce6ef", 0.6, 0.1), false), 0, 0.422, -0.74);

      // Tiered angular Aegis radar deckhouse superstructure
      add(rbox(0.66, 0.38, 0.82, hullDk, 0.05), 0, 0.57, 0.04);
      add(rbox(0.54, 0.28, 0.52, hull, 0.045), 0, 0.88, 0.12);
      add(rbox(0.56, 0.07, 0.54, accent, 0.02), 0, 0.78, 0.12);
      // Glossy wrap-around Aegis bridge glass
      add(rbox(0.48, 0.11, 0.12, getGlassMat("#6ed2ff"), 0.02, false), 0, 0.91, 0.36);
      // Side octagonal Aegis phased-array SPY radar panels
      const radarPanelMat = getChassisMat("#6a7378", 0.42, 0.55);
      for (const sx of [-1, 1]) {
        add(box(0.03, 0.16, 0.2, radarPanelMat), sx * 0.28, 0.88, 0.18);
      }

      // Angled stealth exhaust funnel
      add(rbox(0.32, 0.34, 0.3, gunm, 0.04), 0, 0.66, -0.46);

      // Integrated stealth mast & spinning marine radar (`spin`)
      add(cyl(0.065, 0.46, steel, true), 0, 1.22, 0.12);
      spin = new THREE.Group();
      spin.position.set(0, 1.48, 0.12);
      body.add(spin);
      spin.add(rbox(0.62, 0.075, 0.11, hullLt, 0.02));
      spin.add(box(0.54, 0.035, 0.13, accentBright));

      // Forward Vertical-Launch System (VLS) missile deck cells
      add(rbox(0.48, 0.07, 0.36, gunm, 0.015), 0, 0.42, 0.62);
      for (const vx of [-0.14, 0, 0.14]) {
        add(box(0.09, 0.02, 0.26, steel), vx, 0.46, 0.62);
      }
      add(box(0.42, 0.02, 0.04, getGlowMat(CORE_GLOW, 1.2), false), 0, 0.465, 0.46);

      // Forward rotating stealth twin-barrel naval cannon turret (`turret`, `recoil`)
      turret = new THREE.Group();
      turret.position.set(0, 0.45, 0.96);
      body.add(turret);
      turret.add(mesh(geoDestroyerTurret, accent));

      recoil = new THREE.Group();
      recoil.position.set(0, 0.04, 0.24);
      turret.add(recoil);
      for (const bx of [-0.1, 0.1]) {
        const brl = cyl(0.062, 0.78, gunm);
        brl.rotation.x = Math.PI / 2 - 0.08;
        brl.position.set(bx, 0.03, 0.38);
        recoil.add(brl);
      }

      smokePos = new THREE.Vector3(0, 0.94, -0.46);
      topY = 1.62;
      break;
    }

    // =========================================================================
    // 9. KRAKEN SUBMARINE — Smooth LatheGeometry Torpedo Hull + Per-Instance subMats
    // =========================================================================
    case "sub": {
      body.position.y = 0.06;

      // Smooth hydrodynamic LatheGeometry torpedo submarine hull (NO blocky boxes!)
      const subHull = mesh(geoSubHull, stealth);
      subHull.scale.set(1.08, 0.88, 1.0);
      add(subHull, 0, 0.15, 0);

      // Subtle dorsal sonar spine & faction accent stripe
      add(rbox(0.16, 0.06, 1.38, accent, 0.025), 0, 0.39, 0.04);

      // Streamlined airfoil conning tower / sail (ExtrudeGeometry)
      add(mesh(geoSubSail, hullDk), 0, 0.56, 0.12);
      add(rbox(0.24, 0.08, 0.52, accent, 0.03), 0, 0.67, 0.12);

      // Sail-mounted diving planes + bow & stern hydroplanes + stern rudder fins
      add(rbox(0.7, 0.038, 0.16, hullLt, 0.012), 0, 0.57, 0.18);
      add(rbox(0.84, 0.042, 0.2, hull, 0.015), 0, 0.16, 0.54);
      add(rbox(0.68, 0.04, 0.18, hull, 0.015), 0, 0.15, -0.96);
      add(rbox(0.048, 0.42, 0.24, hullDk, 0.015), 0, 0.22, -0.98);

      // Optical periscope mast + glowing cyan optronic lens + snorkel mast
      add(cyl(0.036, 0.4, steel), 0, 0.94, 0.18);
      add(cyl(0.026, 0.28, gunm), 0, 0.88, 0.02);
      const lens = sph(0.078, getGlowMat(CORE_GLOW, 1.45), false);
      add(lens, 0, 1.14, 0.2);
      pulse.push(lens);

      // Rear pump-jet shroud ring + spinning 5-blade skewed brass propeller (`spin` around Z)
      add(mesh(geoSubShroud, hullDk), 0, 0.15, -1.32);

      spin = new THREE.Group();
      spin.position.set(0, 0.15, -1.33);
      body.add(spin);
      spin.add(sph(0.075, steel));
      const propMat = getChassisMat(BRASS, 0.3, 0.8);
      for (let i = 0; i < 5; i++) {
        const pb = box(0.048, 0.28, 0.02, propMat);
        pb.rotation.z = (i * Math.PI * 2) / 5;
        spin.add(pb);
      }

      // Clone every material per submarine instance for smooth submerged stealth translucency!
      const mats: THREE.Material[] = [];
      body.traverse((o) => {
        if (o instanceof THREE.Mesh && !Array.isArray(o.material)) {
          const cloned = (o.material as THREE.Material).clone();
          o.material = cloned;
          mats.push(cloned);
        }
      });
      subMats = mats;

      smokePos = new THREE.Vector3(0, 0.72, -0.4);
      topY = 1.22;
      break;
    }

    // =========================================================================
    // 10. POSEIDON DREADNOUGHT — Colossal Missile Battleship + Twin Cruise Silos
    // =========================================================================
    case "dreadnought": {
      body.position.y = 0.08;

      // Colossal flared armored battleship hull (ExtrudeGeometry)
      add(mesh(geoDreadnoughtHull, hull), 0, 0.22, 0.06);
      // Heavy deck armor & bold faction waterline belt
      add(rbox(1.08, 0.09, 2.38, hullLt, 0.03), 0, 0.45, -0.04);
      add(rbox(1.26, 0.11, 2.08, accent, 0.025), 0, 0.33, 0);

      // Broadside armor sponsons & twin secondary deck guns
      for (const sx of [-1, 1]) {
        add(rbox(0.18, 0.22, 1.38, hullDk, 0.03), sx * 0.64, 0.3, 0.04);
        add(rbox(0.24, 0.16, 0.36, accent, 0.03), sx * 0.52, 0.56, 0.92);
        const secBrl = cyl(0.055, 0.54, gunm);
        secBrl.rotation.x = Math.PI / 2;
        add(secBrl, sx * 0.52, 0.58, 1.28);
      }

      // Towering multi-tier armored command citadel superstructure (aft-center)
      add(rbox(0.86, 0.48, 0.96, hullDk, 0.06), 0, 0.72, -0.58);
      add(rbox(0.7, 0.36, 0.66, hull, 0.05), 0, 1.12, -0.54);
      add(rbox(0.74, 0.08, 0.7, accent, 0.02), 0, 1.0, -0.54);
      // Glossy armored citadel bridge visor
      add(rbox(0.6, 0.12, 0.1, getGlassMat("#74d4ff"), 0.02, false), 0, 1.16, -0.2);

      // Twin massive armored smokestacks with faction collar bands
      for (const sx of [-0.25, 0.25]) {
        add(cyl(0.19, 0.54, gunm, true), sx, 1.14, -0.96);
        add(cyl(0.21, 0.075, accent), sx, 1.38, -0.96);
      }

      // Tall command radar spire & spinning search radar (`spin`)
      add(cyl(0.075, 0.48, steel, true), 0, 1.54, -0.54);
      spin = new THREE.Group();
      spin.position.set(0, 1.8, -0.54);
      body.add(spin);
      spin.add(rbox(0.78, 0.09, 0.13, hullLt, 0.025));
      spin.add(box(0.68, 0.04, 0.15, accentBright));

      // Twin Heavy Angled Cruise-Missile Silo Batteries (`recoil`) packed with crimson-tipped missiles
      recoil = new THREE.Group();
      recoil.position.set(0, 0.68, 0.46);
      recoil.rotation.x = -0.68;
      body.add(recoil);
      const warheadGlow = getGlowMat(CRIMSON, 1.55);
      for (const mx of [-0.35, 0.35]) {
        const rack = rbox(0.44, 0.3, 1.18, gunm, 0.04);
        rack.position.set(mx, 0, 0);
        recoil.add(rack);
        const cap = rbox(0.46, 0.08, 0.96, accent, 0.02);
        cap.position.set(mx, 0.17, 0);
        recoil.add(cap);
        for (const tx of [-0.105, 0.105]) {
          const tube = cyl(0.145, 1.24, steel);
          tube.rotation.x = Math.PI / 2;
          tube.position.set(mx + tx, 0, 0.06);
          recoil.add(tube);
          const warhead = cone(0.142, 0.28, warheadGlow, false);
          warhead.rotation.x = Math.PI / 2;
          warhead.position.set(mx + tx, 0, 0.78);
          recoil.add(warhead);
          pulse.push(warhead);
        }
      }

      smokePos = new THREE.Vector3(-0.25, 1.46, -0.96);
      topY = 1.98;
      break;
    }

    default:
      return null;
  }

  return {
    topY,
    turret,
    rig: {
      turret: turret ?? undefined,
      recoil,
      spin,
      spin2,
      crane,
      pulse: pulse.length ? pulse : undefined,
      smokePos,
      altitude,
      subMats,
    },
  };
}
