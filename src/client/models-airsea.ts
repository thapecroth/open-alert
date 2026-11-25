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

// 16. MQ-9 Reaper Drone: Slender Streamlined Aerodynamic Fuselage (LatheGeometry along +Z)
function makeReaperFuselageGeo(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const steps = 20;
  const sternZ = -0.96;
  const noseZ = 0.88;
  const span = noseZ - sternZ;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps; // 0 = stern, 1 = nose
    const y = sternZ + u * span;
    let r: number;
    if (u > 0.72) {
      // Smooth rounded forward avionics/satcom nose
      const v = (u - 0.72) / 0.28;
      r = 0.115 * Math.sqrt(Math.max(0, 1 - v * v));
    } else if (u > 0.35) {
      // Slender tubular mid-fuselage
      r = 0.1 + 0.016 * Math.sin(((u - 0.35) / 0.37) * Math.PI);
    } else {
      // Tapered tail cone into pusher propeller shaft
      const v = u / 0.35;
      r = 0.024 + 0.076 * Math.pow(v, 0.72);
    }
    pts.push(new THREE.Vector2(Math.max(0.002, r), y));
  }
  const g = new THREE.LatheGeometry(pts, 18);
  g.rotateX(Math.PI / 2); // +Y -> +Z
  return g;
}

// 17. B-21 Phantom Stealth Bomber: Razor-Sharp Sawtooth Flying-Wing Planform (+y -> +Z)
function makeStealthBomberWingGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0.94); // razor stealth apex nose
  s.lineTo(1.52, -0.18); // ultra-clean swept leading edge
  s.lineTo(1.44, -0.44); // clipped razor wingtip
  // Iconic B-21 clean W-sawtooth trailing edge
  s.lineTo(0.84, -0.22);
  s.lineTo(0.46, -0.52);
  s.lineTo(0, -0.26);
  s.lineTo(-0.46, -0.52);
  s.lineTo(-0.84, -0.22);
  s.lineTo(-1.44, -0.44);
  s.lineTo(-1.52, -0.18);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.075,
    bevelEnabled: true,
    bevelThickness: 0.032,
    bevelSize: 0.028,
    bevelSegments: 2,
  });
  g.center();
  g.rotateX(Math.PI / 2);
  return g;
}

// 18. Mach-9 Hypersonic Strike Vehicle: Needle-Nosed Waverider Wedge Glider (+y -> +Z)
function makeHypersonicWedgeGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 1.38); // razor needle hypersonic nose
  s.lineTo(0.16, 0.72);
  s.lineTo(0.36, 0.08);
  s.lineTo(0.58, -0.68); // swept waverider chine edge
  s.lineTo(0.48, -0.92); // clipped trailing corner
  s.lineTo(0.24, -0.86);
  s.lineTo(0.18, -0.98); // scramjet exhaust transom
  s.lineTo(-0.18, -0.98);
  s.lineTo(-0.24, -0.86);
  s.lineTo(-0.48, -0.92);
  s.lineTo(-0.58, -0.68);
  s.lineTo(-0.36, 0.08);
  s.lineTo(-0.16, 0.72);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.085,
    bevelEnabled: true,
    bevelThickness: 0.038,
    bevelSize: 0.022,
    bevelSegments: 2,
  });
  g.center();
  g.rotateX(Math.PI / 2);
  return g;
}

// 19. Mach-9 Hypersonic Canted Stub Stabilizer Fin
function makeHypersonicFinGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.28, 0);
  s.lineTo(0.18, 0);
  s.lineTo(-0.08, 0.34);
  s.lineTo(-0.3, 0.3);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.024,
    bevelEnabled: true,
    bevelThickness: 0.008,
    bevelSize: 0.006,
    bevelSegments: 1,
  });
  g.center();
  g.rotateY(-Math.PI / 2);
  return g;
}

// 20. Nimitz Drone Carrier: Flared Supercarrier Lower Hull (+y -> +Z)
function makeCarrierHullGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 2.12); // sharp bulbous carrier bow
  s.lineTo(0.42, 1.48);
  s.lineTo(0.64, 0.68);
  s.lineTo(0.64, -1.24);
  s.lineTo(0.5, -1.78); // wide armored transom stern
  s.lineTo(-0.5, -1.78);
  s.lineTo(-0.64, -1.24);
  s.lineTo(-0.64, 0.68);
  s.lineTo(-0.42, 1.48);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.44,
    bevelEnabled: true,
    bevelThickness: 0.055,
    bevelSize: 0.04,
    bevelSegments: 2,
  });
  g.center();
  g.rotateX(Math.PI / 2);
  return g;
}

// 21. Nimitz Drone Carrier: Iconic Angled-Deck Supercarrier Flight Deck (+y -> +Z)
function makeCarrierDeckGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  // Starboard side (+x) relatively straight with island sponson; port side (-x) flares out for angled landing strip!
  s.moveTo(0.42, 2.08); // bow starboard corner
  s.lineTo(0.76, 0.92);
  s.lineTo(0.84, -0.96);
  s.lineTo(0.64, -1.86); // stern starboard corner
  s.lineTo(-0.68, -1.86); // stern port corner
  s.lineTo(-1.04, -0.74); // wide port angled-deck waist sponson!
  s.lineTo(-0.88, 0.62); // angled runway forward corner
  s.lineTo(-0.46, 2.08); // bow port corner
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.09,
    bevelEnabled: true,
    bevelThickness: 0.025,
    bevelSize: 0.025,
    bevelSegments: 2,
  });
  g.center();
  g.rotateX(Math.PI / 2);
  return g;
}

// 22. Micro Carrier UCAV Wing Planform (for parked drones on Nimitz Carrier deck)
function makeMicroDroneGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0.22);
  s.lineTo(0.24, -0.06);
  s.lineTo(0.2, -0.14);
  s.lineTo(0.06, -0.08);
  s.lineTo(0, -0.16);
  s.lineTo(-0.06, -0.08);
  s.lineTo(-0.2, -0.14);
  s.lineTo(-0.24, -0.06);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.025,
    bevelEnabled: true,
    bevelThickness: 0.008,
    bevelSize: 0.006,
    bevelSegments: 1,
  });
  g.center();
  g.rotateX(Math.PI / 2);
  return g;
}

// 23. FPV Suicide Drone: Sculpted PG-7V RPG Shaped-Charge Warhead (LatheGeometry along +Z)
function makeRpgWarheadGeo(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(0.002, -0.34),
    new THREE.Vector2(0.036, -0.34),
    new THREE.Vector2(0.038, -0.14), // narrow tail tube
    new THREE.Vector2(0.088, -0.02), // flared shaped-charge body
    new THREE.Vector2(0.092, 0.07),
    new THREE.Vector2(0.052, 0.22), // ballistic nose cone
    new THREE.Vector2(0.022, 0.34), // piezoelectric standoff probe
    new THREE.Vector2(0.002, 0.38),
  ];
  const g = new THREE.LatheGeometry(pts, 16);
  g.rotateX(Math.PI / 2); // +Y -> +Z
  return g;
}

// 24. Delta Kamikaze (Shahed): Iconic Cropped Delta-Wing Loitering Munition Planform (+y -> +Z)
function makeShahedWingGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0.96); // sharp warhead nose apex
  s.lineTo(0.14, 0.64);
  s.lineTo(0.84, -0.36); // wide swept delta leading edge
  s.lineTo(0.84, -0.66); // crisp cropped square wingtip
  s.lineTo(0.16, -0.62); // straight delta trailing edge
  s.lineTo(0.1, -0.74); // rear pusher engine cowling
  s.lineTo(-0.1, -0.74);
  s.lineTo(-0.16, -0.62);
  s.lineTo(-0.84, -0.66);
  s.lineTo(-0.84, -0.36);
  s.lineTo(-0.14, 0.64);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.068,
    bevelEnabled: true,
    bevelThickness: 0.024,
    bevelSize: 0.018,
    bevelSegments: 2,
  });
  g.center();
  g.rotateX(Math.PI / 2);
  return g;
}

// 25. Delta Kamikaze (Shahed): Twin Vertical Wingtip Endplate Rudder Fin (+x -> +Z)
function makeShahedTipFinGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0.18, 0.0); // leading wingtip nose
  s.lineTo(0.02, 0.22); // upper vertical stabilizer peak
  s.lineTo(-0.16, 0.19);
  s.lineTo(-0.18, -0.17); // symmetric lower ventral stabilizer
  s.lineTo(0.02, -0.19);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.02,
    bevelEnabled: true,
    bevelThickness: 0.006,
    bevelSize: 0.006,
    bevelSegments: 1,
  });
  g.center();
  g.rotateY(-Math.PI / 2);
  return g;
}

// 26. EW Jammer Drone: Sleek Dark-Titanium Hex-Wing Electronic Warfare UAV Planform (+y -> +Z)
function makeEwDroneWingGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0.82); // faceted hex-nose apex
  s.lineTo(0.28, 0.56);
  s.lineTo(0.96, 0.08); // forward-swept hex-wing outer shoulder
  s.lineTo(0.92, -0.26); // chamfered hexagonal wingtip
  s.lineTo(0.42, -0.58); // angled rear hex trailing edge
  s.lineTo(0.18, -0.46); // twin-boom rear notch
  s.lineTo(0, -0.62);
  s.lineTo(-0.18, -0.46);
  s.lineTo(-0.42, -0.58);
  s.lineTo(-0.92, -0.26);
  s.lineTo(-0.96, 0.08);
  s.lineTo(-0.28, 0.56);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.078,
    bevelEnabled: true,
    bevelThickness: 0.028,
    bevelSize: 0.022,
    bevelSegments: 2,
  });
  g.center();
  g.rotateX(Math.PI / 2);
  return g;
}

// 27. Sea-Baby USV: Low-Profile Stealth Wave-Piercing Unmanned Drone Boat Hull (+y -> +Z)
function makeUsvHullGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0.88); // razor wave-piercing kamikaze prow
  s.lineTo(0.17, 0.42);
  s.lineTo(0.24, -0.18); // sleek narrow low-observable beam
  s.lineTo(0.2, -0.68); // clean waterjet transom stern
  s.lineTo(-0.2, -0.68);
  s.lineTo(-0.24, -0.18);
  s.lineTo(-0.17, 0.42);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.13,
    bevelEnabled: true,
    bevelThickness: 0.032,
    bevelSize: 0.022,
    bevelSegments: 2,
  });
  g.center();
  g.rotateX(Math.PI / 2);
  return g;
}

// 28. A-10 Warthog: Sculpted Armored Thunderbolt II Fuselage Side Profile (+x -> +Z)
function makeA10FuselageGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(1.06, -0.02); // rounded armored Warthog nose cone
  s.lineTo(0.92, 0.08); // sloped armored windscreen brow
  s.lineTo(0.62, 0.13); // cockpit titanium tub sill
  s.lineTo(0.06, 0.15); // aft canopy fairing spine
  s.lineTo(-0.56, 0.12); // straight dorsal tail spine
  s.lineTo(-1.08, 0.07); // tapered tailcone top
  s.lineTo(-1.08, -0.02); // tailcone bottom
  s.lineTo(-0.46, -0.1); // tapered aft belly
  s.lineTo(0.46, -0.13); // armored titanium cockpit bathtub belly
  s.lineTo(0.94, -0.1); // GAU-8 chin gun fairing
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.22,
    bevelEnabled: true,
    bevelThickness: 0.048,
    bevelSize: 0.034,
    bevelSegments: 2,
  });
  g.center();
  g.rotateY(-Math.PI / 2);
  return g;
}

// 29. A-10 Warthog: Iconic Broad Straight Low-Mounted Wing Planform (+y -> +Z)
function makeA10WingGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-1.22, 0.22); // port straight leading edge
  s.lineTo(1.22, 0.22); // starboard straight leading edge
  s.lineTo(1.24, -0.16); // broad Hershey-bar wingtip chord
  s.lineTo(0.42, -0.22); // wide straight trailing edge
  s.lineTo(-0.42, -0.22);
  s.lineTo(-1.24, -0.16);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.048,
    bevelEnabled: true,
    bevelThickness: 0.018,
    bevelSize: 0.016,
    bevelSegments: 2,
  });
  g.center();
  g.rotateX(Math.PI / 2);
  return g;
}

// 30. A-10 Warthog: Iconic Outboard Vertical H-Tail Stabilizer Fin (+x -> +Z)
function makeA10TailFinGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0.24, -0.06); // forward fin root
  s.lineTo(0.08, 0.34); // distinctive swept upper leading edge
  s.quadraticCurveTo(0.02, 0.42, -0.08, 0.41); // rounded Warthog fin crown
  s.lineTo(-0.2, 0.36);
  s.lineTo(-0.24, -0.06); // straight vertical rudder trailing edge
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.026,
    bevelEnabled: true,
    bevelThickness: 0.008,
    bevelSize: 0.007,
    bevelSegments: 1,
  });
  g.center();
  g.rotateY(-Math.PI / 2);
  return g;
}

// 31. A-10 Warthog: Rear High-Bypass TF34 Turbofan Engine Nacelle Pod (LatheGeometry along +Z)
function makeA10EnginePodGeo(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(0.085, -0.34), // exhaust nozzle lip
    new THREE.Vector2(0.118, -0.22),
    new THREE.Vector2(0.145, -0.02), // full high-bypass fan cowling
    new THREE.Vector2(0.148, 0.22),
    new THREE.Vector2(0.132, 0.33), // rounded intake lip
    new THREE.Vector2(0.105, 0.35),
  ];
  const g = new THREE.LatheGeometry(pts, 18);
  g.rotateX(Math.PI / 2);
  return g;
}

// 32. AC-130 Spectre Gunship: Long Cylindrical C-130 Hercules Transport Fuselage (LatheGeometry along +Z)
function makeAc130FuselageGeo(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const steps = 28;
  const sternZ = -1.42;
  const noseZ = 1.36;
  const span = noseZ - sternZ;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps; // 0 = stern, 1 = nose
    const y = sternZ + u * span;
    let r: number;
    if (u > 0.84) {
      // Iconic rounded bulbous C-130 weather-radome nose
      const v = (u - 0.84) / 0.16;
      r = 0.26 * Math.sqrt(Math.max(0, 1 - v * v));
    } else if (u > 0.28) {
      // Long cylindrical pressurized cargo-deck fuselage barrel
      const mid = (u - 0.28) / 0.56;
      r = 0.265 + 0.012 * Math.sin(mid * Math.PI);
    } else {
      // Tapered rear cargo ramp & tailcone
      const v = u / 0.28;
      r = 0.055 + 0.21 * Math.pow(v, 0.72);
    }
    pts.push(new THREE.Vector2(Math.max(0.002, r), y));
  }
  const g = new THREE.LatheGeometry(pts, 24);
  g.rotateX(Math.PI / 2);
  return g;
}

// 33. AC-130 Spectre Gunship: Imposing Wide High-Mounted Straight Hercules Wing (+y -> +Z)
function makeAc130WingGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-1.82, 0.18); // port wingtip leading edge
  s.lineTo(-0.62, 0.3); // straight wide center wingbox leading edge
  s.lineTo(0.62, 0.3);
  s.lineTo(1.82, 0.18); // starboard wingtip leading edge
  s.lineTo(1.82, -0.06); // clipped wingtip trailing edge
  s.lineTo(0.64, -0.24); // tapered outer trailing edge
  s.lineTo(-0.64, -0.24);
  s.lineTo(-1.82, -0.06);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.065,
    bevelEnabled: true,
    bevelThickness: 0.022,
    bevelSize: 0.018,
    bevelSegments: 2,
  });
  g.center();
  g.rotateX(Math.PI / 2);
  return g;
}

// 34. AC-130 Spectre Gunship: Tall Commanding High T-Tail Vertical Stabilizer Fin (+x -> +Z)
function makeAc130TailFinGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0.46, 0.0); // long dorsal fillet root
  s.lineTo(0.16, 0.26);
  s.lineTo(-0.04, 0.88); // towering vertical fin leading crown
  s.lineTo(-0.34, 0.86); // broad T-tail cap
  s.lineTo(-0.38, 0.0); // tall vertical rudder trailing edge
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.046,
    bevelEnabled: true,
    bevelThickness: 0.014,
    bevelSize: 0.012,
    bevelSegments: 2,
  });
  g.center();
  g.rotateY(-Math.PI / 2);
  return g;
}

const geoHangarArch = makeHangarArchGeo();
const geoInterceptorPlanform = makeInterceptorPlanformGeo();
const geoJetTailFin = makeJetTailFinGeo();
const geoChopperHull = makeChopperHullGeo();
const geoFenestronFin = makeFenestronFinGeo();
const geoBomberWing = makeBomberWingGeo();
const geoStealthBomberWing = makeStealthBomberWingGeo();
const geoHypersonicWedge = makeHypersonicWedgeGeo();
const geoHypersonicFin = makeHypersonicFinGeo();
const geoReaperFuselage = makeReaperFuselageGeo();
const geoZeppelinHull = makeZeppelinHullGeo();
const geoNacelle = makeNacelleGeo();
const geoZeppelinFin = makeZeppelinFinGeo();
const geoGunboatHull = makeGunboatHullGeo();
const geoDestroyerHull = makeDestroyerHullGeo();
const geoSubHull = makeSubHullGeo();
const geoSubSail = makeSubSailGeo();
const geoDreadnoughtHull = makeDreadnoughtHullGeo();
const geoCarrierHull = makeCarrierHullGeo();
const geoCarrierDeck = makeCarrierDeckGeo();
const geoMicroDrone = makeMicroDroneGeo();
const geoRpgWarhead = makeRpgWarheadGeo();
const geoShahedWing = makeShahedWingGeo();
const geoShahedTipFin = makeShahedTipFinGeo();
const geoEwDroneWing = makeEwDroneWingGeo();
const geoUsvHull = makeUsvHullGeo();
const geoA10Fuselage = makeA10FuselageGeo();
const geoA10Wing = makeA10WingGeo();
const geoA10TailFin = makeA10TailFinGeo();
const geoA10EnginePod = makeA10EnginePodGeo();
const geoAc130Fuselage = makeAc130FuselageGeo();
const geoAc130Wing = makeAc130WingGeo();
const geoAc130TailFin = makeAc130TailFinGeo();
const geoA10ExhaustRing = new THREE.TorusGeometry(0.095, 0.024, 8, 20);
const geoPropBlurDisc = new THREE.CircleGeometry(0.28, 22);
const geoPropBlurRing = new THREE.RingGeometry(0.24, 0.285, 22);
const geoGunboatTurret = makeNavalTurretGeo(0.36, 0.16, 0.44);
const geoDestroyerTurret = makeNavalTurretGeo(0.5, 0.22, 0.6);
const geoSubShroud = new THREE.TorusGeometry(0.17, 0.024, 8, 20);
const geoEwHaloOuter = new THREE.TorusGeometry(0.76, 0.022, 8, 36);
geoEwHaloOuter.rotateX(Math.PI / 2);
const geoEwHaloInner = new THREE.TorusGeometry(0.52, 0.015, 8, 28);
geoEwHaloInner.rotateX(Math.PI / 2);
const geoEwHaloArc = new THREE.TorusGeometry(0.86, 0.014, 6, 18, Math.PI * 0.45);
geoEwHaloArc.rotateX(Math.PI / 2);

const ewHaloPurpleMat = new THREE.MeshBasicMaterial({
  color: 0xb05cff,
  transparent: true,
  opacity: 0.56,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const ewHaloCyanMat = new THREE.MeshBasicMaterial({
  color: 0x3ef2ff,
  transparent: true,
  opacity: 0.52,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const fpvBlurDiscMat = new THREE.MeshBasicMaterial({
  color: 0x202b36,
  transparent: true,
  opacity: 0.26,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const fpvBlurRingMat = new THREE.MeshBasicMaterial({
  color: 0xff5a36,
  transparent: true,
  opacity: 0.34,
  side: THREE.DoubleSide,
  depthWrite: false,
});
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
  // Variant tags let Renderer merge drone/USV instanced pools across player
  // colors while preserving these three distinct accent shades per instance.
  accent.userData.instAccentVariant = 0;
  accentDark.userData.instAccentVariant = 1;
  accentBright.userData.instAccentVariant = 2;
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

    // =========================================================================
    // 11. AIR COMMAND II STEALTH WING (3x2) — Stealth Tarmac, Twin Hangars & Dual-Radar ATC
    // =========================================================================
    case "airfield2": {
      const goldMat = getChassisMat(BRASS, 0.3, 0.78);
      const stealthTarmac = getChassisMat("#192028", 0.84, 0.14);
      const cyanGlow = getGlowMat(CORE_GLOW, 1.45);
      const stripeMat = getChassisMat("#dce8f2", 0.52, 0.12);

      // Reinforced concrete & armored dark-steel foundation slab + gold corner bollards
      add(rbox(2.96, 0.22, 1.96, getConcreteMat(), 0.045), 0, 0.11, 0);
      add(box(3.0, 0.06, 2.0, gunm), 0, 0.03, 0);
      for (const [bx, bz] of [
        [-1.38, -0.88],
        [1.38, -0.88],
        [-1.38, 0.88],
        [1.38, 0.88],
      ]) {
        add(rbox(0.16, 0.28, 0.16, hullDk, 0.025), bx, 0.16, bz);
        add(rbox(0.18, 0.06, 0.18, goldMat, 0.015), bx, 0.3, bz);
      }

      // Upgraded armored stealth tarmac across front (+Z) with glowing cyan landing lights
      add(rbox(2.76, 0.055, 1.04, stealthTarmac, 0.015), 0, 0.23, 0.36);

      // Gold & faction wing insignia bars painted onto runway apron
      for (const sx of [-1, 1]) {
        const wingGold = box(0.36, 0.015, 0.065, goldMat, false);
        wingGold.rotation.y = sx * -0.45;
        add(wingGold, sx * 0.24, 0.264, 0.38);
        const wingAcc = box(0.28, 0.015, 0.05, accentBright, false);
        wingAcc.rotation.y = sx * -0.45;
        add(wingAcc, sx * 0.2, 0.265, 0.5);
      }

      // Illuminated cyan landing chevrons along centerline
      for (const cx of [-0.94, 0.94]) {
        const chA = box(0.24, 0.016, 0.055, cyanGlow, false);
        chA.rotation.y = 0.55;
        add(chA, cx, 0.264, 0.3);
        const chB = box(0.24, 0.016, 0.055, cyanGlow, false);
        chB.rotation.y = -0.55;
        add(chB, cx, 0.264, 0.42);
        pulse.push(chA, chB);
      }
      // Crisp white threshold keys at both runway ends
      for (const tx of [-1.24, 1.24]) {
        for (const tz of [0.06, 0.24, 0.42, 0.6]) {
          add(box(0.15, 0.014, 0.08, stripeMat, false), tx, 0.262, tz);
        }
      }

      // Glowing cyan stealth runway perimeter lights
      for (const [lx, lz] of [
        [-1.32, 0.84],
        [-0.66, 0.84],
        [0, 0.84],
        [0.66, 0.84],
        [1.32, 0.84],
        [-1.32, -0.12],
        [1.32, -0.12],
      ]) {
        add(cyl(0.075, 0.08, gunm), lx, 0.26, lz);
        const lt = sph(0.085, cyanGlow, false);
        add(lt, lx, 0.315, lz);
        pulse.push(lt);
      }

      // Twin Reinforced Stealth Hangars side-by-side (rear-left & rear-center)
      for (const hx of [-0.92, 0.04]) {
        const hArch = mesh(geoHangarArch, stealth);
        hArch.scale.set(0.58, 1.06, 1.04);
        add(hArch, hx, 0.55, -0.52);
        for (const rx of [-0.36, 0, 0.36]) {
          const rib = mesh(geoHangarArch, hullLt);
          rib.scale.set(0.055, 1.1, 1.08);
          add(rib, hx + rx, 0.55, -0.52);
        }
        // Gold + faction stealth hangar fascia header + recessed aircraft bay + cyan ceiling glow
        add(rbox(0.86, 0.095, 0.12, accent, 0.02), hx, 0.72, -0.09);
        add(rbox(0.88, 0.05, 0.13, goldMat, 0.015), hx, 0.79, -0.09);
        add(box(0.68, 0.46, 0.06, gunm), hx, 0.44, -0.11);
        add(box(0.62, 0.045, 0.04, cyanGlow, false), hx, 0.63, -0.08);
      }
      // Overhead steel security bridge linking the twin stealth hangars
      add(rbox(1.12, 0.1, 0.28, hullDk, 0.02), -0.44, 0.89, -0.52);
      add(rbox(0.46, 0.06, 0.08, goldMat, 0.015), -0.44, 0.94, -0.37);

      // Tall Dual-Radar Stealth ATC Spire (rear-right: +X, -Z)
      add(rbox(0.62, 1.12, 0.58, hullDk, 0.05), 1.02, 0.78, -0.5);
      add(rbox(0.68, 0.12, 0.64, accent, 0.025), 1.02, 1.32, -0.5);
      add(rbox(0.7, 0.06, 0.66, goldMat, 0.015), 1.02, 1.4, -0.5);
      // Panoramic stealth cyan glass ATC observation cab
      add(rbox(0.84, 0.34, 0.74, getGlassMat("#6ee4ff"), 0.05), 1.02, 1.62, -0.5);
      add(rbox(0.96, 0.1, 0.86, stealth, 0.03), 1.02, 1.84, -0.5);
      add(rbox(0.84, 0.06, 0.74, goldMat, 0.02), 1.02, 1.91, -0.5);

      // Dual-Radar ATC Spire: Primary lower surveillance radar (`spin`) + Upper secondary scanner (`spin2`)
      add(cyl(0.09, 0.66, steel), 1.02, 2.24, -0.5);
      spin = new THREE.Group();
      spin.position.set(1.02, 2.2, -0.5);
      body.add(spin);
      spin.add(rbox(0.96, 0.12, 0.14, hullLt, 0.03));
      spin.add(box(0.86, 0.045, 0.16, accentBright));
      const dish1 = cyl(0.42, 0.06, steel, true);
      dish1.rotation.x = 0.78;
      dish1.position.set(0, 0.09, 0.1);
      spin.add(dish1);

      spin2 = new THREE.Group();
      spin2.position.set(1.02, 2.58, -0.5);
      body.add(spin2);
      spin2.add(rbox(0.58, 0.075, 0.1, goldMat, 0.02));
      const tip2 = sph(0.085, cyanGlow, false);
      tip2.position.set(0, 0.1, 0);
      spin2.add(tip2);
      pulse.push(tip2);

      // Aviation obstruction strobe
      const ob2 = sph(0.09, getGlowMat(CRIMSON, 1.45), false);
      add(ob2, 1.4, 1.95, -0.84);
      pulse.push(ob2);

      smokePos = new THREE.Vector3(-0.44, 1.24, -0.52);
      topY = 2.78;
      break;
    }

    // =========================================================================
    // 12. NAVAL SHIPYARD II FLEET DOCK (3x3) — Heavy Drydock, Twin Cranes & Fleet Radar Bridge
    // =========================================================================
    case "shipyard2": {
      const yellowMat = getChassisMat(CRANE_YEL, 0.4, 0.46);
      const yellowDk = getChassisMat(CRANE_DK, 0.46, 0.42);
      const goldMat = getChassisMat(BRASS, 0.3, 0.78);
      const cyanGlow = getGlowMat(CORE_GLOW, 1.45);

      // Heavy armored fleet drydock floating pontoons (wider & taller than MK1)
      for (const sx of [-1.1, 1.1]) {
        add(rbox(0.76, 0.42, 2.86, hullDk, 0.05), sx, 0.27, 0);
        add(rbox(0.68, 0.08, 2.74, hullLt, 0.025), sx, 0.5, 0);
        // Gold fleet command trim along outer pontoon parapet
        add(rbox(0.1, 0.075, 2.66, goldMat, 0.015), sx + (sx > 0 ? 0.31 : -0.31), 0.56, 0);
        // Satin faction inner slipway edge trim + waterline bumper
        add(box(0.08, 0.16, 2.72, gunm), sx + (sx > 0 ? -0.38 : 0.38), 0.2, 0);
        add(rbox(0.16, 0.065, 2.62, accent, 0.015), sx + (sx > 0 ? -0.24 : 0.24), 0.55, 0);
        // Heavy crane rail tracks along pontoon tops
        add(box(0.14, 0.08, 2.58, yellowDk), sx, 0.57, 0.04);
        // Glowing fleet dock slipway edge guide beacons
        for (const bz of [-0.62, 0.14, 0.9]) {
          add(cyl(0.11, 0.16, hullDk), sx + (sx > 0 ? -0.28 : 0.28), 0.6, bz);
          const dkLight = sph(0.08, cyanGlow, false);
          add(dkLight, sx + (sx > 0 ? -0.28 : 0.28), 0.72, bz);
          pulse.push(dkLight);
        }
      }

      // Expanded Multi-Tier Naval Fleet Radar Bridge across rear bulkhead (-Z)
      add(rbox(2.94, 0.46, 0.76, hull, 0.05), 0, 0.29, -1.08);
      add(rbox(1.68, 0.62, 0.62, hullDk, 0.05), -0.14, 0.78, -1.1);
      add(rbox(1.74, 0.1, 0.66, accent, 0.025), -0.14, 1.09, -1.1);
      add(rbox(1.76, 0.06, 0.68, goldMat, 0.015), -0.14, 1.16, -1.1);
      // Upper fleet command deckhouse & panoramic bridge glass
      add(rbox(1.18, 0.36, 0.48, hull, 0.045), -0.14, 1.36, -1.1);
      add(rbox(1.06, 0.18, 0.1, getGlassMat("#72dcff"), 0.02), -0.14, 1.38, -0.84);
      add(rbox(1.32, 0.2, 0.1, getGlassMat("#72dcff"), 0.02), -0.14, 0.84, -0.78);
      // Side armored exhaust funnels
      for (const fx of [-1.14, 0.92]) {
        add(cyl(0.18, 0.56, gunm, true), fx, 0.88, -1.14);
        add(cyl(0.2, 0.07, goldMat), fx, 1.12, -1.14);
      }

      // Expanded Fleet Radar Spire (`spin`)
      add(cyl(0.095, 0.84, steel, true), -0.14, 1.94, -1.1);
      spin = new THREE.Group();
      spin.position.set(-0.14, 2.36, -1.1);
      body.add(spin);
      spin.add(rbox(1.06, 0.11, 0.15, hullLt, 0.025));
      spin.add(box(0.94, 0.045, 0.17, accentBright));
      const mastOrb = sph(0.09, cyanGlow, false);
      mastOrb.position.set(0, 0.13, 0);
      spin.add(mastOrb);
      pulse.push(mastOrb);

      // Twin Yellow Heavy Gantry Cranes (`crane` slides smoothly along the slipway Z!)
      crane = new THREE.Group();
      crane.position.set(0, 0.58, 0.1);
      body.add(crane);
      for (const cz of [-0.46, 0.48]) {
        for (const sx of [-1.1, 1.1]) {
          const legA = rbox(0.13, 1.5, 0.13, yellowMat, 0.02);
          legA.position.set(sx, 0.74, cz - 0.2);
          legA.rotation.x = 0.15;
          crane.add(legA);
          const legB = rbox(0.13, 1.5, 0.13, yellowMat, 0.02);
          legB.position.set(sx, 0.74, cz + 0.2);
          legB.rotation.x = -0.15;
          crane.add(legB);
          const brace = box(0.11, 0.08, 0.38, yellowDk);
          brace.position.set(sx, 0.7, cz);
          crane.add(brace);
          const bogie = rbox(0.24, 0.13, 0.54, gunm, 0.025);
          bogie.position.set(sx, 0.05, cz);
          crane.add(bogie);
        }
        // Heavy double box-girders spanning the fleet slipway
        for (const gz of [-0.11, 0.11]) {
          const girder = rbox(2.6, 0.17, 0.11, yellowMat, 0.025);
          girder.position.set(0, 1.48, cz + gz);
          crane.add(girder);
        }
        // Armored fleet winch trolley + gold cap + cables + heavy spreader hook
        const trolley = rbox(0.54, 0.24, 0.4, accent, 0.04);
        trolley.position.set(cz > 0 ? 0.28 : -0.28, 1.36, cz);
        crane.add(trolley);
        const capG = rbox(0.56, 0.06, 0.42, goldMat, 0.015);
        capG.position.set(cz > 0 ? 0.28 : -0.28, 1.5, cz);
        crane.add(capG);
        for (const cx of [-0.12, 0.12]) {
          const cable = cyl(0.028, 0.72, steel);
          cable.position.set((cz > 0 ? 0.28 : -0.28) + cx, 0.92, cz);
          crane.add(cable);
        }
        const hook = rbox(0.36, 0.11, 0.16, gunm, 0.025);
        hook.position.set(cz > 0 ? 0.28 : -0.28, 0.54, cz);
        crane.add(hook);
      }

      // Pulsing fleet harbor entrance navigation beacons at slipway mouth (+Z)
      const gGlow = getGlowMat(EMERALD, 1.45);
      for (const [bx, bz, isCyan] of [
        [-1.16, 1.42, false],
        [1.16, 1.42, false],
        [-0.76, 1.34, true],
        [0.76, 1.34, true],
      ] as [number, number, boolean][]) {
        add(cyl(0.18, 0.26, hullDk, true), bx, 0.2, bz);
        const buoy = sph(0.115, isCyan ? cyanGlow : gGlow, false);
        add(buoy, bx, 0.4, bz);
        pulse.push(buoy);
      }

      smokePos = new THREE.Vector3(-0.7, 1.38, -1.1);
      topY = 2.58;
      break;
    }

    // =========================================================================
    // 13. REAPER RECON DRONE (UAV, Air) — MQ-9 Long Wings, Bulbous Nose, V-Tail & Pusher Prop
    // =========================================================================
    case "uav": {
      altitude = 3.12;
      body.position.y = altitude;

      const droneBodyMat = getChassisMat("#8593a0", 0.34, 0.52);
      const droneWingMat = getChassisMat("#9aa7b4", 0.32, 0.48);

      // Slender smooth LatheGeometry MQ-9 Reaper fuselage
      add(mesh(geoReaperFuselage, droneBodyMat), 0, 0, 0);

      // Iconic bulbous satellite-dome forehead nose hump!
      const satNose = sph(0.24, droneWingMat);
      satNose.scale.multiply(new THREE.Vector3(0.86, 0.72, 2.05));
      add(satNose, 0, 0.065, 0.44);
      // Satin faction dorsal stripe along spine
      add(rbox(0.08, 0.04, 0.88, accent, 0.015), 0, 0.11, -0.14);

      // Ventral EO/IR targeting sensor ball turret under the chin + glowing cyan optic lens
      add(sph(0.14, gunm), 0, -0.13, 0.52);
      const eoLens = sph(0.062, getGlowMat(CORE_GLOW, 1.45), false);
      add(eoLens, 0, -0.14, 0.59);
      pulse.push(eoLens);

      // Long slender high-aspect straight MQ-9 wings!
      add(rbox(2.38, 0.036, 0.22, droneWingMat, 0.012), 0, 0.01, -0.02);
      for (const sx of [-1, 1]) {
        // Subtle faction wing markings & wingtip nav strobes
        add(box(0.32, 0.042, 0.14, accent), sx * 0.72, 0.012, -0.02);
        const nav = sph(0.048, getGlowMat(sx < 0 ? CRIMSON : EMERALD, 1.4), false);
        add(nav, sx * 1.2, 0.01, -0.02);
        pulse.push(nav);

        // Underwing hardpoint pylon + twin Hellfire micro-missiles!
        add(box(0.04, 0.09, 0.16, hullDk), sx * 0.42, -0.05, 0.0);
        for (const ox of [-0.042, 0.042]) {
          const hf = cyl(0.034, 0.34, gunm);
          hf.rotation.x = Math.PI / 2;
          add(hf, sx * 0.42 + ox, -0.1, 0.04);
          const tip = cone(0.034, 0.075, getGlowMat(ORE_GLOW, 1.25), false);
          tip.rotation.x = Math.PI / 2;
          add(tip, sx * 0.42 + ox, -0.1, 0.24);
        }

        // Inverted V-tail stabilizers angled cleanly from rear fuselage
        const vTail = rbox(0.46, 0.028, 0.18, droneWingMat, 0.008);
        vTail.rotation.z = sx * -0.58;
        vTail.rotation.y = sx * -0.18;
        add(vTail, sx * 0.19, -0.1, -0.82);
        const vTip = box(0.14, 0.032, 0.14, accent);
        vTip.rotation.z = sx * -0.58;
        vTip.rotation.y = sx * -0.18;
        add(vTip, sx * 0.32, -0.18, -0.85);
      }
      // Small dorsal intake scoop ahead of rear pusher engine
      add(rbox(0.09, 0.065, 0.22, hullDk, 0.018), 0, 0.11, -0.52);

      // Spinning rear pusher propeller (`spin` rotates around Z)
      spin = new THREE.Group();
      spin.position.set(0, 0, -0.99);
      body.add(spin);
      spin.add(sph(0.075, gunm));
      for (let i = 0; i < 4; i++) {
        const blade = box(0.038, 0.44, 0.016, gunm);
        blade.rotation.z = (i * Math.PI) / 2;
        spin.add(blade);
      }

      smokePos = new THREE.Vector3(0, altitude, -0.98);
      topY = altitude + 0.42;
      break;
    }

    // =========================================================================
    // 14. B-21 PHANTOM STEALTH BOMBER (Air) — Matte-Obsidian Flying Wing + Cloned subMats
    // =========================================================================
    case "stealthbomber": {
      altitude = 3.52;
      body.position.y = altitude;

      const obsidian = getChassisMat("#151920", 0.52, 0.46);
      const obsidianTrim = getChassisMat("#222832", 0.44, 0.56);

      // Razor-sharp matte-obsidian B-21 sawtooth flying-wing silhouette (ExtrudeGeometry)
      add(mesh(geoStealthBomberWing, obsidian), 0, 0, 0);

      // Sleek ultra-low-observable blended dorsal fuselage ridge
      add(rbox(0.48, 0.12, 1.12, obsidianTrim, 0.055), 0, 0.06, 0.08);
      // Understated thin dorsal spine faction line
      add(box(0.07, 0.03, 0.84, accent), 0, 0.125, 0.02);

      // Dark tinted flush stealth cockpit glazing (recessed cleanly into nose contour)
      const cockpit = rbox(0.36, 0.075, 0.26, getGlassMat("#183654"), 0.025, false);
      cockpit.rotation.x = 0.24;
      add(cockpit, 0, 0.095, 0.54);

      // Recessed ventral stealth weapons bay fairing
      add(rbox(0.42, 0.09, 0.78, gunm, 0.025), 0, -0.075, 0.04);

      for (const sx of [-1, 1]) {
        // Subtle crisp faction wingtip trim chevrons
        const tipTrim = box(0.36, 0.095, 0.09, accent);
        tipTrim.rotation.y = sx * -0.62;
        add(tipTrim, sx * 1.24, 0.005, -0.22);

        // Flush low-observable dorsal conformal engine intakes
        add(rbox(0.2, 0.09, 0.56, obsidianTrim, 0.03), sx * 0.34, 0.055, 0.04);
        add(box(0.15, 0.05, 0.05, gunm), sx * 0.34, 0.065, 0.32);

        // Shielded stealth exhaust troughs with subtle cool cyan thermal-masked glow (`pulse`)
        add(rbox(0.2, 0.06, 0.22, gunm, 0.015), sx * 0.34, 0.035, -0.34);
        const sGlow = rbox(0.16, 0.038, 0.18, getGlowMat("#3cb8ff", 1.25), 0.01, false);
        add(sGlow, sx * 0.34, 0.035, -0.44);
        pulse.push(sGlow);
      }

      // Per-instance cloned subMats so B-21 Phantom smoothly turns semi-translucent when stealth-cloaked!
      const mats: THREE.Material[] = [];
      body.traverse((o) => {
        if (o instanceof THREE.Mesh && !Array.isArray(o.material)) {
          const cloned = (o.material as THREE.Material).clone();
          o.material = cloned;
          mats.push(cloned);
        }
      });
      subMats = mats;

      smokePos = new THREE.Vector3(0, altitude, -0.58);
      topY = altitude + 0.56;
      break;
    }

    // =========================================================================
    // 15. MACH-9 STRIKE VEHICLE (Hypersonic, Air) — Needle Waverider Wedge + Scramjet Plasma Cone
    // =========================================================================
    case "hypersonic": {
      altitude = 3.68;
      body.position.y = altitude;

      const thermalWhite = getChassisMat("#8c9aa8", 0.3, 0.62);

      // Sleek needle-nosed Mach-9 hypersonic waverider wedge glider (ExtrudeGeometry)
      add(mesh(geoHypersonicWedge, thermalWhite), 0, 0, 0);

      // Dark carbon-carbon thermal-shielded dorsal ridge & leading strakes
      add(rbox(0.24, 0.12, 1.52, stealth, 0.045), 0, 0.065, -0.06);
      add(rbox(0.11, 0.05, 1.24, accent, 0.02), 0, 0.13, -0.14);

      // Glowing superheated hypersonic needle nose tip + flush optical slit
      const heatNose = cone(0.13, 0.34, getGlowMat("#ffbc6e", 1.25), false);
      heatNose.rotation.x = Math.PI / 2;
      add(heatNose, 0, 0.01, 1.46);
      const sensorSlit = rbox(0.18, 0.048, 0.24, getGlassMat("#6ce4ff"), 0.015, false);
      sensorSlit.rotation.x = 0.22;
      add(sensorSlit, 0, 0.11, 0.52);

      // Underslung hypersonic scramjet air intake ramp & diffuser duct
      add(rbox(0.32, 0.11, 0.96, gunm, 0.025), 0, -0.08, -0.26);

      // Outward-canted stub stabilizer fins (ExtrudeGeometry)
      for (const sx of [-1, 1]) {
        const fin = mesh(geoHypersonicFin, stealth);
        fin.rotation.z = sx * -0.54;
        add(fin, sx * 0.44, 0.15, -0.74);
        const finEdge = box(0.028, 0.08, 0.24, accent);
        finEdge.rotation.z = sx * -0.54;
        add(finEdge, sx * 0.52, 0.26, -0.78);
      }

      // Scramjet rectangular exhaust shroud + blazing white-cyan plasma afterburner cone (`pulse`)
      add(rbox(0.34, 0.14, 0.22, gunm, 0.025), 0, -0.01, -0.96);

      const plasmaOuter = cone(0.25, 1.04, getGlowMat(CORE_GLOW, 1.85), false);
      plasmaOuter.rotation.x = -Math.PI / 2;
      add(plasmaOuter, 0, -0.01, -1.56);
      pulse.push(plasmaOuter);

      const plasmaInner = cone(0.14, 0.74, getGlowMat("#e6fbff", 2.1), false);
      plasmaInner.rotation.x = -Math.PI / 2;
      add(plasmaInner, 0, -0.01, -1.42);
      pulse.push(plasmaInner);

      smokePos = new THREE.Vector3(0, altitude, -1.16);
      topY = altitude + 0.52;
      break;
    }

    // =========================================================================
    // 16. NIMITZ DRONE CARRIER (Sea) — Angled-Deck Supercarrier, Island Radar & 3 Parked Micro-Drones
    // =========================================================================
    case "carrier": {
      body.position.y = 0.08;

      const deckMat = getChassisMat("#262e36", 0.86, 0.12);
      const stripeWhite = getChassisMat("#e4edf5", 0.55, 0.1);
      const foulYellow = getChassisMat(CRANE_YEL, 0.5, 0.2);
      const cyanGlow = getGlowMat(CORE_GLOW, 1.45);

      // Colossal flared supercarrier lower armored hull (ExtrudeGeometry)
      add(mesh(geoCarrierHull, hullDk), 0, 0.2, 0);
      // Bold satin faction waterline hull belt
      add(rbox(1.32, 0.1, 2.74, accent, 0.025), 0, 0.22, -0.14);

      // Wide flat beveled angled flight deck overhanging the hull! (ExtrudeGeometry)
      add(mesh(geoCarrierDeck, deckMat), 0, 0.48, 0);
      // Under-deck structural sponson brackets
      for (const sz of [-1.04, -0.18, 0.68]) {
        add(rbox(1.66, 0.09, 0.14, hull, 0.02), -0.06, 0.39, sz);
      }

      // Painted white axial runway centerline & angled landing runway stripes
      for (const rz of [-1.25, -0.62, 0.02, 0.66, 1.3]) {
        add(box(0.055, 0.012, 0.38, stripeWhite, false), 0.04, 0.555, rz);
      }
      // Iconic port-side angled landing runway white border & centerline markings
      const angleRunway = new THREE.Group();
      angleRunway.position.set(-0.32, 0.556, -0.28);
      angleRunway.rotation.y = 0.21;
      body.add(angleRunway);
      add(box(0.04, 0.01, 2.38, stripeWhite, false), -0.34, 0, 0, angleRunway);
      add(box(0.04, 0.01, 2.38, stripeWhite, false), 0.34, 0, 0, angleRunway);
      add(box(0.045, 0.01, 2.28, foulYellow, false), 0, 0, 0, angleRunway);

      // Glowing electromagnetic launch catapult (EMALS) strips on bow & waist!
      const catBow = box(0.055, 0.014, 1.24, cyanGlow, false);
      add(catBow, 0.18, 0.558, 1.28);
      pulse.push(catBow);
      const catWaist = box(0.055, 0.014, 1.08, cyanGlow, false);
      catWaist.rotation.y = 0.21;
      add(catWaist, -0.44, 0.558, 0.34);
      pulse.push(catWaist);

      // Offset Starboard Island Superstructure (+X side!)
      const ix = 0.58;
      const iz = -0.24;
      add(rbox(0.38, 0.48, 0.92, hull, 0.04), ix, 0.78, iz);
      add(rbox(0.32, 0.36, 0.66, hullDk, 0.035), ix, 1.14, iz + 0.04);
      add(rbox(0.4, 0.08, 0.94, accent, 0.02), ix, 0.98, iz);
      // Dual-level glossy panoramic island bridge windows (Pri-Fly & navigation bridge)
      add(rbox(0.34, 0.1, 0.52, getGlassMat("#72dcff"), 0.02, false), ix - 0.02, 1.22, iz + 0.08);
      add(rbox(0.3, 0.08, 0.12, getGlassMat("#72dcff"), 0.015, false), ix, 1.22, iz + 0.35);
      // Side SPY phased-array radar panel on island
      add(box(0.03, 0.18, 0.26, getChassisMat("#6a7378", 0.42, 0.55)), ix - 0.17, 1.12, iz + 0.14);

      // Integrated Naval Communications Mast & Spinning Dual Radar (`spin`)
      add(cyl(0.065, 0.54, steel, true), ix, 1.56, iz + 0.04);
      spin = new THREE.Group();
      spin.position.set(ix, 1.76, iz + 0.04);
      body.add(spin);
      // Lower primary air-search radar bar
      spin.add(rbox(0.68, 0.085, 0.12, hullLt, 0.02));
      spin.add(box(0.58, 0.038, 0.14, accentBright));
      // Upper secondary navigation scanner bar mounted perpendicular above
      const upperBar = rbox(0.1, 0.06, 0.42, steel, 0.015);
      upperBar.position.set(0, 0.16, 0);
      spin.add(upperBar);
      const mastLight = sph(0.075, getGlowMat(CRIMSON, 1.5), false);
      mastLight.position.set(0, 0.26, 0);
      spin.add(mastLight);
      pulse.push(mastLight);

      // Compact CIWS defense dome on bow starboard sponson
      add(cyl(0.14, 0.18, hullLt), 0.52, 0.58, 1.62);
      add(sph(0.14, stripeWhite), 0.52, 0.68, 1.62);

      // 3 Parked Stealth Micro-Drones arranged cleanly on the carrier flight deck!
      for (const [dx, dz, drot] of [
        [0.44, 0.88, -0.35],
        [0.46, -1.14, -0.45],
        [0.06, -1.46, -0.22],
      ]) {
        const dGrp = new THREE.Group();
        dGrp.position.set(dx, 0.575, dz);
        dGrp.rotation.y = drot;
        body.add(dGrp);
        dGrp.add(mesh(geoMicroDrone, hullLt));
        add(box(0.06, 0.03, 0.16, accent), 0, 0.015, 0.02, dGrp);
      }

      smokePos = new THREE.Vector3(ix, 1.38, iz - 0.18);
      topY = 2.02;
      break;
    }

    // =========================================================================
    // 17. FPV SUICIDE DRONE (Air) — Carbon-Fiber X-Frame Quadcopter + Underslung RPG Warhead
    // =========================================================================
    case "fpvdrone": {
      altitude = 2.65;
      body.position.y = altitude;

      const carbonMat = getChassisMat("#181d24", 0.36, 0.52);
      const oliveWarhead = getChassisMat("#4a5738", 0.56, 0.28);
      const warheadMetal = getChassisMat("#6e7880", 0.32, 0.78);
      const copperMat = getChassisMat("#c97a38", 0.32, 0.8);
      const crimsonLed = getGlowMat(CRIMSON, 1.9);

      // Central carbon-fiber flight controller stack & top/bottom X-frame plates
      add(rbox(0.24, 0.055, 0.34, carbonMat, 0.015), 0, 0.02, 0);
      add(rbox(0.18, 0.08, 0.24, hullDk, 0.02), 0, 0.065, -0.02);
      // Top-mounted strapped LiPo battery pack with satin faction grip band
      add(rbox(0.15, 0.075, 0.22, gunm, 0.018), 0, 0.125, -0.03);
      add(box(0.162, 0.082, 0.052, accent), 0, 0.125, -0.03);

      // Authentic carbon-fiber X-frame 4 arms + 4 angled brushless motor pods + spinning rotors (`spin`)
      spin = new THREE.Group();
      body.add(spin);

      const armOffsets: [number, number][] = [
        [-1, 1], // front-left
        [1, 1], // front-right
        [-1, -1], // rear-left
        [1, -1], // rear-right
      ];
      for (const [sx, sz] of armOffsets) {
        const ang = Math.atan2(sx, sz);
        // Carbon-fiber diagonal arm strut
        const arm = rbox(0.052, 0.026, 0.44, carbonMat, 0.008);
        arm.rotation.y = ang;
        add(arm, sx * 0.19, 0.025, sz * 0.19);
        // Subtle faction arm stripe near hub
        const stripe = box(0.056, 0.03, 0.075, accent);
        stripe.rotation.y = ang;
        add(stripe, sx * 0.12, 0.026, sz * 0.12);

        // Angled motor pod mount & brushless bell at arm tip
        const mx = sx * 0.34;
        const mz = sz * 0.34;
        const pod = new THREE.Group();
        pod.position.set(mx, 0.052, mz);
        pod.rotation.z = -sx * 0.09;
        pod.rotation.x = sz * 0.07;
        body.add(pod);
        add(cyl(0.092, 0.072, gunm), 0, 0, 0, pod);
        add(cyl(0.082, 0.026, copperMat), 0, 0.01, 0, pod);
        add(cyl(0.038, 0.04, steel), 0, 0.048, 0, pod);

        // Individual spinning 3-blade FPV rotor + translucent motion-blur disc (child of `spin`)
        const rotor = new THREE.Group();
        rotor.position.set(mx, 0.105, mz);
        rotor.rotation.z = -sx * 0.09;
        rotor.rotation.x = sz * 0.07;
        spin.add(rotor);
        rotor.add(cyl(0.034, 0.024, steel));
        for (let b = 0; b < 3; b++) {
          const bang = (b * Math.PI * 2) / 3;
          const blade = box(0.026, 0.008, 0.24, carbonMat);
          blade.position.set(Math.sin(bang) * 0.12, 0, Math.cos(bang) * 0.12);
          blade.rotation.y = bang;
          rotor.add(blade);
        }
        const bDisc = new THREE.Mesh(geoRotorDisc, fpvBlurDiscMat);
        bDisc.scale.setScalar(0.245);
        bDisc.position.y = -0.005;
        rotor.add(bDisc);
        const bRing = new THREE.Mesh(rotorRingGeo, fpvBlurRingMat);
        bRing.scale.setScalar(0.245);
        bRing.position.y = -0.004;
        rotor.add(bRing);
      }

      // Front tilt-angled micro-FPV camera cage + optical lens
      add(rbox(0.11, 0.095, 0.09, carbonMat, 0.014), 0, 0.055, 0.19);
      const camBarrel = cyl(0.064, 0.055, gunm);
      camBarrel.rotation.x = Math.PI / 2 - 0.24;
      add(camBarrel, 0, 0.06, 0.245);
      const camLens = sph(0.048, getGlassMat("#64e4ff"), false);
      add(camLens, 0, 0.064, 0.27);

      // Rear tilted VTX lollipop FPV antenna
      const antMast = cyl(0.016, 0.19, steel);
      antMast.rotation.x = -0.45;
      add(antMast, 0, 0.14, -0.2);
      add(sph(0.052, accentBright), 0, 0.22, -0.25);

      // Underslung strapped olive/metallic RPG PG-7V shaped-charge warhead!
      add(mesh(geoRpgWarhead, oliveWarhead), 0, -0.095, 0.06);
      // Metallic nose cap collar & twin copper contact-detonator fuse prongs
      const noseBand = cyl(0.094, 0.045, warheadMetal);
      noseBand.rotation.x = Math.PI / 2;
      add(noseBand, 0, -0.095, 0.16);
      for (const sx of [-1, 1]) {
        const prong = cyl(0.01, 0.13, copperMat);
        prong.rotation.x = Math.PI / 2;
        prong.rotation.z = sx * 0.22;
        add(prong, sx * 0.022, -0.095, 0.45);
      }
      // Heavy black mounting straps cinching warhead tightly to belly
      for (const sz of [-0.04, 0.1]) {
        add(rbox(0.2, 0.135, 0.028, gunm, 0.006), 0, -0.035, sz);
      }
      // Pulsing bright crimson armed detonator LED (`pulse`)
      const armedLed = sph(0.062, crimsonLed, false);
      add(armedLed, 0, -0.025, 0.26);
      pulse.push(armedLed);
      const tailLed = sph(0.042, crimsonLed, false);
      add(tailLed, 0, 0.09, -0.18);
      pulse.push(tailLed);

      smokePos = new THREE.Vector3(0, altitude, -0.2);
      topY = altitude + 0.34;
      break;
    }

    // =========================================================================
    // 18. DELTA KAMIKAZE (Shahed, Air) — Cropped Delta-Wing Loitering Munition + Pusher Prop
    // =========================================================================
    case "shahed": {
      altitude = 3.15;
      body.position.y = altitude;

      const matteWhite = getChassisMat("#c8d1da", 0.56, 0.22);
      const matteSlate = getChassisMat("#8c99a6", 0.52, 0.28);
      const noseDark = getChassisMat("#1f252d", 0.44, 0.58);
      const crimsonStripe = getChassisMat("#d43228", 0.42, 0.36);

      // Iconic sleek matte white/slate cropped delta-wing fuselage (ExtrudeGeometry)
      add(mesh(geoShahedWing, matteWhite), 0, 0, 0);

      // Blended cylindrical dorsal fuselage fairing spine tapering from warhead to pusher engine
      const spine = cyl(0.19, 1.38, matteSlate, true);
      spine.rotation.x = Math.PI / 2;
      add(spine, 0, 0.04, -0.04);
      // Satin faction dorsal & wing identification bands
      add(rbox(0.11, 0.045, 0.68, accent, 0.015), 0, 0.11, -0.16);
      for (const sx of [-1, 1]) {
        const wMark = box(0.26, 0.082, 0.14, accent);
        add(wMark, sx * 0.46, 0.004, -0.44);
      }

      // Dark warhead nose cone with crimson accent stripe & pulsing armed tip beacon
      const noseCone = cone(0.19, 0.42, noseDark);
      noseCone.rotation.x = Math.PI / 2;
      add(noseCone, 0, 0.01, 0.96);
      const redBand = cyl(0.175, 0.075, crimsonStripe);
      redBand.rotation.x = Math.PI / 2;
      add(redBand, 0, 0.01, 0.72);
      const armedDot = sph(0.056, getGlowMat(CRIMSON, 1.8), false);
      add(armedDot, 0, 0.085, 0.58);
      pulse.push(armedDot);

      // Twin vertical wingtip endplate rudders (ExtrudeGeometry extending above & below wingtips!)
      for (const sx of [-1, 1]) {
        add(mesh(geoShahedTipFin, matteSlate), sx * 0.85, 0.01, -0.52);
        add(box(0.032, 0.08, 0.18, crimsonStripe), sx * 0.85, 0.14, -0.56);
      }

      // Rear dark engine cowling + twin mini exhaust stubs
      add(rbox(0.18, 0.12, 0.2, gunm, 0.025), 0, 0.01, -0.74);
      for (const sx of [-0.075, 0.075]) {
        const exh = cyl(0.032, 0.12, steel);
        exh.rotation.x = Math.PI / 2;
        add(exh, sx, -0.05, -0.78);
      }

      // Rear spinning 2-blade pusher propeller (`spin` rotates around Z)
      spin = new THREE.Group();
      spin.position.set(0, 0.01, -0.87);
      body.add(spin);
      const pHub = cone(0.075, 0.12, gunm);
      pHub.rotation.x = -Math.PI / 2;
      spin.add(pHub);
      const propMat = getChassisMat("#242a32", 0.42, 0.56);
      for (let i = 0; i < 2; i++) {
        const blade = box(0.042, 0.46, 0.016, propMat);
        blade.rotation.z = (i * Math.PI) / 2;
        spin.add(blade);
      }
      const pTipRing = new THREE.Mesh(rotorRingGeo, fpvBlurDiscMat);
      pTipRing.rotation.x = Math.PI / 2;
      pTipRing.scale.setScalar(0.24);
      spin.add(pTipRing);

      smokePos = new THREE.Vector3(0, altitude, -0.88);
      topY = altitude + 0.38;
      break;
    }

    // =========================================================================
    // 19. EW JAMMER DRONE (Air) — Dark-Titanium Hex-Wing UAV + Phased EW Radome & Halo
    // =========================================================================
    case "ewdrone": {
      altitude = 3.25;
      body.position.y = altitude;

      const ewTitanium = getChassisMat("#28323e", 0.34, 0.72);
      const ewSlate = getChassisMat("#3c4a58", 0.3, 0.68);
      const ewPurpleGlow = getGlowMat("#b45cff", 1.85);
      const ewCyanGlow = getGlowMat(CORE_GLOW, 1.75);

      // Sleek dark-titanium hex-wing electronic warfare UAV airframe (ExtrudeGeometry)
      add(mesh(geoEwDroneWing, ewTitanium), 0, 0, 0);

      // Faceted hexagonal dorsal avionics hump & satin faction spine trim
      add(rbox(0.42, 0.13, 0.96, ewSlate, 0.045), 0, 0.085, 0.02);
      add(rbox(0.18, 0.05, 0.78, accent, 0.02), 0, 0.155, -0.02);

      // Flush dark-glass forward EW optical visor + glowing purple-cyan spectrum strips
      const ewVisor = rbox(0.28, 0.065, 0.22, getGlassMat("#7b5cff"), 0.02, false);
      ewVisor.rotation.x = 0.26;
      add(ewVisor, 0, 0.115, 0.44);

      // Twin dorsal EW blade dipole antennas + glowing purple-cyan wingtip emitter nodes
      for (const sx of [-1, 1]) {
        const ant = rbox(0.024, 0.22, 0.12, steel, 0.006);
        ant.rotation.z = sx * -0.24;
        add(ant, sx * 0.26, 0.18, -0.34);
        // Leading-edge faction & EW wing chevron
        const wBar = box(0.46, 0.09, 0.085, accent);
        wBar.rotation.y = sx * -0.58;
        add(wBar, sx * 0.58, 0.008, 0.18);
        // Wingtip EW jamming emitter pods
        add(rbox(0.065, 0.055, 0.34, gunm, 0.012), sx * 0.94, 0, -0.08);
        const tipGlow = sph(0.064, sx < 0 ? ewPurpleGlow : ewCyanGlow, false);
        add(tipGlow, sx * 0.94, 0, 0.11);
        pulse.push(tipGlow);
      }

      // Compact twin rear electric ducted thruster pods with cool cyan glow
      for (const sx of [-0.22, 0.22]) {
        const duct = cyl(0.11, 0.22, gunm);
        duct.rotation.x = Math.PI / 2;
        add(duct, sx, 0.01, -0.52);
        const jet = sph(0.072, ewCyanGlow, false);
        add(jet, sx, 0.01, -0.64);
        pulse.push(jet);
      }

      // Underslung glowing purple-cyan phased EW jammer radome
      add(cyl(0.36, 0.09, gunm), 0, -0.08, 0.04);
      const radomeCore = sph(0.28, ewPurpleGlow, false);
      radomeCore.scale.set(1.0, 0.56, 1.0);
      add(radomeCore, 0, -0.145, 0.04);
      pulse.push(radomeCore);
      const radomeRing = new THREE.Mesh(geoEwHaloInner, ewCyanGlow);
      radomeRing.scale.setScalar(0.36);
      add(radomeRing, 0, -0.115, 0.04);
      pulse.push(radomeRing);

      // Subtle rotating holographic purple-cyan jamming halo ring (`spin`, `spin2`, `pulse`)
      spin = new THREE.Group();
      spin.position.set(0, -0.13, 0.04);
      body.add(spin);
      const outerHalo = new THREE.Mesh(geoEwHaloOuter, ewHaloPurpleMat);
      spin.add(outerHalo);
      pulse.push(outerHalo);
      for (let i = 0; i < 3; i++) {
        const arc = new THREE.Mesh(geoEwHaloArc, ewHaloCyanMat);
        arc.rotation.y = (i * Math.PI * 2) / 3;
        spin.add(arc);
      }

      spin2 = new THREE.Group();
      spin2.position.set(0, -0.14, 0.04);
      body.add(spin2);
      const innerHalo = new THREE.Mesh(geoEwHaloInner, ewHaloCyanMat);
      spin2.add(innerHalo);
      pulse.push(innerHalo);

      smokePos = new THREE.Vector3(0, altitude, -0.62);
      topY = altitude + 0.48;
      break;
    }

    // =========================================================================
    // 20. SEA-BABY USV DRONE BOAT (Sea) — Stealth Wave-Piercing Kamikaze Boat + Per-Instance subMats
    // =========================================================================
    case "usv": {
      body.position.y = 0.04;

      const usvHullMat = getChassisMat("#1b222a", 0.46, 0.52);
      const usvDeckMat = getChassisMat("#27303a", 0.42, 0.56);
      const satWhite = getChassisMat("#e4ecf4", 0.36, 0.16);
      const crimsonFuse = getGlowMat(CRIMSON, 1.9);

      // Low-profile dark stealth wave-piercing USV hull (ExtrudeGeometry)
      add(mesh(geoUsvHull, usvHullMat), 0, 0.09, 0.04);
      // Low beveled armored deck hatch cover & subtle satin faction bow chevrons
      add(rbox(0.32, 0.055, 0.96, usvDeckMat, 0.018), 0, 0.18, -0.04);
      add(rbox(0.36, 0.032, 0.24, accent, 0.01), 0, 0.195, 0.28);
      add(box(0.11, 0.025, 0.42, accentDark), 0, 0.195, -0.26);

      // Flat white rectangular Starlink-style satcom dish mounted cleanly on aft deck!
      const satDish = rbox(0.24, 0.026, 0.32, satWhite, 0.008);
      satDish.rotation.x = -0.12;
      add(satDish, 0, 0.235, -0.24);
      add(cyl(0.042, 0.055, gunm), 0, 0.205, -0.24);

      // Tiny forward optical/FLIR turret mast
      add(cyl(0.032, 0.15, steel), 0, 0.275, 0.22);
      add(sph(0.095, gunm), 0, 0.365, 0.22);
      const flirEye = sph(0.045, getGlowMat(CORE_GLOW, 1.5), false);
      add(flirEye, 0, 0.365, 0.265);
      // Slim stern whip comms antenna
      add(cyl(0.014, 0.34, steel), 0.11, 0.34, -0.52);

      // Rear recessed stealth waterjet thruster housing
      const jet = cyl(0.11, 0.18, gunm);
      jet.rotation.x = Math.PI / 2;
      add(jet, 0, 0.085, -0.66);

      // Twin metallic bow contact-detonator impact horns + blinking red bow warhead fuse (`pulse`)!
      for (const sx of [-0.07, 0.07]) {
        const horn = cyl(0.018, 0.16, steel);
        horn.rotation.x = Math.PI / 2;
        horn.rotation.z = sx > 0 ? -0.18 : 0.18;
        add(horn, sx, 0.135, 0.94);
      }
      const bowFuse = sph(0.072, crimsonFuse, false);
      add(bowFuse, 0, 0.165, 0.82);
      pulse.push(bowFuse);

      // Per-instance cloned subMats for sleek low-visibility stealth translucency!
      const mats: THREE.Material[] = [];
      body.traverse((o) => {
        if (o instanceof THREE.Mesh && !Array.isArray(o.material)) {
          const cloned = (o.material as THREE.Material).clone();
          o.material = cloned;
          mats.push(cloned);
        }
      });
      subMats = mats;

      smokePos = new THREE.Vector3(0, 0.26, -0.45);
      topY = 0.62;
      break;
    }

    // =========================================================================
    // 21. A-10 WARTHOG (Air) — Broad Straight Wings, Twin Rear Turbofans, H-Tail & GAU-8 30mm
    // =========================================================================
    case "a10": {
      altitude = 3.1;
      body.position.y = altitude;

      const warthogGray = getChassisMat("#546270", 0.36, 0.58);
      const warthogDark = getChassisMat("#38434f", 0.42, 0.56);
      const maverickWhite = getChassisMat("#dce4ec", 0.34, 0.32);
      const hudGreen = getGlowMat(EMERALD, 1.35);
      const exhaustRingGlow = getGlowMat(AFTERBURN, 1.85);
      const exhaustCoreGlow = getGlowMat("#ffd86a", 1.95);

      // Sculpted armored Thunderbolt II fuselage + titanium cockpit tub & dorsal spine
      add(mesh(geoA10Fuselage, warthogGray), 0, 0.02, 0);
      add(rbox(0.32, 0.14, 0.78, warthogDark, 0.04), 0, 0.01, 0.42);
      add(rbox(0.18, 0.075, 0.94, accent, 0.025), 0, 0.145, -0.22);
      // Warthog nose shark-stripe / armored gun-bay nose collar
      add(rbox(0.24, 0.085, 0.22, accentBright, 0.02), 0, 0.015, 0.88);

      // Teardrop bubble glass cockpit canopy (`getGlassMat`) + armored flat windscreen + green HUD glint
      const canopyBubble = rbox(0.24, 0.17, 0.52, getGlassMat("#62d4ff"), 0.075, false);
      add(canopyBubble, 0, 0.185, 0.44);
      const windscreen = rbox(0.21, 0.12, 0.2, getGlassMat("#7ee2ff"), 0.03, false);
      windscreen.rotation.x = 0.36;
      add(windscreen, 0, 0.16, 0.72);
      add(box(0.25, 0.028, 0.032, gunm), 0, 0.23, 0.62);
      add(box(0.08, 0.045, 0.018, hudGreen, false), 0, 0.175, 0.69);

      // Prominent protruding nose GAU-8/A Avenger 30mm 7-barrel rotary gatling cannon!
      const gauHousing = cyl(0.115, 0.34, gunm);
      gauHousing.rotation.x = Math.PI / 2;
      add(gauHousing, 0, -0.08, 0.94);
      // Central core + 6-barrel rotary gatling cluster extending boldly forward past the nose
      const gauCore = cyl(0.036, 0.46, steel);
      gauCore.rotation.x = Math.PI / 2;
      add(gauCore, 0, -0.08, 1.18);
      for (let i = 0; i < 6; i++) {
        const ang = (i * Math.PI * 2) / 6;
        const barrel = cyl(0.022, 0.48, gunm);
        barrel.rotation.x = Math.PI / 2;
        add(barrel, Math.cos(ang) * 0.036, -0.08 + Math.sin(ang) * 0.036, 1.19);
      }
      // Twin muzzle barrel-clamp rings
      for (const cz of [1.14, 1.36]) {
        const clampRing = cyl(0.098, 0.035, steel);
        clampRing.rotation.x = Math.PI / 2;
        add(clampRing, 0, -0.08, cz);
      }

      // Broad straight low-mounted A-10 wings (`geoA10Wing`)
      add(mesh(geoA10Wing, warthogGray), 0, -0.055, 0.08);
      // Wing-root fairing fillets & upper faction identification bands
      for (const sx of [-1, 1]) {
        add(box(0.36, 0.085, 0.42, accent), sx * 0.88, -0.045, 0.08);

        // Iconic upturned wingtips + port/starboard nav strobes
        const wingtip = rbox(0.24, 0.046, 0.36, warthogDark, 0.014);
        wingtip.rotation.z = sx * 0.56;
        add(wingtip, sx * 1.31, 0.015, 0.08);
        const tipNav = sph(0.055, getGlowMat(sx < 0 ? CRIMSON : EMERALD, 1.45), false);
        add(tipNav, sx * 1.42, 0.08, 0.14);
        pulse.push(tipNav);

        // Distinctive forward-jutting A-10 main landing-gear fairing pods on wing leading edge
        const lgPod = cyl(0.105, 0.42, warthogDark, true);
        lgPod.rotation.x = Math.PI / 2;
        add(lgPod, sx * 0.42, -0.085, 0.24);
        const lgCap = sph(0.105, gunm);
        add(lgCap, sx * 0.42, -0.085, 0.45);

        // Underwing Maverick missile racks (inboard AGM-65 pair + outboard Maverick + ECM pod)
        for (const [px, hasRack] of [
          [0.64, true],
          [0.92, false],
        ] as [number, boolean][]) {
          // Wing pylon strut
          add(box(0.035, 0.12, 0.26, gunm), sx * px, -0.125, 0.06);
          if (hasRack) {
            add(box(0.14, 0.025, 0.2, steel), sx * px, -0.18, 0.06);
            for (const mx of [-0.052, 0.052]) {
              const mav = cyl(0.052, 0.44, maverickWhite);
              mav.rotation.x = Math.PI / 2;
              add(mav, sx * px + mx, -0.215, 0.08);
              const seeker = sph(0.05, gunm);
              add(seeker, sx * px + mx, -0.215, 0.3);
            }
          } else {
            const mav = cyl(0.054, 0.46, maverickWhite);
            mav.rotation.x = Math.PI / 2;
            add(mav, sx * px, -0.205, 0.08);
            const seeker = cone(0.052, 0.11, getGlowMat(ORE_GLOW, 1.25), false);
            seeker.rotation.x = Math.PI / 2;
            add(seeker, sx * px, -0.205, 0.34);
          }
        }
        // Far outboard ECM self-protection pod
        const ecm = cyl(0.062, 0.36, gunm);
        ecm.rotation.x = Math.PI / 2;
        add(ecm, sx * 1.12, -0.135, 0.04);

        // Twin rear fuselage-mounted high-bypass TF34 turbofan engine pods!
        const engPylon = rbox(0.24, 0.055, 0.26, warthogDark, 0.014);
        engPylon.rotation.z = sx * 0.28;
        add(engPylon, sx * 0.19, 0.15, -0.46);

        add(mesh(geoA10EnginePod, hullLt), sx * 0.33, 0.21, -0.48);
        // Faction intake band + dark turbofan throat + bright steel fan spinner
        const cowlBand = cyl(0.305, 0.11, accent);
        cowlBand.rotation.x = Math.PI / 2;
        add(cowlBand, sx * 0.33, 0.21, -0.32);
        const intakeDisc = cyl(0.23, 0.03, gunm);
        intakeDisc.rotation.x = Math.PI / 2;
        add(intakeDisc, sx * 0.33, 0.21, -0.17);
        const spinner = cone(0.085, 0.11, steel);
        spinner.rotation.x = Math.PI / 2;
        add(spinner, sx * 0.33, 0.21, -0.12);

        // Glowing rear turbofan exhaust rings (`pulse`) + inner hot exhaust cone
        const exhRing = mesh(geoA10ExhaustRing, exhaustRingGlow, false, false);
        add(exhRing, sx * 0.33, 0.21, -0.83);
        pulse.push(exhRing);
        const exhCore = cone(0.11, 0.34, exhaustCoreGlow, false);
        exhCore.rotation.x = -Math.PI / 2;
        add(exhCore, sx * 0.33, 0.21, -0.96);
        pulse.push(exhCore);
      }

      // Iconic H-Tail Horizontal Stabilizer + Twin Outboard Vertical Tail Fins!
      add(rbox(1.06, 0.048, 0.34, warthogGray, 0.015), 0, 0.06, -0.98);
      for (const sx of [-1, 1]) {
        const vFin = mesh(geoA10TailFin, warthogGray);
        add(vFin, sx * 0.54, 0.19, -0.98);
        // Bold faction rudder stripe on twin outboard tail fins
        add(box(0.048, 0.14, 0.34, accent), sx * 0.54, 0.29, -1.0);
      }

      smokePos = new THREE.Vector3(0, altitude + 0.18, -0.88);
      topY = altitude + 0.64;
      break;
    }

    // =========================================================================
    // 22. AC-130 SPECTRE GUNSHIP (Air) — 4-Turboprop Heavy Gunship + Port 105mm/40mm/25mm + FLIR
    // =========================================================================
    case "ac130": {
      altitude = 3.85;
      body.position.y = altitude;

      const spectreSlate = getChassisMat("#303a46", 0.42, 0.54);
      const spectreDark = getChassisMat("#202730", 0.46, 0.58);
      const spectreLt = getChassisMat("#4c5968", 0.36, 0.6);
      const propTipYel = getChassisMat(CRANE_YEL, 0.4, 0.3);
      const flirGlow = getGlowMat(CORE_GLOW, 1.85);
      const muzzleHotGlow = getGlowMat(ORE_GLOW, 1.5);

      // Long cylindrical C-130 Hercules transport fuselage (LatheGeometry)
      add(mesh(geoAc130Fuselage, spectreSlate), 0, 0, 0);
      // Lower twin armored main-landing-gear cheek sponsons & bold dorsal faction spine
      for (const sx of [-1, 1]) {
        add(rbox(0.14, 0.18, 1.18, spectreDark, 0.04), sx * 0.24, -0.13, -0.02);
      }
      add(rbox(0.2, 0.065, 1.66, accent, 0.025), 0, 0.255, -0.1);
      // Black weather-radar nose dome cap
      const radome = sph(0.32, gunm);
      radome.scale.set(0.92, 0.88, 1.12);
      add(radome, 0, -0.01, 1.24);

      // Multi-pane glossy glass flight-deck nose windshield (`getGlassMat`) + cockpit brow
      add(rbox(0.38, 0.13, 0.32, spectreLt, 0.04), 0, 0.14, 0.94);
      const flightDeckGlass = rbox(0.39, 0.11, 0.22, getGlassMat("#66d4ff"), 0.028, false);
      flightDeckGlass.rotation.x = 0.24;
      add(flightDeckGlass, 0, 0.13, 1.07);
      // Center windshield mullion post + dorsal satcom dome
      add(box(0.032, 0.115, 0.04, gunm), 0, 0.13, 1.16);
      add(rbox(0.24, 0.08, 0.38, spectreLt, 0.03), 0, 0.3, 0.56);

      // Wide high-mounted straight C-130 wings (`geoAc130Wing`)
      add(mesh(geoAc130Wing, spectreSlate), 0, 0.21, 0.1);
      // Center wingbox fairing & faction wing stripes + underwing fuel pods + wingtip nav beacons
      add(rbox(0.68, 0.11, 0.58, spectreLt, 0.035), 0, 0.25, 0.1);
      for (const sx of [-1, 1]) {
        add(box(0.42, 0.105, 0.36, accent), sx * 1.46, 0.21, 0.08);
        // Underwing external fuel tank between inboard & outboard turboprops
        const fuelTank = cyl(0.11, 0.62, spectreDark, true);
        fuelTank.rotation.x = Math.PI / 2;
        add(fuelTank, sx * 0.84, 0.06, 0.14);
        const nav = sph(0.065, getGlowMat(sx < 0 ? CRIMSON : EMERALD, 1.5), false);
        add(nav, sx * 1.83, 0.21, 0.12);
        pulse.push(nav);
      }

      // 4 High-Power Turboprop Engine Nacelles + 4 Spinning 4-Blade Propellers (`spin` & `spin2`)
      spin = new THREE.Group();
      body.add(spin);
      spin2 = new THREE.Group();
      body.add(spin2);

      const propMat = getChassisMat("#1b2128", 0.42, 0.58);
      for (const px of [-1.14, -0.58, 0.58, 1.14]) {
        const fwdZ = Math.abs(px) < 0.8 ? 0.3 : 0.24;
        // Streamlined Allison T56 turboprop nacelle + chin air-intake scoop + exhaust shroud
        add(rbox(0.17, 0.18, 0.62, spectreDark, 0.045), px, 0.16, fwdZ);
        add(rbox(0.12, 0.085, 0.24, gunm, 0.02), px, 0.075, fwdZ + 0.16);
        add(box(0.185, 0.055, 0.14, accent), px, 0.17, fwdZ + 0.06);

        // Spinning 4-blade turboprop hub (`spin` = port props, `spin2` = starboard props)
        const propHub = new THREE.Group();
        propHub.position.set(px, 0.16, fwdZ + 0.35);
        if (px < 0) spin.add(propHub);
        else spin2.add(propHub);

        const noseCone = cone(0.11, 0.18, steel);
        noseCone.rotation.x = Math.PI / 2;
        propHub.add(noseCone);

        for (let b = 0; b < 4; b++) {
          const ang = (b * Math.PI) / 2;
          const blade = box(0.048, 0.26, 0.016, propMat);
          blade.position.set(-Math.sin(ang) * 0.13, Math.cos(ang) * 0.13, 0);
          blade.rotation.z = ang;
          propHub.add(blade);
          const tip = box(0.052, 0.075, 0.018, propTipYel);
          tip.position.set(-Math.sin(ang) * 0.24, Math.cos(ang) * 0.24, 0);
          tip.rotation.z = ang;
          propHub.add(tip);
        }

        // Translucent vertical motion-blur prop disc + yellow caution rim
        const disc = new THREE.Mesh(geoPropBlurDisc, rotorDiscMat);
        disc.position.z = -0.01;
        propHub.add(disc);
        const rim = new THREE.Mesh(geoPropBlurRing, rotorRingMat);
        rim.position.z = -0.008;
        propHub.add(rim);
      }

      // Commanding High T-Tail Vertical Stabilizer Fin + High-Mounted Broad Tailplane
      add(mesh(geoAc130TailFin, spectreSlate), 0, 0.52, -1.16);
      add(box(0.075, 0.2, 0.38, accent), 0, 0.72, -1.24);
      // High T-tail horizontal stabilizer perched cleanly near top of vertical fin
      add(rbox(1.28, 0.055, 0.34, spectreLt, 0.018), 0, 0.88, -1.26);
      add(box(0.32, 0.062, 0.24, accent), -0.46, 0.88, -1.26);
      add(box(0.32, 0.062, 0.24, accent), 0.46, 0.88, -1.26);
      // Top tail anti-collision crimson beacon (`pulse`)
      const tailBeacon = sph(0.072, getGlowMat(CRIMSON, 1.75), false);
      add(tailBeacon, 0, 0.96, -1.26);
      pulse.push(tailBeacon);

      // 3 Prominent Port-Side (+X) Protruding Heavy Gun Barrels (angled slightly down for pylon attack!)
      const gunTiltZ = -0.26; // barrel slopes downward outward from +X fuselage wall
      // 1. 105mm M102 Howitzer (aft gun bay — thickest, longest heavy artillery cannon!)
      add(rbox(0.22, 0.2, 0.32, spectreDark, 0.03), 0.25, -0.07, -0.48);
      const how105 = cyl(0.092, 0.68, gunm);
      how105.rotation.z = Math.PI / 2 + gunTiltZ;
      add(how105, 0.52, -0.14, -0.48);
      const howBrake = cyl(0.118, 0.09, steel);
      howBrake.rotation.z = Math.PI / 2 + gunTiltZ;
      add(howBrake, 0.82, -0.22, -0.48);
      const howGlow = sph(0.052, muzzleHotGlow, false);
      add(howGlow, 0.87, -0.235, -0.48);
      pulse.push(howGlow);

      // 2. 40mm L/60 Bofors Autocannon (mid gun bay — sleek tapered barrel + conical flash hider)
      add(rbox(0.18, 0.16, 0.24, spectreDark, 0.025), 0.25, -0.07, -0.04);
      const bofors40 = cyl(0.058, 0.56, steel, true);
      bofors40.rotation.z = Math.PI / 2 + gunTiltZ;
      add(bofors40, 0.48, -0.13, -0.04);
      const boforsFlash = cone(0.076, 0.11, gunm);
      boforsFlash.rotation.z = Math.PI / 2 + gunTiltZ;
      add(boforsFlash, 0.74, -0.2, -0.04);

      // 3. 25mm GAU-12 Equalizer Rotary Gatling (forward gun bay — multi-barrel cluster)
      add(rbox(0.16, 0.14, 0.22, gunm, 0.025), 0.25, -0.06, 0.38);
      for (const [oy, oz] of [
        [-0.02, -0.02],
        [0.02, -0.02],
        [0, 0.022],
      ]) {
        const g25 = cyl(0.024, 0.42, steel);
        g25.rotation.z = Math.PI / 2 + gunTiltZ;
        add(g25, 0.44, -0.11 + oy, 0.38 + oz);
      }
      const g25Clamp = cyl(0.064, 0.036, gunm);
      g25Clamp.rotation.z = Math.PI / 2 + gunTiltZ;
      add(g25Clamp, 0.6, -0.155, 0.38);

      // Glowing Ventral FLIR / Infrared Targeting Ball (`pulse`) + Secondary Sensor Gimbal!
      add(cyl(0.085, 0.12, gunm), 0.06, -0.26, 0.78);
      add(sph(0.19, spectreDark), 0.06, -0.34, 0.78);
      const flirLens = sph(0.105, flirGlow, false);
      add(flirLens, 0.13, -0.36, 0.84);
      pulse.push(flirLens);
      const flirRing = mesh(geoA10ExhaustRing, flirGlow, false, false);
      flirRing.rotation.x = Math.PI / 2;
      flirRing.scale.setScalar(0.82);
      add(flirRing, 0.06, -0.35, 0.78);
      pulse.push(flirRing);

      smokePos = new THREE.Vector3(0, altitude + 0.12, -1.24);
      topY = altitude + 1.06;
      break;
    }

    default:
      return null;
  }

  for (const p of pulse) {
    p.userData.baseScale = p.scale.clone();
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
