import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { TICK_MS, UNITS, EntKind, UnitKind, UnitDomain } from "../shared/gamedefs";
import type { GameEvent } from "../shared/protocol";
import { GameScene } from "./scene";
import { Renderer } from "./render";
import { Net } from "./net";
import { getChassisMat, getAccentMat, getGlassMat, getGlowMat } from "./textures";
import { isBuildingKind } from "./util";
import { makeVmKit, type VmKit } from "./fpv/vmkit";
import { LAND_VM } from "./fpv/vm-land";
import { AIR_VM } from "./fpv/vm-air";
import { SEA_VM } from "./fpv/vm-sea";

export interface FpvTelemetry {
  id: number;
  kind: EntKind;
  domain: UnitDomain;
  hp: number;
  mhp: number;
  vet: number;
  fuel?: number;
  ammo?: number;
  speed: number;
  altitude: number;
  headingDeg: number;
  submerged: boolean;
  pointerLocked: boolean;
  reloading: number; // 0 = ready, 0..1 = cooldown fraction
  sprint: boolean; // Shift sprint/boost engaged
  alt: number; // normalized altitude 0..1 for driven aircraft (server-synced), else 0
  wpn: number; // selected weapon slot 0..2 on multi-weapon platforms
  wpnName: string; // display name of selected weapon system
  lockState: "none" | "locking" | "locked"; // missile/guided lock-on progress
  lockPct: number; // 0..1 lock acquisition progress
  crouch: boolean; // infantry crouch engaged
  target: {
    id: number;
    kind: EntKind;
    hp: number;
    mhp: number;
    dist: number;
    enemy: boolean;
    inRange: boolean;
  } | null;
  aimDist: number;
}

interface UnitCameraProfile {
  eyeY: number;
  subEyeY?: number;
  fov: number;
  initPitch: number;
  minPitch: number;
  maxPitch: number;
  bobAmp: number;
  bobFreq: number;
  strafeMode: "strafe" | "steer";
  turnRate: number;
  recoilKickZ: number;
  recoilPitch: number;
  recoilShake: number;
}

const DEFAULT_PROFILE: UnitCameraProfile = {
  eyeY: 1.0,
  fov: 68,
  initPitch: 0,
  minPitch: -0.5,
  maxPitch: 0.62,
  bobAmp: 0.02,
  bobFreq: 8,
  strafeMode: "steer",
  turnRate: 2.1,
  recoilKickZ: 0.08,
  recoilPitch: 0.025,
  recoilShake: 0.14,
};

const UNIT_PROFILES: Record<UnitKind, UnitCameraProfile> = {
  // Land Infantry
  infantry: {
    eyeY: 0.84,
    fov: 72,
    initPitch: 0,
    minPitch: -0.52,
    maxPitch: 0.65,
    bobAmp: 0.032,
    bobFreq: 11.5,
    strafeMode: "strafe",
    turnRate: 2.6,
    recoilKickZ: 0.055,
    recoilPitch: 0.022,
    recoilShake: 0.08,
  },
  engineer: {
    eyeY: 0.8,
    fov: 72,
    initPitch: 0,
    minPitch: -0.52,
    maxPitch: 0.65,
    bobAmp: 0.03,
    bobFreq: 11,
    strafeMode: "strafe",
    turnRate: 2.6,
    recoilKickZ: 0.03,
    recoilPitch: 0.01,
    recoilShake: 0.05,
  },
  rocket: {
    eyeY: 0.9,
    fov: 70,
    initPitch: 0,
    minPitch: -0.52,
    maxPitch: 0.65,
    bobAmp: 0.028,
    bobFreq: 10.5,
    strafeMode: "strafe",
    turnRate: 2.5,
    recoilKickZ: 0.11,
    recoilPitch: 0.045,
    recoilShake: 0.2,
  },
  fpvdrone: {
    eyeY: 2.65,
    fov: 88,
    initPitch: -0.24,
    minPitch: -1.25,
    maxPitch: 0.78,
    bobAmp: 0.016,
    bobFreq: 9.5,
    strafeMode: "strafe",
    turnRate: 3.1,
    recoilKickZ: 0.14,
    recoilPitch: 0.05,
    recoilShake: 0.35,
  },
  // Land Vehicles
  tank: {
    eyeY: 1.08,
    fov: 68,
    initPitch: -0.02,
    minPitch: -0.46,
    maxPitch: 0.58,
    bobAmp: 0.012,
    bobFreq: 14,
    strafeMode: "steer",
    turnRate: 2.1,
    recoilKickZ: 0.14,
    recoilPitch: 0.038,
    recoilShake: 0.24,
  },
  arty: {
    eyeY: 1.24,
    fov: 66,
    initPitch: 0.04,
    minPitch: -0.42,
    maxPitch: 0.64,
    bobAmp: 0.01,
    bobFreq: 11,
    strafeMode: "steer",
    turnRate: 1.65,
    recoilKickZ: 0.13,
    recoilPitch: 0.05,
    recoilShake: 0.3,
  },
  heavy: {
    eyeY: 1.38,
    fov: 66,
    initPitch: -0.03,
    minPitch: -0.46,
    maxPitch: 0.56,
    bobAmp: 0.014,
    bobFreq: 12,
    strafeMode: "steer",
    turnRate: 1.75,
    recoilKickZ: 0.16,
    recoilPitch: 0.046,
    recoilShake: 0.34,
  },
  spider: {
    eyeY: 0.56,
    fov: 78,
    initPitch: 0,
    minPitch: -0.5,
    maxPitch: 0.65,
    bobAmp: 0.024,
    bobFreq: 19,
    strafeMode: "strafe",
    turnRate: 3.1,
    recoilKickZ: 0.075,
    recoilPitch: 0.02,
    recoilShake: 0.1,
  },
  himars: {
    eyeY: 1.32,
    fov: 68,
    initPitch: 0.02,
    minPitch: -0.42,
    maxPitch: 0.66,
    bobAmp: 0.011,
    bobFreq: 11.5,
    strafeMode: "steer",
    turnRate: 1.85,
    recoilKickZ: 0.12,
    recoilPitch: 0.044,
    recoilShake: 0.28,
  },
  railtank: {
    eyeY: 1.36,
    fov: 66,
    initPitch: -0.02,
    minPitch: -0.46,
    maxPitch: 0.6,
    bobAmp: 0.013,
    bobFreq: 12.5,
    strafeMode: "steer",
    turnRate: 1.85,
    recoilKickZ: 0.17,
    recoilPitch: 0.042,
    recoilShake: 0.34,
  },
  supplytruck: {
    eyeY: 1.18,
    fov: 70,
    initPitch: -0.04,
    minPitch: -0.48,
    maxPitch: 0.56,
    bobAmp: 0.013,
    bobFreq: 11.5,
    strafeMode: "steer",
    turnRate: 1.95,
    recoilKickZ: 0.025,
    recoilPitch: 0.008,
    recoilShake: 0.05,
  },
  harvester: {
    eyeY: 1.22,
    fov: 68,
    initPitch: -0.06,
    minPitch: -0.48,
    maxPitch: 0.52,
    bobAmp: 0.014,
    bobFreq: 10,
    strafeMode: "steer",
    turnRate: 1.7,
    recoilKickZ: 0.03,
    recoilPitch: 0.01,
    recoilShake: 0.06,
  },
  // Air Force
  uav: {
    eyeY: 3.15,
    fov: 76,
    initPitch: -0.24,
    minPitch: -1.1,
    maxPitch: 0.72,
    bobAmp: 0.014,
    bobFreq: 5.0,
    strafeMode: "steer",
    turnRate: 2.7,
    recoilKickZ: 0.045,
    recoilPitch: 0.014,
    recoilShake: 0.09,
  },
  shahed: {
    eyeY: 3.15,
    fov: 78,
    initPitch: -0.24,
    minPitch: -1.18,
    maxPitch: 0.74,
    bobAmp: 0.012,
    bobFreq: 6.2,
    strafeMode: "steer",
    turnRate: 2.35,
    recoilKickZ: 0.12,
    recoilPitch: 0.04,
    recoilShake: 0.32,
  },
  ewdrone: {
    eyeY: 3.25,
    fov: 76,
    initPitch: -0.24,
    minPitch: -1.1,
    maxPitch: 0.74,
    bobAmp: 0.014,
    bobFreq: 4.4,
    strafeMode: "strafe",
    turnRate: 2.45,
    recoilKickZ: 0.03,
    recoilPitch: 0.01,
    recoilShake: 0.06,
  },
  interceptor: {
    eyeY: 3.42,
    fov: 78,
    initPitch: -0.22,
    minPitch: -1.05,
    maxPitch: 0.78,
    bobAmp: 0.018,
    bobFreq: 5.5,
    strafeMode: "steer",
    turnRate: 2.5,
    recoilKickZ: 0.06,
    recoilPitch: 0.016,
    recoilShake: 0.12,
  },
  chopper: {
    eyeY: 3.04,
    fov: 72,
    initPitch: -0.22,
    minPitch: -1.05,
    maxPitch: 0.78,
    bobAmp: 0.024,
    bobFreq: 4.2,
    strafeMode: "strafe",
    turnRate: 2.4,
    recoilKickZ: 0.065,
    recoilPitch: 0.018,
    recoilShake: 0.14,
  },
  a10: {
    eyeY: 3.18,
    fov: 76,
    initPitch: -0.24,
    minPitch: -1.12,
    maxPitch: 0.78,
    bobAmp: 0.016,
    bobFreq: 5.4,
    strafeMode: "steer",
    turnRate: 2.35,
    recoilKickZ: 0.055,
    recoilPitch: 0.016,
    recoilShake: 0.17,
  },
  ac130: {
    eyeY: 3.92,
    fov: 64,
    initPitch: -0.34,
    minPitch: -1.22,
    maxPitch: 0.58,
    bobAmp: 0.011,
    bobFreq: 2.6,
    strafeMode: "strafe",
    turnRate: 1.55,
    recoilKickZ: 0.135,
    recoilPitch: 0.036,
    recoilShake: 0.3,
  },
  bomber: {
    eyeY: 3.6,
    fov: 72,
    initPitch: -0.25,
    minPitch: -1.05,
    maxPitch: 0.75,
    bobAmp: 0.016,
    bobFreq: 3.6,
    strafeMode: "steer",
    turnRate: 1.9,
    recoilKickZ: 0.09,
    recoilPitch: 0.026,
    recoilShake: 0.24,
  },
  stealthbomber: {
    eyeY: 3.68,
    fov: 70,
    initPitch: -0.24,
    minPitch: -1.05,
    maxPitch: 0.74,
    bobAmp: 0.012,
    bobFreq: 3.4,
    strafeMode: "steer",
    turnRate: 2.0,
    recoilKickZ: 0.085,
    recoilPitch: 0.024,
    recoilShake: 0.22,
  },
  hypersonic: {
    eyeY: 3.68,
    fov: 88,
    initPitch: -0.28,
    minPitch: -1.28,
    maxPitch: 0.78,
    bobAmp: 0.016,
    bobFreq: 8.6,
    strafeMode: "steer",
    turnRate: 2.65,
    recoilKickZ: 0.15,
    recoilPitch: 0.048,
    recoilShake: 0.36,
  },
  zeppelin: {
    eyeY: 3.78,
    fov: 70,
    initPitch: -0.26,
    minPitch: -1.05,
    maxPitch: 0.72,
    bobAmp: 0.02,
    bobFreq: 2.4,
    strafeMode: "strafe",
    turnRate: 1.4,
    recoilKickZ: 0.08,
    recoilPitch: 0.024,
    recoilShake: 0.28,
  },
  // Navy
  usv: {
    eyeY: 0.42,
    fov: 80,
    initPitch: -0.02,
    minPitch: -0.38,
    maxPitch: 0.58,
    bobAmp: 0.026,
    bobFreq: 6.8,
    strafeMode: "steer",
    turnRate: 2.75,
    recoilKickZ: 0.14,
    recoilPitch: 0.04,
    recoilShake: 0.32,
  },
  gunboat: {
    eyeY: 0.98,
    fov: 72,
    initPitch: -0.02,
    minPitch: -0.45,
    maxPitch: 0.62,
    bobAmp: 0.022,
    bobFreq: 4.5,
    strafeMode: "steer",
    turnRate: 2.4,
    recoilKickZ: 0.075,
    recoilPitch: 0.02,
    recoilShake: 0.12,
  },
  destroyer: {
    eyeY: 1.44,
    fov: 68,
    initPitch: -0.03,
    minPitch: -0.45,
    maxPitch: 0.6,
    bobAmp: 0.024,
    bobFreq: 2.8,
    strafeMode: "steer",
    turnRate: 1.75,
    recoilKickZ: 0.12,
    recoilPitch: 0.032,
    recoilShake: 0.22,
  },
  sub: {
    eyeY: 0.92,
    subEyeY: 0.5,
    fov: 62,
    initPitch: 0,
    minPitch: -0.42,
    maxPitch: 0.55,
    bobAmp: 0.018,
    bobFreq: 2.4,
    strafeMode: "steer",
    turnRate: 1.85,
    recoilKickZ: 0.07,
    recoilPitch: 0.02,
    recoilShake: 0.16,
  },
  dreadnought: {
    eyeY: 1.72,
    fov: 66,
    initPitch: -0.03,
    minPitch: -0.45,
    maxPitch: 0.62,
    bobAmp: 0.026,
    bobFreq: 2.1,
    strafeMode: "steer",
    turnRate: 1.35,
    recoilKickZ: 0.14,
    recoilPitch: 0.044,
    recoilShake: 0.34,
  },
  carrier: {
    eyeY: 2.05,
    fov: 68,
    initPitch: -0.05,
    minPitch: -0.48,
    maxPitch: 0.62,
    bobAmp: 0.02,
    bobFreq: 1.8,
    strafeMode: "steer",
    turnRate: 1.25,
    recoilKickZ: 0.085,
    recoilPitch: 0.024,
    recoilShake: 0.2,
  },
};

interface ViewmodelRig {
  root: THREE.Group;
  swayGroup: THREE.Group;
  recoilGroup: THREE.Group;
  keyLight: THREE.PointLight;
  muzzleFlashes: THREE.Mesh[];
  spinners: { obj: THREE.Object3D; axis: "x" | "y" | "z"; speed: number }[];
  glowPulses: THREE.Mesh[];
  supplyBar?: { mesh: THREE.Mesh; baseX: number; halfW: number };
  geometries: THREE.BufferGeometry[];
  uniqueMaterials: THREE.Material[];
}

const CENTER_NDC = new THREE.Vector2(0, 0);
const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const MOUSE_SENS = 0.0024;
const DRIVE_SEND_INTERVAL_MS = 55;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function wrapAngle(a: number): number {
  let r = ((((a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
  if (r <= -Math.PI) r += Math.PI * 2;
  return r;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!target) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return false;
}

// ---------- Sculpted 3D Camera-Attached Weapon & Cockpit Viewmodels ----------

// Per-domain viewmodel overrides live in fpv/vm-{land,air,sea}.ts — when a kind
// has an upgraded builder registered it fully replaces the legacy branch below.
const VM_OVERRIDES: Partial<Record<UnitKind, (kit: VmKit) => void>> = {
  ...LAND_VM,
  ...AIR_VM,
  ...SEA_VM,
};

function buildViewmodel(kind: UnitKind, factionColor: string): ViewmodelRig {
  const override = VM_OVERRIDES[kind];
  if (override) {
    const kit = makeVmKit(factionColor);
    override(kit);
    return kit.rig;
  }

  const root = new THREE.Group();
  const swayGroup = new THREE.Group();
  const recoilGroup = new THREE.Group();
  root.add(swayGroup);
  swayGroup.add(recoilGroup);

  // Dedicated 1P weapon & cockpit key fill light so PBR metals & rims gleam even when facing away from sun
  const keyLight = new THREE.PointLight(0xdceeff, 1.35, 3.2, 1.5);
  keyLight.position.set(0.3, 0.34, 0.14);
  keyLight.castShadow = false;
  root.add(keyLight);

  const geometries: THREE.BufferGeometry[] = [];
  const uniqueMaterials: THREE.Material[] = [];
  const muzzleFlashes: THREE.Mesh[] = [];
  const spinners: { obj: THREE.Object3D; axis: "x" | "y" | "z"; speed: number }[] = [];
  const glowPulses: THREE.Mesh[] = [];
  let supplyBar: ViewmodelRig["supplyBar"];

  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    geometries.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    uniqueMaterials.push(m);
    return m;
  };

  // Shared PBR material palette (cached in textures.ts — do not dispose these!)
  const darkMetal = getChassisMat("#262d36", 0.36, 0.78);
  const gunMetal = getChassisMat("#38424e", 0.34, 0.72);
  const lightAlloy = getChassisMat("#647282", 0.32, 0.68);
  const cockpitTrim = getChassisMat("#1b2128", 0.48, 0.6);
  const factionMat = getAccentMat(factionColor);
  const glassCyan = getGlassMat("#64e4ff");
  const glassTint = getGlassMat("#2b6a7a");
  const cyanGlow = getGlowMat("#38f2ff", 1.6);
  const amberGlow = getGlowMat("#ffae2b", 1.55);
  const redGlow = getGlowMat("#ff3d2e", 1.6);
  const greenGlow = getGlowMat("#3cf084", 1.45);
  const brassMat = getChassisMat("#9f8048", 0.34, 0.8);

  const addPart = (
    parent: THREE.Object3D,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
  ): THREE.Mesh => {
    trackGeo(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    parent.add(mesh);
    return mesh;
  };

  const addMuzzleFlash = (parent: THREE.Object3D, x: number, y: number, z: number, scale = 1, colorHex = 0xffc64a) => {
    const flashMat = trackMat(
      new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    const coreGeo = trackGeo(new THREE.OctahedronGeometry(0.055 * scale, 0));
    coreGeo.scale(1, 1, 2.3);
    const flash = new THREE.Mesh(coreGeo, flashMat);
    flash.position.set(x, y, z);
    flash.visible = false;
    flash.frustumCulled = false;
    parent.add(flash);
    muzzleFlashes.push(flash);
    return flash;
  };

  // Helper: peripheral armored gunner viewport bezel (keeps center clear)
  const addGunnerCowl = (topY = 0.34, botY = -0.33, accentHex = "#38f2ff", withRangefinder = false) => {
    const ledMat = getGlowMat(accentHex, 1.5);
    // Upper armored brow
    addPart(swayGroup, new RoundedBoxGeometry(1.06, 0.07, 0.14, 2, 0.012), cockpitTrim, 0, topY, -0.44, 0.18, 0, 0);
    // Angled side visor cheeks
    addPart(swayGroup, new RoundedBoxGeometry(0.08, 0.36, 0.14, 2, 0.012), cockpitTrim, -0.52, 0.04, -0.44, 0, 0.24, -0.14);
    addPart(swayGroup, new RoundedBoxGeometry(0.08, 0.36, 0.14, 2, 0.012), cockpitTrim, 0.52, 0.04, -0.44, 0, -0.24, 0.14);
    // Lower armored dash lip
    addPart(swayGroup, new RoundedBoxGeometry(1.08, 0.085, 0.16, 2, 0.014), cockpitTrim, 0, botY, -0.44, -0.22, 0, 0);
    // Faction stripes on dash corners
    addPart(swayGroup, new RoundedBoxGeometry(0.18, 0.022, 0.03, 1, 0.004), factionMat, -0.34, botY + 0.04, -0.41, -0.22, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.18, 0.022, 0.03, 1, 0.004), factionMat, 0.34, botY + 0.04, -0.41, -0.22, 0, 0);
    // Corner tactical LEDs
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.032, 0.01, 0.01), ledMat, -0.42, topY - 0.025, -0.38),
      addPart(swayGroup, new THREE.BoxGeometry(0.032, 0.01, 0.01), ledMat, 0.42, topY - 0.025, -0.38),
    );

    if (withRangefinder) {
      // Sleek subtle green/cyan illuminated ballistic rangefinder bezel on armored viewport dashboard
      const rfY = botY + 0.052;
      const rfZ = -0.415;
      addPart(swayGroup, new RoundedBoxGeometry(0.25, 0.044, 0.03, 2, 0.006), darkMetal, 0, rfY, rfZ, -0.34, 0, 0);
      addPart(swayGroup, new THREE.BoxGeometry(0.215, 0.028, 0.006), glassTint, 0, rfY + 0.002, rfZ + 0.014, -0.34, 0, 0);
      // Glowing green & cyan ballistic rangefinder readout bars + elevation tick pips
      glowPulses.push(
        addPart(swayGroup, new THREE.BoxGeometry(0.085, 0.006, 0.005), greenGlow, -0.045, rfY + 0.006, rfZ + 0.018, -0.34, 0, 0),
        addPart(swayGroup, new THREE.BoxGeometry(0.068, 0.006, 0.005), cyanGlow, 0.052, rfY + 0.006, rfZ + 0.018, -0.34, 0, 0),
      );
      for (const tx of [-0.082, -0.042, 0, 0.042, 0.082]) {
        addPart(
          swayGroup,
          new THREE.BoxGeometry(tx === 0 ? 0.014 : 0.007, 0.005, 0.005),
          tx === 0 ? cyanGlow : greenGlow,
          tx,
          rfY - 0.005,
          rfZ + 0.019,
          -0.34,
          0,
          0,
        );
      }
    }
  };

  // Helper: sleek angled aircraft canopy struts + avionics dashboard + holographic HUD combiner
  const addAircraftCanopy = (wide: boolean, heavy = false) => {
    const xSpan = wide ? 0.52 : 0.46;
    const strutW = heavy ? 0.048 : 0.034;
    // Left & right slanted A-pillar canopy struts
    addPart(swayGroup, new RoundedBoxGeometry(strutW, 0.56, 0.06, 2, 0.008), cockpitTrim, -xSpan, 0.06, -0.45, -0.24, 0.25, -0.28);
    addPart(swayGroup, new RoundedBoxGeometry(strutW, 0.56, 0.06, 2, 0.008), cockpitTrim, xSpan, 0.06, -0.45, -0.24, -0.25, 0.28);
    // Upper canopy arch bar
    addPart(swayGroup, new RoundedBoxGeometry(xSpan * 1.78, strutW * 1.15, 0.06, 2, 0.008), cockpitTrim, 0, 0.34, -0.46, 0.16, 0, 0);
    // Faction trim strips along inner canopy struts
    addPart(swayGroup, new THREE.BoxGeometry(0.012, 0.22, 0.02), factionMat, -xSpan + 0.022, 0.02, -0.43, -0.24, 0.25, -0.28);
    addPart(swayGroup, new THREE.BoxGeometry(0.012, 0.22, 0.02), factionMat, xSpan - 0.022, 0.02, -0.43, -0.24, -0.25, 0.28);
    // Illuminated avionics instrument dashboard along lower edge
    addPart(swayGroup, new RoundedBoxGeometry(0.86, 0.115, 0.22, 2, 0.016), cockpitTrim, 0, -0.32, -0.48, -0.3, 0, 0);
    // Center, left & right MFD instrument bezels
    addPart(swayGroup, new RoundedBoxGeometry(0.28, 0.048, 0.022, 1, 0.004), gunMetal, 0, -0.265, -0.42, -0.42, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.15, 0.044, 0.02, 1, 0.004), darkMetal, -0.22, -0.278, -0.422, -0.32, 0.14, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.15, 0.044, 0.02, 1, 0.004), darkMetal, 0.22, -0.278, -0.422, -0.32, -0.14, 0);
    // Glowing avionics MFD strips (cyan attitude/telemetry, green twin engine thrust, amber weapons/radar)
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.125, 0.012, 0.008), cyanGlow, 0, -0.258, -0.408, -0.42, 0, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.09, 0.007, 0.008), greenGlow, 0, -0.274, -0.406, -0.42, 0, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.098, 0.012, 0.008), greenGlow, -0.22, -0.271, -0.41, -0.32, 0.14, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.072, 0.007, 0.008), cyanGlow, -0.22, -0.286, -0.408, -0.32, 0.14, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.098, 0.012, 0.008), amberGlow, 0.22, -0.271, -0.41, -0.32, -0.14, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.072, 0.007, 0.008), cyanGlow, 0.22, -0.286, -0.408, -0.32, -0.14, 0),
    );
    // Angled HUD combiner frame + translucent holographic glass reflector pane + glowing artificial-horizon bars
    addPart(swayGroup, new THREE.BoxGeometry(0.008, 0.105, 0.014), lightAlloy, -0.105, -0.205, -0.43, 0.18, 0, 0);
    addPart(swayGroup, new THREE.BoxGeometry(0.008, 0.105, 0.014), lightAlloy, 0.105, -0.205, -0.43, 0.18, 0, 0);
    addPart(swayGroup, new THREE.BoxGeometry(0.218, 0.007, 0.012), lightAlloy, 0, -0.155, -0.421, 0.18, 0, 0);
    const hudGlassMat = trackMat(
      new THREE.MeshBasicMaterial({
        color: 0x38f2ff,
        transparent: true,
        opacity: 0.14,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    const hudPane = addPart(swayGroup, new THREE.PlaneGeometry(0.198, 0.094), hudGlassMat, 0, -0.205, -0.428, 0.18, 0, 0);
    hudPane.renderOrder = 3;
    // Glowing artificial-horizon bars & pitch ladder on HUD reflector glass
    const hudBarMat = trackMat(
      new THREE.MeshBasicMaterial({
        color: 0x5af8ff,
        transparent: true,
        opacity: 0.78,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    // Split artificial-horizon wings + center chevron datum
    addPart(swayGroup, new THREE.BoxGeometry(0.052, 0.0032, 0.002), hudBarMat, -0.048, -0.202, -0.425, 0.18, 0, 0);
    addPart(swayGroup, new THREE.BoxGeometry(0.052, 0.0032, 0.002), hudBarMat, 0.048, -0.202, -0.425, 0.18, 0, 0);
    addPart(swayGroup, new THREE.BoxGeometry(0.016, 0.0032, 0.002), cyanGlow, 0, -0.202, -0.424, 0.18, 0, 0);
    // Upper & lower pitch-ladder ticks
    addPart(swayGroup, new THREE.BoxGeometry(0.032, 0.0024, 0.002), hudBarMat, -0.04, -0.182, -0.422, 0.18, 0, 0);
    addPart(swayGroup, new THREE.BoxGeometry(0.032, 0.0024, 0.002), hudBarMat, 0.04, -0.182, -0.422, 0.18, 0, 0);
    addPart(swayGroup, new THREE.BoxGeometry(0.032, 0.0024, 0.002), hudBarMat, -0.04, -0.222, -0.428, 0.18, 0, 0);
    addPart(swayGroup, new THREE.BoxGeometry(0.032, 0.0024, 0.002), hudBarMat, 0.04, -0.222, -0.428, 0.18, 0, 0);
  };

  if (kind === "infantry") {
    // Futuristic bullpup pulse rifle held lower-right with sculpted armored gloved hands & forearms
    const gun = new THREE.Group();
    gun.position.set(0.25, -0.23, -0.46);
    gun.rotation.set(0.02, 0.08, -0.03);
    recoilGroup.add(gun);

    const sleeveMat = getChassisMat("#1f2630", 0.58, 0.32);
    const gloveMat = getChassisMat("#151920", 0.44, 0.44);

    // Main sculpted receiver & bullpup stock
    addPart(gun, new RoundedBoxGeometry(0.072, 0.105, 0.44, 3, 0.012), darkMetal, 0, 0, 0.04);
    // Faction-colored side armor panels
    addPart(gun, new RoundedBoxGeometry(0.078, 0.042, 0.24, 2, 0.008), factionMat, 0, 0.012, 0.08);
    // Ventilated forward barrel shroud
    addPart(gun, new RoundedBoxGeometry(0.056, 0.072, 0.26, 2, 0.01), gunMetal, 0, 0.012, -0.26);
    // Rifled inner barrel + tactical compensator muzzle
    addPart(gun, new THREE.CylinderGeometry(0.014, 0.016, 0.22, 12), lightAlloy, 0, 0.016, -0.44, Math.PI / 2, 0, 0);
    addPart(gun, new THREE.CylinderGeometry(0.02, 0.018, 0.048, 8), darkMetal, 0, 0.016, -0.54, Math.PI / 2, 0, 0);
    // Angled foregrip, pistol grip & magazine well
    addPart(gun, new RoundedBoxGeometry(0.042, 0.095, 0.05, 2, 0.008), cockpitTrim, 0, -0.065, -0.18, 0.25, 0, 0);
    addPart(gun, new RoundedBoxGeometry(0.044, 0.095, 0.052, 2, 0.008), cockpitTrim, 0, -0.075, 0.035, -0.24, 0, 0);
    addPart(gun, new RoundedBoxGeometry(0.048, 0.11, 0.075, 2, 0.008), cockpitTrim, 0, -0.07, 0.16, -0.16, 0, 0);
    // Top Picatinny rail
    addPart(gun, new RoundedBoxGeometry(0.032, 0.014, 0.34, 1, 0.003), lightAlloy, 0, 0.058, -0.06);
    // Illuminated ammo counter LED strip bezel along left side of receiver
    addPart(gun, new RoundedBoxGeometry(0.014, 0.028, 0.095, 1, 0.003), cockpitTrim, -0.04, 0.024, -0.03);
    for (let seg = 0; seg < 4; seg++) {
      glowPulses.push(
        addPart(
          gun,
          new THREE.BoxGeometry(0.006, 0.013, 0.014),
          cyanGlow,
          -0.046,
          0.024,
          -0.062 + seg * 0.019,
        ),
      );
    }
    addPart(gun, new THREE.BoxGeometry(0.006, 0.008, 0.01), greenGlow, -0.046, 0.024, 0.011);

    // Holographic reflex sight housing + translucent lens + crisp glowing cyan cross-dot reticle
    addPart(gun, new RoundedBoxGeometry(0.052, 0.012, 0.078, 1, 0.003), darkMetal, 0, 0.068, -0.02);
    addPart(gun, new RoundedBoxGeometry(0.008, 0.042, 0.062, 1, 0.002), darkMetal, -0.022, 0.09, -0.02);
    addPart(gun, new RoundedBoxGeometry(0.008, 0.042, 0.062, 1, 0.002), darkMetal, 0.022, 0.09, -0.02);
    addPart(gun, new RoundedBoxGeometry(0.052, 0.008, 0.062, 1, 0.002), darkMetal, 0, 0.112, -0.02);
    const reflexGlassMat = trackMat(
      new THREE.MeshBasicMaterial({
        color: 0x3ce8ff,
        transparent: true,
        opacity: 0.18,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    addPart(gun, new THREE.PlaneGeometry(0.036, 0.034), reflexGlassMat, 0, 0.09, -0.02);
    // Crisp glowing cyan holographic cross-dot inside reflex sight glass
    addPart(gun, new THREE.SphereGeometry(0.0026, 8, 8), cyanGlow, 0, 0.09, -0.017);
    addPart(gun, new THREE.BoxGeometry(0.009, 0.0014, 0.0014), cyanGlow, -0.009, 0.09, -0.017);
    addPart(gun, new THREE.BoxGeometry(0.009, 0.0014, 0.0014), cyanGlow, 0.009, 0.09, -0.017);
    addPart(gun, new THREE.BoxGeometry(0.0014, 0.008, 0.0014), cyanGlow, 0, 0.098, -0.017);
    addPart(gun, new THREE.BoxGeometry(0.0014, 0.008, 0.0014), cyanGlow, 0, 0.082, -0.017);
    addPart(gun, new THREE.TorusGeometry(0.0115, 0.001, 6, 20), cyanGlow, 0, 0.09, -0.017);

    // Sculpted left tactical forearm + dark-armored gloved hand gripping the forward forend
    const leftArm = new THREE.Group();
    leftArm.position.set(-0.028, -0.062, -0.18);
    gun.add(leftArm);
    // Armored glove palm cradling foregrip/shroud + articulated finger wrap + thumb
    addPart(leftArm, new RoundedBoxGeometry(0.058, 0.052, 0.072, 2, 0.014), gloveMat, 0.012, -0.002, 0.004, 0.14, 0.16, 0.25);
    addPart(leftArm, new RoundedBoxGeometry(0.038, 0.022, 0.058, 2, 0.008), darkMetal, 0.044, -0.012, -0.014, 0.08, 0.12, -0.2);
    addPart(leftArm, new RoundedBoxGeometry(0.022, 0.022, 0.054, 2, 0.007), gloveMat, -0.016, 0.036, -0.018, 0.28, 0.15, -0.1);
    // Tactical forearm sleeve + armored vambrace + faction wrist cuff extending toward lower-left
    addPart(leftArm, new RoundedBoxGeometry(0.064, 0.06, 0.24, 2, 0.018), sleeveMat, -0.092, -0.052, 0.115, -0.34, -0.58, 0.18);
    addPart(leftArm, new RoundedBoxGeometry(0.068, 0.032, 0.14, 2, 0.01), darkMetal, -0.078, -0.025, 0.095, -0.34, -0.58, 0.18);
    addPart(leftArm, new RoundedBoxGeometry(0.069, 0.018, 0.028, 1, 0.005), factionMat, -0.046, -0.016, 0.054, -0.34, -0.58, 0.18);

    // Sculpted right tactical forearm + dark-armored gloved hand gripping the rear pistol grip
    const rightArm = new THREE.Group();
    rightArm.position.set(0.018, -0.078, 0.048);
    gun.add(rightArm);
    // Gloved grip palm + knuckle guard + curled trigger finger
    addPart(rightArm, new RoundedBoxGeometry(0.056, 0.062, 0.068, 2, 0.014), gloveMat, 0.002, 0.002, 0.006, -0.22, -0.1, -0.12);
    addPart(rightArm, new RoundedBoxGeometry(0.024, 0.046, 0.048, 2, 0.008), darkMetal, 0.026, 0.008, -0.006, -0.22, -0.1, -0.12);
    addPart(rightArm, new RoundedBoxGeometry(0.016, 0.018, 0.052, 2, 0.006), gloveMat, 0.018, 0.028, -0.042, 0.08, -0.18, 0);
    // Right armored forearm & cuff extending toward lower-right
    addPart(rightArm, new RoundedBoxGeometry(0.066, 0.062, 0.24, 2, 0.018), sleeveMat, 0.052, -0.058, 0.135, -0.38, 0.3, -0.15);
    addPart(rightArm, new RoundedBoxGeometry(0.07, 0.032, 0.13, 2, 0.01), darkMetal, 0.046, -0.032, 0.115, -0.38, 0.3, -0.15);
    addPart(rightArm, new RoundedBoxGeometry(0.071, 0.018, 0.028, 1, 0.005), factionMat, 0.028, -0.018, 0.062, -0.38, 0.3, -0.15);

    addMuzzleFlash(gun, 0, 0.016, -0.61, 1.0, 0xffd15c);
  } else if (kind === "rocket") {
    // Massive shoulder-mounted quad-tube AT launcher framed on right
    const pod = new THREE.Group();
    pod.position.set(0.34, -0.14, -0.44);
    pod.rotation.set(0.02, 0.07, -0.02);
    recoilGroup.add(pod);

    // Main armored quad-tube housing
    addPart(pod, new RoundedBoxGeometry(0.185, 0.185, 0.56, 3, 0.018), gunMetal, 0, 0, -0.04);
    // Faction armor side plates & rear reinforcement collar
    addPart(pod, new RoundedBoxGeometry(0.195, 0.065, 0.34, 2, 0.01), factionMat, 0, 0, -0.02);
    addPart(pod, new RoundedBoxGeometry(0.205, 0.205, 0.055, 2, 0.012), darkMetal, 0, 0, -0.31);
    // 4 dark launch tubes with visible glowing amber-red warhead cones inside
    const offsets: [number, number][] = [
      [-0.046, 0.046],
      [0.046, 0.046],
      [-0.046, -0.046],
      [0.046, -0.046],
    ];
    for (const [ox, oy] of offsets) {
      addPart(pod, new THREE.CylinderGeometry(0.034, 0.034, 0.08, 12), cockpitTrim, ox, oy, -0.32, Math.PI / 2, 0, 0);
      addPart(pod, new THREE.ConeGeometry(0.022, 0.055, 10), redGlow, ox, oy, -0.33, -Math.PI / 2, 0, 0);
    }
    // Side-mounted glowing cyan target lock-on optic pod
    addPart(pod, new RoundedBoxGeometry(0.068, 0.072, 0.17, 2, 0.01), darkMetal, -0.125, 0.035, -0.11);
    addPart(pod, new THREE.CylinderGeometry(0.024, 0.024, 0.02, 14), glassCyan, -0.125, 0.035, -0.195, Math.PI / 2, 0, 0);
    glowPulses.push(addPart(pod, new THREE.BoxGeometry(0.012, 0.022, 0.08), cyanGlow, -0.16, 0.04, -0.08));
    // Upper carry handle
    addPart(pod, new RoundedBoxGeometry(0.032, 0.018, 0.22, 1, 0.005), lightAlloy, 0, 0.12, -0.06);

    addMuzzleFlash(pod, 0, 0, -0.44, 1.85, 0xff7b2e);
  } else if (kind === "engineer") {
    // High-tech glowing cyan plasma welder & capture scanner tool
    const tool = new THREE.Group();
    tool.position.set(0.24, -0.24, -0.44);
    tool.rotation.set(0.05, 0.12, -0.04);
    recoilGroup.add(tool);

    addPart(tool, new RoundedBoxGeometry(0.082, 0.092, 0.28, 3, 0.014), gunMetal, 0, 0, 0);
    addPart(tool, new RoundedBoxGeometry(0.088, 0.038, 0.18, 2, 0.008), factionMat, 0, 0.014, 0.01);
    addPart(tool, new RoundedBoxGeometry(0.045, 0.09, 0.052, 2, 0.008), cockpitTrim, 0, -0.07, 0.07, -0.22, 0, 0);
    // Twin copper-brass plasma emitter prongs
    addPart(tool, new RoundedBoxGeometry(0.016, 0.02, 0.16, 1, 0.004), brassMat, -0.03, 0.008, -0.2);
    addPart(tool, new RoundedBoxGeometry(0.016, 0.02, 0.16, 1, 0.004), brassMat, 0.03, 0.008, -0.2);
    // Glowing cyan plasma arc core suspended between prongs
    const core = addPart(tool, new THREE.OctahedronGeometry(0.022, 1), cyanGlow, 0, 0.008, -0.25);
    glowPulses.push(core);
    // Spinning holographic capture scanner ring
    const ring = addPart(tool, new THREE.TorusGeometry(0.044, 0.005, 8, 24), cyanGlow, 0, 0.008, -0.23);
    spinners.push({ obj: ring, axis: "z", speed: 3.4 });
    // Top telemetry readout glass
    addPart(tool, new THREE.BoxGeometry(0.056, 0.016, 0.08), glassCyan, 0, 0.052, 0.02, 0.18, 0, 0);
  } else if (kind === "tank" || kind === "heavy" || kind === "destroyer" || kind === "gunboat") {
    // Armored gunner viewport cowl with ballistic rangefinder bezel + massive 3D rifled cannon barrel(s)
    const isHeavy = kind === "heavy";
    const isDual = kind === "heavy" || kind === "destroyer" || kind === "gunboat";
    addGunnerCowl(0.35, -0.34, kind === "destroyer" || kind === "gunboat" ? "#38f2ff" : "#ffae2b", true);

    const buildCannon = (ox: number, oy: number, rad: number, len: number, heavyBore: boolean) => {
      // Heavy mantlet breech collar + machined alloy breech lock ring
      addPart(recoilGroup, new RoundedBoxGeometry(rad * 3.15, rad * 2.55, 0.24, 2, 0.014), darkMetal, ox, oy, -0.46);
      addPart(recoilGroup, new THREE.CylinderGeometry(rad * 1.48, rad * 1.56, 0.055, 16), lightAlloy, ox, oy, -0.57, Math.PI / 2, 0, 0);
      // Flanking hydraulic recoil recuperator cylinders + gleaming brass piston rods
      for (const s of [-1, 1]) {
        addPart(
          recoilGroup,
          new THREE.CylinderGeometry(rad * 0.34, rad * 0.36, 0.28, 10),
          lightAlloy,
          ox + s * rad * 1.42,
          oy + rad * 0.56,
          -0.56,
          Math.PI / 2,
          0,
          0,
        );
        addPart(
          recoilGroup,
          new THREE.CylinderGeometry(rad * 0.17, rad * 0.17, 0.16, 8),
          brassMat,
          ox + s * rad * 1.42,
          oy + rad * 0.56,
          -0.72,
          Math.PI / 2,
          0,
          0,
        );
      }
      // Top breech readiness indicator LED
      glowPulses.push(
        addPart(recoilGroup, new THREE.BoxGeometry(rad * 0.65, 0.008, 0.022), greenGlow, ox, oy + rad * 1.28, -0.46),
      );
      // Faction-trimmed armored barrel jacket
      addPart(recoilGroup, new RoundedBoxGeometry(rad * 2.35, rad * 1.9, 0.3, 2, 0.012), factionMat, ox, oy + 0.006, -0.6);
      // Long rifled main barrel
      addPart(recoilGroup, new THREE.CylinderGeometry(rad * 0.88, rad, len, 16), gunMetal, ox, oy, -0.58 - len * 0.5, Math.PI / 2, 0, 0);
      // Bore evacuator sleeve mid-barrel
      if (heavyBore) {
        addPart(
          recoilGroup,
          new THREE.CylinderGeometry(rad * 1.32, rad * 1.28, 0.17, 14),
          lightAlloy,
          ox,
          oy,
          -0.58 - len * 0.45,
          Math.PI / 2,
          0,
          0,
        );
      }
      // Slotted muzzle brake tip + machined collar ring
      addPart(
        recoilGroup,
        new RoundedBoxGeometry(rad * 2.5, rad * 2.1, 0.09, 2, 0.01),
        darkMetal,
        ox,
        oy,
        -0.58 - len,
      );
      addPart(
        recoilGroup,
        new THREE.CylinderGeometry(rad * 1.15, rad * 1.15, 0.026, 12),
        lightAlloy,
        ox,
        oy,
        -0.53 - len,
        Math.PI / 2,
        0,
        0,
      );
      addMuzzleFlash(recoilGroup, ox, oy, -0.66 - len, isHeavy ? 2.1 : 1.65, 0xffb33a);
    };

    if (!isDual) {
      // Battle Tank: single heavy 120mm cannon + coaxial MG barrel
      buildCannon(0, -0.255, 0.036, 0.62, true);
      addPart(recoilGroup, new THREE.CylinderGeometry(0.012, 0.013, 0.34, 10), darkMetal, 0.085, -0.24, -0.68, Math.PI / 2, 0, 0);
    } else if (kind === "heavy") {
      // Mastodon Tank: massive twin 155mm cannons
      buildCannon(-0.155, -0.25, 0.044, 0.66, true);
      buildCannon(0.155, -0.25, 0.044, 0.66, true);
    } else if (kind === "destroyer") {
      // Aegis Destroyer: sleek twin naval deck guns + cyan bridge compass strip
      buildCannon(-0.115, -0.255, 0.032, 0.64, true);
      buildCannon(0.115, -0.255, 0.032, 0.64, true);
      glowPulses.push(addPart(swayGroup, new THREE.BoxGeometry(0.24, 0.014, 0.01), cyanGlow, 0, -0.295, -0.39));
    } else {
      // Viper Hydrofoil: sleek twin rapid autocannons + angular bow cowling
      buildCannon(-0.145, -0.25, 0.024, 0.56, false);
      buildCannon(0.145, -0.25, 0.024, 0.56, false);
    }
  } else if (kind === "arty" || kind === "dreadnought") {
    // Elevated heavy twin missile launcher rails framed on left & right edges
    addGunnerCowl(0.36, -0.34, "#ff5030");
    const xOff = kind === "dreadnought" ? 0.4 : 0.37;
    for (const side of [-1, 1]) {
      const rail = new THREE.Group();
      rail.position.set(side * xOff, -0.06, -0.52);
      rail.rotation.set(0.16, -side * 0.08, 0);
      recoilGroup.add(rail);

      // Armored launcher pod box
      addPart(rail, new RoundedBoxGeometry(0.16, 0.2, 0.52, 3, 0.018), gunMetal, 0, 0, 0);
      addPart(rail, new RoundedBoxGeometry(0.17, 0.065, 0.34, 2, 0.01), factionMat, 0, 0.02, 0.02);
      // Guide rails along top/bottom
      addPart(rail, new RoundedBoxGeometry(0.028, 0.022, 0.56, 1, 0.005), lightAlloy, 0, 0.11, -0.02);
      // Stacked glowing red-amber warhead tips protruding forward
      addPart(rail, new THREE.CylinderGeometry(0.028, 0.03, 0.16, 12), lightAlloy, 0, 0.042, -0.29, Math.PI / 2, 0, 0);
      addPart(rail, new THREE.ConeGeometry(0.029, 0.085, 12), redGlow, 0, 0.042, -0.41, -Math.PI / 2, 0, 0);
      addPart(rail, new THREE.CylinderGeometry(0.028, 0.03, 0.16, 12), lightAlloy, 0, -0.042, -0.29, Math.PI / 2, 0, 0);
      addPart(rail, new THREE.ConeGeometry(0.029, 0.085, 12), amberGlow, 0, -0.042, -0.41, -Math.PI / 2, 0, 0);
      addMuzzleFlash(rail, 0, 0, -0.46, 2.0, 0xff6e2e);
    }
  } else if (kind === "spider") {
    // Low-slung cybernetic pincer mandibles framing lower left/right + glowing cyan optical HUD rim
    for (const side of [-1, 1]) {
      const mand = new THREE.Group();
      mand.position.set(side * 0.31, -0.21, -0.48);
      mand.rotation.set(0.08, -side * 0.22, side * 0.15);
      recoilGroup.add(mand);

      // Shoulder armor mount
      addPart(mand, new RoundedBoxGeometry(0.11, 0.085, 0.16, 2, 0.012), factionMat, side * 0.04, 0, 0.08);
      // Curved articulated metallic pincer blade segments
      addPart(mand, new RoundedBoxGeometry(0.042, 0.046, 0.24, 2, 0.008), gunMetal, 0, 0, -0.1, 0, side * 0.18, 0);
      addPart(mand, new THREE.ConeGeometry(0.028, 0.2, 6), lightAlloy, -side * 0.055, 0, -0.28, -Math.PI / 2, 0, side * 0.34);
      // Glowing cyan blade edge vein
      glowPulses.push(
        addPart(mand, new THREE.BoxGeometry(0.008, 0.012, 0.18), cyanGlow, -side * 0.022, 0.015, -0.14, 0, side * 0.18, 0),
      );
    }
    // Cybernetic cyan optical HUD rim arcs top & bottom
    addPart(swayGroup, new THREE.TorusGeometry(0.36, 0.008, 6, 32, Math.PI * 0.55), cyanGlow, 0, 0.04, -0.46, 0, 0, Math.PI * 0.225);
    addPart(swayGroup, new THREE.TorusGeometry(0.36, 0.008, 6, 32, Math.PI * 0.45), cyanGlow, 0, -0.04, -0.46, 0, 0, Math.PI * 1.275);
    addMuzzleFlash(recoilGroup, 0, -0.18, -0.74, 1.1, 0x4ef6ff);
  } else if (kind === "supplytruck") {
    // Supply Convoy: sloped military logistics cab windshield pillars, live dashboard supply-level bar & wing side mirrors!
    const oliveArmor = getChassisMat("#323d35", 0.46, 0.56);
    // Sloped military cab windshield A-pillars (left & right) + inner faction stripes
    addPart(swayGroup, new RoundedBoxGeometry(0.064, 0.62, 0.085, 2, 0.01), cockpitTrim, -0.5, 0.05, -0.45, -0.18, 0.22, -0.15);
    addPart(swayGroup, new RoundedBoxGeometry(0.064, 0.62, 0.085, 2, 0.01), cockpitTrim, 0.5, 0.05, -0.45, -0.18, -0.22, 0.15);
    addPart(swayGroup, new THREE.BoxGeometry(0.014, 0.34, 0.02), factionMat, -0.468, 0.04, -0.43, -0.18, 0.22, -0.15);
    addPart(swayGroup, new THREE.BoxGeometry(0.014, 0.34, 0.02), factionMat, 0.468, 0.04, -0.43, -0.18, -0.22, 0.15);
    // Heavy sloped upper cab brow & rain visor + slim top center mullion stub (keeps windshield panoramic!)
    addPart(swayGroup, new RoundedBoxGeometry(1.06, 0.072, 0.14, 2, 0.012), oliveArmor, 0, 0.355, -0.45, 0.18, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.68, 0.024, 0.04, 1, 0.005), factionMat, 0, 0.325, -0.415, 0.18, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.024, 0.13, 0.045, 1, 0.004), darkMetal, 0, 0.29, -0.45, 0.12, 0, 0);
    // Dual amber convoy roof clearance lights along upper brow corners
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.042, 0.014, 0.012), amberGlow, -0.37, 0.33, -0.4),
      addPart(swayGroup, new THREE.BoxGeometry(0.042, 0.014, 0.012), amberGlow, 0.37, 0.33, -0.4),
    );
    // Left & right heavy-duty military side mirrors (twin tubular steel support arms + beveled housing + tinted mirror glass)
    for (const sx of [-1, 1]) {
      // Upper & lower steel mirror arm struts projecting out from outer A-pillars
      addPart(swayGroup, new THREE.CylinderGeometry(0.006, 0.006, 0.1, 8), darkMetal, sx * 0.54, 0.11, -0.48, 0, 0, Math.PI / 2);
      addPart(swayGroup, new THREE.CylinderGeometry(0.006, 0.006, 0.1, 8), darkMetal, sx * 0.54, -0.05, -0.48, 0, 0, Math.PI / 2);
      // Rectangular armored side-mirror casing angled toward driver
      addPart(swayGroup, new RoundedBoxGeometry(0.068, 0.19, 0.026, 2, 0.006), cockpitTrim, sx * 0.585, 0.03, -0.49, 0, -sx * 0.34, 0);
      // Reflective tinted side-mirror glass face
      addPart(swayGroup, new THREE.BoxGeometry(0.054, 0.165, 0.006), glassTint, sx * 0.578, 0.03, -0.476, 0, -sx * 0.34, 0);
      // Side clearance amber marker pip on outer mirror edge
      addPart(swayGroup, new THREE.BoxGeometry(0.01, 0.024, 0.012), amberGlow, sx * 0.618, 0.03, -0.495, 0, -sx * 0.34, 0);
    }
    // Lower armored logistics dashboard cowl + faction corner badges
    addPart(swayGroup, new RoundedBoxGeometry(1.06, 0.11, 0.22, 2, 0.015), cockpitTrim, 0, -0.325, -0.46, -0.22, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.18, 0.022, 0.032, 1, 0.004), factionMat, -0.34, -0.278, -0.415, -0.22, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.18, 0.022, 0.032, 1, 0.004), factionMat, 0.34, -0.278, -0.415, -0.22, 0, 0);
    // Heavy military steering wheel upper rim peeking cleanly at lower-left
    addPart(swayGroup, new THREE.TorusGeometry(0.115, 0.014, 10, 24, Math.PI * 1.15), darkMetal, -0.23, -0.365, -0.39, 0.52, 0, -Math.PI * 0.075);
    addPart(swayGroup, new THREE.CylinderGeometry(0.028, 0.032, 0.016, 12), gunMetal, -0.23, -0.365, -0.39, 0.52 + Math.PI / 2, 0, 0);
    // Center illuminated logistics console with LIVE emerald-green dashboard supply-level bar!
    addPart(swayGroup, new RoundedBoxGeometry(0.28, 0.056, 0.032, 2, 0.006), darkMetal, 0, -0.272, -0.415, -0.34, 0, 0);
    // Recessed meter backing track
    addPart(swayGroup, new THREE.BoxGeometry(0.21, 0.02, 0.006), cockpitTrim, 0, -0.266, -0.398, -0.34, 0, 0);
    // Dynamic emerald supply-level bar (scaled horizontally by live truck cargo in updateViewmodel!)
    const barW = 0.196;
    const barMesh = addPart(swayGroup, new THREE.BoxGeometry(barW, 0.014, 0.007), greenGlow, 0, -0.266, -0.394, -0.34, 0, 0);
    supplyBar = { mesh: barMesh, baseX: 0, halfW: barW * 0.5 };
    // Flanking dashboard telemetry pips (fuel pressure cyan + convoy beacon amber)
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.055, 0.007, 0.006), cyanGlow, -0.068, -0.284, -0.394, -0.34, 0, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.055, 0.007, 0.006), amberGlow, 0.068, -0.284, -0.394, -0.34, 0, 0),
    );
    // Sloped armored logistics hood nose & steel radiator grille peeking low ahead
    addPart(swayGroup, new RoundedBoxGeometry(0.54, 0.06, 0.42, 2, 0.012), oliveArmor, 0, -0.365, -0.76, 0.06, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.32, 0.018, 0.34, 1, 0.004), gunMetal, 0, -0.332, -0.76, 0.06, 0, 0);
    addPart(swayGroup, new THREE.BoxGeometry(0.14, 0.01, 0.025), greenGlow, 0, -0.335, -0.94, 0.06, 0, 0);
  } else if (kind === "harvester") {
    // Heavy industrial cab roll-cage frame + spinning ore-scoop prongs visible low ahead
    addPart(swayGroup, new RoundedBoxGeometry(0.068, 0.62, 0.075, 2, 0.01), cockpitTrim, -0.49, 0.04, -0.45, -0.12, 0.2, -0.14);
    addPart(swayGroup, new RoundedBoxGeometry(0.068, 0.62, 0.075, 2, 0.01), cockpitTrim, 0.49, 0.04, -0.45, -0.12, -0.2, 0.14);
    addPart(swayGroup, new RoundedBoxGeometry(1.02, 0.075, 0.12, 2, 0.012), factionMat, 0, 0.35, -0.46, 0.16, 0, 0);
    // Lower armored dash & amber work lights
    addPart(swayGroup, new RoundedBoxGeometry(0.96, 0.09, 0.18, 2, 0.014), cockpitTrim, 0, -0.32, -0.46, -0.2, 0, 0);
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.08, 0.022, 0.02), amberGlow, -0.32, -0.28, -0.4),
      addPart(swayGroup, new THREE.BoxGeometry(0.08, 0.022, 0.02), amberGlow, 0.32, -0.28, -0.4),
    );
    // Spinning rotary ore-scoop crusher drum & prongs low ahead
    const drum = new THREE.Group();
    drum.position.set(0, -0.31, -0.76);
    swayGroup.add(drum);
    addPart(drum, new THREE.CylinderGeometry(0.062, 0.062, 0.56, 12), gunMetal, 0, 0, 0, 0, 0, Math.PI / 2);
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2;
      for (const px of [-0.2, -0.07, 0.07, 0.2]) {
        const prong = addPart(
          drum,
          new RoundedBoxGeometry(0.032, 0.085, 0.024, 1, 0.004),
          brassMat,
          px,
          Math.cos(ang) * 0.082,
          Math.sin(ang) * 0.082,
          ang,
          0,
          0,
        );
        prong.castShadow = false;
      }
    }
    spinners.push({ obj: drum, axis: "x", speed: -3.2 });
  } else if (kind === "interceptor") {
    // Valkyrie Jet: razor fighter canopy struts + swept nose strake + twin nose cannons
    addAircraftCanopy(false, false);
    addPart(swayGroup, new RoundedBoxGeometry(0.18, 0.036, 0.42, 2, 0.008), factionMat, 0, -0.32, -0.74, 0.08, 0, 0);
    addPart(recoilGroup, new THREE.CylinderGeometry(0.015, 0.018, 0.34, 10), lightAlloy, -0.22, -0.27, -0.78, Math.PI / 2, 0, 0);
    addPart(recoilGroup, new THREE.CylinderGeometry(0.015, 0.018, 0.34, 10), lightAlloy, 0.22, -0.27, -0.78, Math.PI / 2, 0, 0);
    addMuzzleFlash(recoilGroup, -0.22, -0.27, -0.98, 1.35, 0x62f2ff);
    addMuzzleFlash(recoilGroup, 0.22, -0.27, -0.98, 1.35, 0x62f2ff);
  } else if (kind === "chopper") {
    // Hornet Gunship: angled gunship canopy + spinning overhead rotor blades + chin cannon
    addAircraftCanopy(true, false);
    // Spinning overhead rotor shadow blades visible across upper canopy
    const rotorHub = new THREE.Group();
    rotorHub.position.set(0, 0.39, -0.52);
    rotorHub.rotation.x = 0.14;
    swayGroup.add(rotorHub);
    const bladeMat = trackMat(
      new THREE.MeshBasicMaterial({
        color: 0x10161d,
        transparent: true,
        opacity: 0.42,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2;
      const blade = addPart(rotorHub, new THREE.BoxGeometry(0.95, 0.006, 0.048), bladeMat, 0, 0, 0, 0, ang, 0);
      blade.renderOrder = 2;
    }
    spinners.push({ obj: rotorHub, axis: "y", speed: 18.5 });
    // Chin gatling gun visible lower-center
    addPart(recoilGroup, new THREE.CylinderGeometry(0.022, 0.024, 0.44, 10), gunMetal, 0, -0.29, -0.76, Math.PI / 2, 0, 0);
    addMuzzleFlash(recoilGroup, 0, -0.29, -1.02, 1.3, 0xffc84a);
  } else if (kind === "bomber") {
    // Tempest Bomber: wide heavy flight-deck canopy + glowing bomb-bay release bars
    addAircraftCanopy(true, true);
    // Central armored windscreen divider + overhead bomb-sight indicator
    addPart(swayGroup, new RoundedBoxGeometry(0.022, 0.24, 0.036, 1, 0.004), cockpitTrim, 0, 0.24, -0.45, 0.14, 0, 0);
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.06, 0.014, 0.01), redGlow, -0.11, -0.248, -0.41),
      addPart(swayGroup, new THREE.BoxGeometry(0.06, 0.014, 0.01), redGlow, 0.11, -0.248, -0.41),
    );
    addMuzzleFlash(recoilGroup, 0, -0.32, -0.82, 1.6, 0xff8a30);
  } else if (kind === "zeppelin") {
    // Leviathan Airship: armored gondola bridge frame with brass/faction girders & bomb console
    addAircraftCanopy(true, true);
    addPart(swayGroup, new RoundedBoxGeometry(0.038, 0.54, 0.05, 1, 0.006), brassMat, -0.45, 0.06, -0.45, -0.18, 0.2, -0.2);
    addPart(swayGroup, new RoundedBoxGeometry(0.038, 0.54, 0.05, 1, 0.006), brassMat, 0.45, 0.06, -0.45, -0.18, -0.2, 0.2);
    addPart(swayGroup, new RoundedBoxGeometry(0.92, 0.044, 0.06, 1, 0.006), factionMat, 0, 0.35, -0.46, 0.14, 0, 0);
    glowPulses.push(addPart(swayGroup, new THREE.BoxGeometry(0.24, 0.018, 0.01), redGlow, 0, -0.26, -0.405, -0.36, 0, 0));
    addMuzzleFlash(recoilGroup, 0, -0.32, -0.82, 1.9, 0xff5a28);
  } else if (kind === "himars") {
    // HIMARS Launcher: rugged armored tactical truck cab + elevated 6-tube rocket pod rails!
    // Armored cab windscreen pillars, top brow & center armored divider
    addPart(swayGroup, new RoundedBoxGeometry(1.06, 0.078, 0.14, 2, 0.012), cockpitTrim, 0, 0.35, -0.44, 0.16, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.074, 0.64, 0.1, 2, 0.012), cockpitTrim, -0.5, 0.03, -0.44, -0.08, 0.22, -0.1);
    addPart(swayGroup, new RoundedBoxGeometry(0.074, 0.64, 0.1, 2, 0.012), cockpitTrim, 0.5, 0.03, -0.44, -0.08, -0.22, 0.1);
    addPart(swayGroup, new RoundedBoxGeometry(0.026, 0.16, 0.05, 1, 0.005), darkMetal, 0, 0.27, -0.44, 0.08, 0, 0);
    // Lower armored dash + tactical fire-control console
    addPart(swayGroup, new RoundedBoxGeometry(1.06, 0.105, 0.2, 2, 0.014), cockpitTrim, 0, -0.33, -0.46, -0.24, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.24, 0.024, 0.035, 1, 0.004), factionMat, -0.31, -0.285, -0.42, -0.24, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.24, 0.024, 0.035, 1, 0.004), factionMat, 0.31, -0.285, -0.42, -0.24, 0, 0);
    // Illuminated fire-control ballistic MFD
    addPart(swayGroup, new RoundedBoxGeometry(0.26, 0.05, 0.026, 2, 0.005), darkMetal, 0, -0.275, -0.415, -0.36, 0, 0);
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.11, 0.01, 0.006), amberGlow, -0.055, -0.268, -0.4, -0.36, 0, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.09, 0.01, 0.006), greenGlow, 0.06, -0.268, -0.4, -0.36, 0, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.18, 0.006, 0.006), cyanGlow, 0, -0.282, -0.398, -0.36, 0, 0),
    );

    // Elevated 6-tube rocket launcher rails (2 rows x 3 tubes) mounted prominently on right gantry + port stabilizer rail
    const pod = new THREE.Group();
    pod.position.set(0.36, 0.02, -0.54);
    pod.rotation.set(0.22, -0.09, -0.03);
    recoilGroup.add(pod);
    // Armored 6-tube pod housing & faction stripe
    addPart(pod, new RoundedBoxGeometry(0.24, 0.175, 0.56, 3, 0.016), gunMetal, 0, 0, 0);
    addPart(pod, new RoundedBoxGeometry(0.252, 0.052, 0.36, 2, 0.008), factionMat, 0, 0.01, 0.02);
    // Heavy steel elevation guide rails along top & sides
    addPart(pod, new RoundedBoxGeometry(0.024, 0.022, 0.62, 1, 0.004), lightAlloy, -0.085, 0.098, -0.02);
    addPart(pod, new RoundedBoxGeometry(0.024, 0.022, 0.62, 1, 0.004), lightAlloy, 0.085, 0.098, -0.02);
    // 6 rocket launch tubes (2 rows x 3 columns) with glowing warhead noses
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 3; c++) {
        const tx = (c - 1) * 0.068;
        const ty = (r === 0 ? 1 : -1) * 0.038;
        addPart(pod, new THREE.CylinderGeometry(0.026, 0.026, 0.09, 10), cockpitTrim, tx, ty, -0.27, Math.PI / 2, 0, 0);
        addPart(
          pod,
          new THREE.ConeGeometry(0.018, 0.052, 10),
          (r + c) % 2 === 0 ? redGlow : amberGlow,
          tx,
          ty,
          -0.31,
          -Math.PI / 2,
          0,
          0,
        );
      }
    }
    addMuzzleFlash(pod, 0, 0, -0.44, 2.15, 0xff7826);

    // Left elevated rangefinder / secondary stabilizer rail balancing the cab silhouette
    const leftRail = new THREE.Group();
    leftRail.position.set(-0.39, -0.08, -0.56);
    leftRail.rotation.set(0.18, 0.09, 0.03);
    recoilGroup.add(leftRail);
    addPart(leftRail, new RoundedBoxGeometry(0.075, 0.09, 0.44, 2, 0.01), darkMetal, 0, 0, 0);
    addPart(leftRail, new RoundedBoxGeometry(0.024, 0.024, 0.48, 1, 0.004), lightAlloy, 0, 0.056, -0.02);
    glowPulses.push(addPart(leftRail, new THREE.BoxGeometry(0.042, 0.026, 0.014), cyanGlow, 0, 0.01, -0.22));
    addMuzzleFlash(leftRail, 0, 0.02, -0.34, 1.35, 0xff9238);
  } else if (kind === "railtank") {
    // Aegis Railgun MBT: heavy gunner cowl + twin long glowing electromagnetic railgun barrels!
    addGunnerCowl(0.35, -0.34, "#38f2ff", true);

    for (const side of [-1, 1]) {
      const ox = side * 0.165;
      const oy = -0.245;
      // Heavy armored electromagnetic breech housing & capacitor block
      addPart(recoilGroup, new RoundedBoxGeometry(0.155, 0.135, 0.28, 2, 0.014), darkMetal, ox, oy, -0.48);
      addPart(recoilGroup, new RoundedBoxGeometry(0.165, 0.05, 0.24, 2, 0.008), factionMat, ox, oy + 0.045, -0.52);
      // Glowing cyan capacitor readiness bars along breech top
      glowPulses.push(
        addPart(recoilGroup, new THREE.BoxGeometry(0.058, 0.01, 0.085), cyanGlow, ox, oy + 0.075, -0.51),
      );
      // Parallel upper & lower machined titanium magnetic accelerator rails
      addPart(recoilGroup, new RoundedBoxGeometry(0.048, 0.024, 0.78, 2, 0.005), lightAlloy, ox, oy + 0.028, -0.92);
      addPart(recoilGroup, new RoundedBoxGeometry(0.048, 0.024, 0.78, 2, 0.005), lightAlloy, ox, oy - 0.028, -0.92);
      // Outer side armor fins flanking rails
      addPart(recoilGroup, new RoundedBoxGeometry(0.016, 0.064, 0.62, 1, 0.004), gunMetal, ox + side * 0.032, oy, -0.84);
      // Blazing continuous cyan electromagnetic plasma core channel sandwiched between the rails
      glowPulses.push(
        addPart(recoilGroup, new THREE.BoxGeometry(0.018, 0.022, 0.74), cyanGlow, ox, oy, -0.92),
      );
      // 4 glowing electromagnetic accelerator coil collars spaced along each barrel
      for (let c = 0; c < 4; c++) {
        const cz = -0.66 - c * 0.18;
        addPart(recoilGroup, new RoundedBoxGeometry(0.074, 0.086, 0.026, 2, 0.005), darkMetal, ox, oy, cz);
        glowPulses.push(
          addPart(recoilGroup, new THREE.BoxGeometry(0.08, 0.014, 0.014), cyanGlow, ox, oy, cz),
        );
      }
      // Electromagnetic muzzle prong tips
      addPart(recoilGroup, new RoundedBoxGeometry(0.068, 0.026, 0.08, 1, 0.004), darkMetal, ox, oy + 0.032, -1.32);
      addPart(recoilGroup, new RoundedBoxGeometry(0.068, 0.026, 0.08, 1, 0.004), darkMetal, ox, oy - 0.032, -1.32);
      addMuzzleFlash(recoilGroup, ox, oy, -1.4, 2.15, 0x5cf6ff);
    }
  } else if (kind === "fpvdrone") {
    // Authentic FPV Suicide Drone Goggles Camera Feed:
    // Carbon-fiber front arms & spinning front props at top-left & top-right corners + strapped RPG warhead tip low ahead!
    const carbonMat = getChassisMat("#161b22", 0.36, 0.54);
    const oliveWarhead = getChassisMat("#495738", 0.56, 0.28);
    const copperMat = getChassisMat("#c97a38", 0.32, 0.8);

    // Wide-angle FPV goggles peripheral corner brackets (keeps center 100% open for high-speed diving!)
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        addPart(swayGroup, new RoundedBoxGeometry(0.14, 0.018, 0.032, 1, 0.004), carbonMat, sx * 0.48, sy * 0.34, -0.42);
        addPart(swayGroup, new RoundedBoxGeometry(0.018, 0.12, 0.032, 1, 0.004), carbonMat, sx * 0.54, sy * 0.29, -0.42);
      }
      // Subtle side camera-cage standoff posts with faction tape strips
      addPart(swayGroup, new THREE.CylinderGeometry(0.008, 0.008, 0.22, 8), lightAlloy, sx * 0.52, -0.02, -0.44);
      addPart(swayGroup, new THREE.BoxGeometry(0.014, 0.065, 0.014), factionMat, sx * 0.515, -0.04, -0.435);
    }

    // FPV Goggles OSD micro status LEDs along top & bottom edges (VTX link green + ARMED red)
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.032, 0.007, 0.008), greenGlow, -0.34, 0.335, -0.41),
      addPart(swayGroup, new THREE.BoxGeometry(0.032, 0.007, 0.008), cyanGlow, -0.28, 0.335, -0.41),
      addPart(swayGroup, new THREE.BoxGeometry(0.065, 0.009, 0.008), redGlow, 0.32, 0.335, -0.41),
    );

    // Carbon-fiber front quadcopter arms + fast-spinning front props visible right at top-left & top-right corners!
    const propBlurMat = trackMat(
      new THREE.MeshBasicMaterial({
        color: 0x1a222b,
        transparent: true,
        opacity: 0.34,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    const propRimMat = trackMat(
      new THREE.MeshBasicMaterial({
        color: 0xff5a36,
        transparent: true,
        opacity: 0.36,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    for (const sx of [-1, 1]) {
      // Diagonal carbon-fiber front arm reaching outward into upper screen corner
      addPart(
        swayGroup,
        new RoundedBoxGeometry(0.044, 0.018, 0.44, 2, 0.005),
        carbonMat,
        sx * 0.34,
        0.24,
        -0.56,
        -0.22,
        -sx * 0.52,
        sx * 0.08,
      );
      // Brushless motor bell & copper stator core at upper corner
      addPart(swayGroup, new THREE.CylinderGeometry(0.036, 0.038, 0.034, 14), darkMetal, sx * 0.45, 0.285, -0.71, 0.24, 0, sx * 0.14);
      addPart(swayGroup, new THREE.CylinderGeometry(0.032, 0.032, 0.012, 14), copperMat, sx * 0.45, 0.288, -0.71, 0.24, 0, sx * 0.14);

      // Spinning 3-blade FPV prop + translucent motion-blur disc right in the top corners!
      const propHub = new THREE.Group();
      propHub.position.set(sx * 0.45, 0.308, -0.71);
      propHub.rotation.set(0.24, 0, sx * 0.14);
      swayGroup.add(propHub);
      addPart(propHub, new THREE.CylinderGeometry(0.014, 0.016, 0.016, 10), lightAlloy, 0, 0, 0);
      for (let b = 0; b < 3; b++) {
        const ang = (b * Math.PI * 2) / 3;
        addPart(
          propHub,
          new THREE.BoxGeometry(0.022, 0.004, 0.22),
          carbonMat,
          Math.sin(ang) * 0.11,
          0,
          Math.cos(ang) * 0.11,
          0,
          ang,
          0,
        );
      }
      const blurDisc = addPart(propHub, new THREE.CircleGeometry(0.225, 24), propBlurMat, 0, -0.003, 0, -Math.PI / 2, 0, 0);
      blurDisc.renderOrder = 2;
      const blurRim = addPart(propHub, new THREE.RingGeometry(0.205, 0.228, 24), propRimMat, 0, -0.002, 0, -Math.PI / 2, 0, 0);
      blurRim.renderOrder = 2;
      spinners.push({ obj: propHub, axis: "y", speed: sx < 0 ? 44 : -44 });
    }

    // Underslung strapped olive/metallic RPG shaped-charge warhead tip visible low ahead!
    const warhead = new THREE.Group();
    warhead.position.set(0, -0.295, -0.68);
    warhead.rotation.set(0.09, 0, 0);
    recoilGroup.add(warhead);
    // Olive-drab shaped-charge body & tapered ballistic warhead cone
    addPart(warhead, new THREE.CylinderGeometry(0.068, 0.074, 0.22, 16), oliveWarhead, 0, 0, 0.06, Math.PI / 2, 0, 0);
    addPart(warhead, new THREE.ConeGeometry(0.068, 0.24, 16), oliveWarhead, 0, 0, -0.17, -Math.PI / 2, 0, 0);
    // Metallic nose collar + piezoelectric standoff impact tip
    addPart(warhead, new THREE.CylinderGeometry(0.044, 0.056, 0.045, 14), lightAlloy, 0, 0, -0.13, Math.PI / 2, 0, 0);
    addPart(warhead, new THREE.CylinderGeometry(0.015, 0.022, 0.11, 10), darkMetal, 0, 0, -0.31, Math.PI / 2, 0, 0);
    // Twin copper contact-detonator trigger wires jutting forward at nose tip
    addPart(warhead, new THREE.CylinderGeometry(0.004, 0.004, 0.11, 6), copperMat, -0.022, 0.004, -0.36, Math.PI / 2, 0.18, 0);
    addPart(warhead, new THREE.CylinderGeometry(0.004, 0.004, 0.11, 6), copperMat, 0.022, 0.004, -0.36, Math.PI / 2, -0.18, 0);
    // Heavy black strap cinch + faction zip-tie band
    addPart(warhead, new RoundedBoxGeometry(0.155, 0.026, 0.032, 1, 0.004), darkMetal, 0, 0.065, 0.04);
    addPart(warhead, new THREE.BoxGeometry(0.16, 0.014, 0.018), factionMat, 0, 0.072, 0.04);
    // Pulsing bright crimson armed warhead LED right on top of the warhead nose!
    glowPulses.push(
      addPart(warhead, new THREE.SphereGeometry(0.016, 10, 8), redGlow, 0, 0.058, -0.09),
    );
    addMuzzleFlash(warhead, 0, 0, -0.42, 2.2, 0xff5a28);
  } else if (kind === "shahed") {
    // Delta Kamikaze (Shahed): sleek nose-cam loitering munition feed with red armed indicator!
    const matteWhite = getChassisMat("#c6cfd8", 0.56, 0.22);
    const matteSlate = getChassisMat("#7e8c9a", 0.52, 0.28);
    const crimsonPaint = getChassisMat("#cf2e24", 0.42, 0.36);

    // Clean nose-camera optical corner brackets & upper horizon bar
    for (const sx of [-1, 1]) {
      addPart(swayGroup, new RoundedBoxGeometry(0.15, 0.02, 0.035, 1, 0.004), cockpitTrim, sx * 0.44, 0.32, -0.45);
      addPart(swayGroup, new RoundedBoxGeometry(0.02, 0.13, 0.035, 1, 0.004), cockpitTrim, sx * 0.5, 0.265, -0.45);
      // Swept matte-white cropped delta wing leading-edge shoulders peeking low-left & low-right!
      addPart(
        swayGroup,
        new RoundedBoxGeometry(0.28, 0.032, 0.46, 2, 0.008),
        matteWhite,
        sx * 0.39,
        -0.31,
        -0.72,
        0.04,
        -sx * 0.48,
        sx * 0.06,
      );
      // Crimson warhead warning stripe + faction wing mark along swept delta shoulder
      addPart(
        swayGroup,
        new THREE.BoxGeometry(0.12, 0.036, 0.055),
        crimsonPaint,
        sx * 0.32,
        -0.305,
        -0.66,
        0.04,
        -sx * 0.48,
        sx * 0.06,
      );
      addPart(
        swayGroup,
        new THREE.BoxGeometry(0.08, 0.036, 0.065),
        factionMat,
        sx * 0.44,
        -0.305,
        -0.78,
        0.04,
        -sx * 0.48,
        sx * 0.06,
      );
    }

    // Lower aerodynamic nose-cam housing lip & central armed telemetry bar
    addPart(swayGroup, new RoundedBoxGeometry(0.56, 0.055, 0.14, 2, 0.01), matteSlate, 0, -0.335, -0.48, -0.22, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.24, 0.032, 0.025, 2, 0.005), darkMetal, 0, -0.295, -0.43, -0.32, 0, 0);

    // Prominent glowing crimson ARMED warhead indicator strip & dual armed LED pips!
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.14, 0.011, 0.008), redGlow, 0, -0.292, -0.415, -0.32, 0, 0),
      addPart(swayGroup, new THREE.SphereGeometry(0.012, 10, 8), redGlow, -0.092, -0.292, -0.415),
      addPart(swayGroup, new THREE.SphereGeometry(0.012, 10, 8), redGlow, 0.092, -0.292, -0.415),
      addPart(swayGroup, new THREE.BoxGeometry(0.05, 0.007, 0.008), amberGlow, 0, 0.315, -0.43),
    );

    // Sleek dark warhead nose tip & metallic pitot airspeed probe peeking forward-right
    addPart(recoilGroup, new THREE.ConeGeometry(0.055, 0.24, 12), darkMetal, 0, -0.335, -0.82, -Math.PI / 2, 0, 0);
    addPart(recoilGroup, new THREE.CylinderGeometry(0.006, 0.009, 0.26, 8), lightAlloy, 0.17, -0.285, -0.78, Math.PI / 2, 0, 0);
    addMuzzleFlash(recoilGroup, 0, -0.32, -0.96, 2.3, 0xff4c24);
  } else if (kind === "ewdrone") {
    // EW Jammer Drone: electronic warfare optical pod with purple-cyan EW spectrum bezel!
    const ewTitanium = getChassisMat("#222b36", 0.34, 0.76);
    const purpleGlow = getGlowMat("#b45cff", 1.75);

    // Hex-beveled dark-titanium optical pod peripheral frame
    addPart(swayGroup, new RoundedBoxGeometry(0.76, 0.028, 0.05, 2, 0.006), ewTitanium, 0, 0.33, -0.45, 0.14, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.84, 0.048, 0.08, 2, 0.008), ewTitanium, 0, -0.33, -0.46, -0.24, 0, 0);
    for (const sx of [-1, 1]) {
      // Angled hexagonal side bezel struts
      addPart(swayGroup, new RoundedBoxGeometry(0.028, 0.28, 0.045, 1, 0.005), ewTitanium, sx * 0.48, 0.15, -0.45, 0, -sx * 0.18, sx * 0.28);
      addPart(swayGroup, new RoundedBoxGeometry(0.028, 0.28, 0.045, 1, 0.005), ewTitanium, sx * 0.48, -0.14, -0.45, 0, -sx * 0.18, -sx * 0.28);
      // Faction & purple-cyan EW side emitter strips
      addPart(swayGroup, new THREE.BoxGeometry(0.012, 0.11, 0.015), factionMat, sx * 0.465, 0.01, -0.435);
      glowPulses.push(
        addPart(swayGroup, new THREE.BoxGeometry(0.008, 0.065, 0.01), purpleGlow, sx * 0.45, 0.14, -0.43, 0, 0, sx * 0.28),
        addPart(swayGroup, new THREE.BoxGeometry(0.008, 0.065, 0.01), cyanGlow, sx * 0.45, -0.13, -0.43, 0, 0, -sx * 0.28),
      );
      // Forward dark-titanium EW dipole jammer emitter prongs peeking low-left & low-right
      addPart(swayGroup, new THREE.CylinderGeometry(0.01, 0.014, 0.34, 8), ewTitanium, sx * 0.32, -0.27, -0.74, Math.PI / 2, -sx * 0.08, 0);
      glowPulses.push(
        addPart(swayGroup, new THREE.SphereGeometry(0.018, 10, 8), sx < 0 ? purpleGlow : cyanGlow, sx * 0.335, -0.27, -0.92),
      );
    }

    // Purple-cyan EW RF spectrum analyzer bars across the lower bezel
    const specHeights = [0.016, 0.028, 0.02, 0.034, 0.022, 0.032, 0.018];
    for (let i = 0; i < specHeights.length; i++) {
      const bx = -0.24 + i * 0.024;
      const h = specHeights[i];
      glowPulses.push(
        addPart(swayGroup, new THREE.BoxGeometry(0.014, h, 0.007), i % 2 === 0 ? purpleGlow : cyanGlow, bx, -0.292 + h * 0.25, -0.415, -0.24, 0, 0),
        addPart(swayGroup, new THREE.BoxGeometry(0.014, h, 0.007), i % 2 === 0 ? cyanGlow : purpleGlow, -bx, -0.292 + h * 0.25, -0.415, -0.24, 0, 0),
      );
    }

    // Rotating holographic purple-cyan phased EW emitter ring at lower center!
    const ewRingOuter = addPart(swayGroup, new THREE.TorusGeometry(0.048, 0.005, 8, 28), purpleGlow, 0, -0.295, -0.43);
    const ewRingInner = addPart(swayGroup, new THREE.TorusGeometry(0.03, 0.004, 8, 24), cyanGlow, 0, -0.295, -0.428);
    spinners.push(
      { obj: ewRingOuter, axis: "z", speed: 2.6 },
      { obj: ewRingInner, axis: "z", speed: -4.2 },
    );
    // Subtle upper purple-cyan EW frequency calibration arc
    addPart(swayGroup, new THREE.TorusGeometry(0.39, 0.0038, 6, 32, Math.PI * 0.38), purpleGlow, 0, -0.02, -0.46, 0, 0, Math.PI * 0.31);
  } else if (kind === "usv") {
    // Sea-Baby USV Drone Boat: ultra-low-waterline bow-cam skimming right across the 3D ocean waves!
    const usvStealth = getChassisMat("#192028", 0.44, 0.56);
    const satWhite = getChassisMat("#e4ecf4", 0.34, 0.16);

    // Compact waterproof marine optical dome rim brackets & spray visor
    for (const sx of [-1, 1]) {
      addPart(swayGroup, new RoundedBoxGeometry(0.14, 0.02, 0.036, 1, 0.004), cockpitTrim, sx * 0.44, 0.32, -0.44);
      addPart(swayGroup, new RoundedBoxGeometry(0.02, 0.12, 0.036, 1, 0.004), cockpitTrim, sx * 0.5, 0.27, -0.44);
      addPart(swayGroup, new RoundedBoxGeometry(0.08, 0.016, 0.024, 1, 0.003), factionMat, sx * 0.34, -0.295, -0.43);
    }
    // Low marine telemetry dash with white satcom-link status indicator
    addPart(swayGroup, new RoundedBoxGeometry(0.76, 0.055, 0.14, 2, 0.01), cockpitTrim, 0, -0.335, -0.46, -0.22, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.08, 0.014, 0.022, 1, 0.003), satWhite, -0.2, -0.302, -0.42, -0.22, 0, 0);
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.052, 0.008, 0.008), cyanGlow, -0.1, -0.302, -0.415, -0.22, 0, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.052, 0.008, 0.008), redGlow, 0.1, -0.302, -0.415, -0.22, 0, 0),
    );

    // Sharp dark stealth wave-piercing USV bow deck extending straight forward right over the ocean!
    const bow = new THREE.Group();
    bow.position.set(0, -0.325, -0.78);
    bow.rotation.set(0.04, 0, 0);
    recoilGroup.add(bow);
    // Tapered stealth bow prow hull & raised center spine
    addPart(bow, new THREE.ConeGeometry(0.15, 0.54, 4), usvStealth, 0, -0.02, -0.04, -Math.PI / 2, Math.PI / 4, 0);
    addPart(bow, new RoundedBoxGeometry(0.18, 0.026, 0.28, 2, 0.006), gunMetal, 0, 0.016, 0.12);
    addPart(bow, new RoundedBoxGeometry(0.12, 0.014, 0.1, 1, 0.003), factionMat, 0, 0.032, 0.12);

    // Twin metallic contact-detonator impact horns projecting forward from the sharp bow tip!
    for (const sx of [-1, 1]) {
      addPart(bow, new THREE.CylinderGeometry(0.009, 0.012, 0.15, 8), lightAlloy, sx * 0.052, 0.016, -0.31, Math.PI / 2, -sx * 0.14, 0);
      addPart(bow, new THREE.SphereGeometry(0.013, 8, 8), darkMetal, sx * 0.062, 0.016, -0.385);
    }

    // Blinking crimson bow warhead detonator fuse beacon right at the bow nose!
    glowPulses.push(
      addPart(bow, new THREE.SphereGeometry(0.022, 12, 10), redGlow, 0, 0.038, -0.21),
    );
    addMuzzleFlash(bow, 0, 0.02, -0.42, 2.35, 0xff4a24);
  } else if (kind === "uav") {
    // Reaper Drone: sleek remote optical sensor feed frame + FLIR telemetry rails + wing micro-pods
    // Outer carbon-fiber optical viewport L-corner brackets (keeps entire center view razor-clear)
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        addPart(swayGroup, new RoundedBoxGeometry(0.16, 0.022, 0.04, 1, 0.004), cockpitTrim, sx * 0.42, sy * 0.31, -0.45);
        addPart(swayGroup, new RoundedBoxGeometry(0.022, 0.14, 0.04, 1, 0.004), cockpitTrim, sx * 0.49, sy * 0.25, -0.45);
        glowPulses.push(
          addPart(swayGroup, new THREE.BoxGeometry(0.05, 0.006, 0.01), cyanGlow, sx * 0.42, sy * 0.295, -0.43),
        );
      }
    }
    // Thin upper & lower optical gimbal telemetry bars + faction sensor tabs
    addPart(swayGroup, new RoundedBoxGeometry(0.54, 0.018, 0.035, 1, 0.004), darkMetal, 0, 0.325, -0.46);
    addPart(swayGroup, new RoundedBoxGeometry(0.58, 0.026, 0.05, 1, 0.005), darkMetal, 0, -0.325, -0.46);
    addPart(swayGroup, new RoundedBoxGeometry(0.11, 0.014, 0.02, 1, 0.003), factionMat, -0.22, -0.315, -0.44);
    addPart(swayGroup, new RoundedBoxGeometry(0.11, 0.014, 0.02, 1, 0.003), factionMat, 0.22, -0.315, -0.44);
    // Rotating gyro-stabilized laser designator lens ring at lower center
    const gimbalRing = addPart(swayGroup, new THREE.TorusGeometry(0.042, 0.0045, 8, 24), cyanGlow, 0, -0.3, -0.45);
    spinners.push({ obj: gimbalRing, axis: "z", speed: 2.1 });
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.024, 0.008, 0.008), greenGlow, -0.21, 0.315, -0.435),
      addPart(swayGroup, new THREE.BoxGeometry(0.024, 0.008, 0.008), cyanGlow, 0.21, 0.315, -0.435),
    );
    // Translucent FLIR azimuth calibration arc along upper frame
    addPart(swayGroup, new THREE.TorusGeometry(0.39, 0.0035, 6, 32, Math.PI * 0.42), cyanGlow, 0, -0.02, -0.46, 0, 0, Math.PI * 0.29);
    // Under-wing twin Reaper micro-missile pylons peeking at lower left & right
    for (const sx of [-1, 1]) {
      addPart(recoilGroup, new THREE.CylinderGeometry(0.016, 0.018, 0.32, 10), gunMetal, sx * 0.29, -0.26, -0.74, Math.PI / 2, 0, 0);
      addPart(recoilGroup, new THREE.ConeGeometry(0.017, 0.055, 8), amberGlow, sx * 0.29, -0.26, -0.92, -Math.PI / 2, 0, 0);
      addMuzzleFlash(recoilGroup, sx * 0.29, -0.26, -0.98, 1.15, 0x62f2ff);
    }
  } else if (kind === "stealthbomber") {
    // B-21 Phantom: angular matte-obsidian stealth flying-wing canopy + low-glare stealth HUD
    const obsidianMat = getChassisMat("#11151b", 0.58, 0.38);
    // Sharp radar-deflecting faceted angular canopy brow (V-angled stealth mullions)
    addPart(swayGroup, new RoundedBoxGeometry(0.56, 0.042, 0.075, 2, 0.006), obsidianMat, -0.24, 0.32, -0.45, 0.16, 0.06, 0.12);
    addPart(swayGroup, new RoundedBoxGeometry(0.56, 0.042, 0.075, 2, 0.006), obsidianMat, 0.24, 0.32, -0.45, 0.16, -0.06, -0.12);
    // Swept angular matte-obsidian A-pillar struts with subtle gold radar-absorbent edge sheen
    addPart(swayGroup, new RoundedBoxGeometry(0.052, 0.56, 0.075, 2, 0.008), obsidianMat, -0.5, 0.05, -0.45, -0.22, 0.28, -0.26);
    addPart(swayGroup, new RoundedBoxGeometry(0.052, 0.56, 0.075, 2, 0.008), obsidianMat, 0.5, 0.05, -0.45, -0.22, -0.28, 0.26);
    addPart(swayGroup, new THREE.BoxGeometry(0.008, 0.42, 0.012), brassMat, -0.47, 0.05, -0.43, -0.22, 0.28, -0.26);
    addPart(swayGroup, new THREE.BoxGeometry(0.008, 0.42, 0.012), brassMat, 0.47, 0.05, -0.43, -0.22, -0.28, 0.26);
    // Minimalist faceted stealth glareshield + low-observable faction accents
    addPart(swayGroup, new RoundedBoxGeometry(0.92, 0.11, 0.24, 2, 0.014), obsidianMat, 0, -0.32, -0.48, -0.28, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.16, 0.016, 0.05, 1, 0.003), factionMat, -0.3, -0.265, -0.44, -0.28, 0.12, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.16, 0.016, 0.05, 1, 0.003), factionMat, 0.3, -0.265, -0.44, -0.28, -0.12, 0);
    // Dim emerald/cyan stealth cloak & internal bomb-bay status indicators
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.12, 0.009, 0.007), cyanGlow, 0, -0.264, -0.405, -0.38, 0, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.075, 0.008, 0.007), greenGlow, -0.18, -0.272, -0.408, -0.34, 0.1, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.075, 0.008, 0.007), amberGlow, 0.18, -0.272, -0.408, -0.34, -0.1, 0),
    );
    // Sleek stealth HUD combiner glass with emerald-cyan bomb-drop chevrons
    const stealthHudMat = trackMat(
      new THREE.MeshBasicMaterial({
        color: 0x38f2ff,
        transparent: true,
        opacity: 0.12,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    const sPane = addPart(swayGroup, new THREE.PlaneGeometry(0.22, 0.088), stealthHudMat, 0, -0.205, -0.43, 0.16, 0, 0);
    sPane.renderOrder = 3;
    addPart(swayGroup, new THREE.BoxGeometry(0.068, 0.003, 0.002), cyanGlow, -0.055, -0.205, -0.425, 0.16, 0, 0);
    addPart(swayGroup, new THREE.BoxGeometry(0.068, 0.003, 0.002), cyanGlow, 0.055, -0.205, -0.425, 0.16, 0, 0);
    addMuzzleFlash(recoilGroup, 0, -0.34, -0.86, 1.65, 0x52f2ff);
  } else if (kind === "a10") {
    // A-10 Warthog Armored Cockpit: titanium windscreen bow + glowing green HUD combiner with gun-pipper brackets + dual throttle frame + nose GAU-8 muzzle flash!
    const armorGray = getChassisMat("#38424d", 0.44, 0.64);
    const hudGreenMat = trackMat(
      new THREE.MeshBasicMaterial({
        color: 0x3cff7a,
        transparent: true,
        opacity: 0.15,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    const hudLineMat = trackMat(
      new THREE.MeshBasicMaterial({
        color: 0x52ff8c,
        transparent: true,
        opacity: 0.88,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );

    // Armored titanium flat-windscreen A-pillars & upper canopy bow
    addPart(swayGroup, new RoundedBoxGeometry(0.056, 0.56, 0.08, 2, 0.008), armorGray, -0.47, 0.06, -0.45, -0.22, 0.26, -0.24);
    addPart(swayGroup, new RoundedBoxGeometry(0.056, 0.56, 0.08, 2, 0.008), armorGray, 0.47, 0.06, -0.45, -0.22, -0.26, 0.24);
    addPart(swayGroup, new RoundedBoxGeometry(0.84, 0.054, 0.08, 2, 0.008), armorGray, 0, 0.34, -0.46, 0.16, 0, 0);
    // Faction titanium armor trim strips along inner windscreen bow
    addPart(swayGroup, new THREE.BoxGeometry(0.014, 0.22, 0.02), factionMat, -0.44, 0.04, -0.43, -0.22, 0.26, -0.24);
    addPart(swayGroup, new THREE.BoxGeometry(0.014, 0.22, 0.02), factionMat, 0.44, 0.04, -0.43, -0.22, -0.26, 0.24);

    // Heavy armored glareshield coaming & MFD tactical dash
    addPart(swayGroup, new RoundedBoxGeometry(0.92, 0.125, 0.24, 2, 0.016), cockpitTrim, 0, -0.325, -0.48, -0.26, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.18, 0.052, 0.024, 1, 0.004), darkMetal, 0.24, -0.272, -0.42, -0.34, -0.12, 0);
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.115, 0.012, 0.008), greenGlow, 0.24, -0.266, -0.406, -0.34, -0.12, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.088, 0.008, 0.008), amberGlow, 0.24, -0.282, -0.404, -0.34, -0.12, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.042, 0.009, 0.008), redGlow, 0.11, -0.272, -0.408, -0.34, 0, 0),
    );

    // Left-side Dual TF34 Throttle Quadrant Frame & Twin Split Thrust Levers!
    addPart(swayGroup, new RoundedBoxGeometry(0.16, 0.075, 0.16, 2, 0.01), darkMetal, -0.32, -0.285, -0.43, -0.2, 0.14, 0);
    addPart(swayGroup, new THREE.BoxGeometry(0.012, 0.008, 0.11), gunMetal, -0.345, -0.246, -0.425, -0.2, 0.14, 0);
    addPart(swayGroup, new THREE.BoxGeometry(0.012, 0.008, 0.11), gunMetal, -0.295, -0.246, -0.425, -0.2, 0.14, 0);
    // Twin knurled throttle stalks & handles (Engine #1 + Engine #2)
    for (const tx of [-0.345, -0.295]) {
      addPart(swayGroup, new THREE.CylinderGeometry(0.007, 0.008, 0.085, 8), lightAlloy, tx, -0.22, -0.435, -0.32, 0, 0);
      addPart(swayGroup, new RoundedBoxGeometry(0.034, 0.018, 0.022, 1, 0.004), cockpitTrim, tx, -0.184, -0.45, -0.22, 0, 0);
    }
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.022, 0.008, 0.008), greenGlow, -0.345, -0.268, -0.365),
      addPart(swayGroup, new THREE.BoxGeometry(0.022, 0.008, 0.008), greenGlow, -0.295, -0.268, -0.365),
    );

    // Iconic Glowing Green A-10 Fighter HUD Glass Combiner & Gun-Pipper Brackets!
    addPart(swayGroup, new THREE.BoxGeometry(0.01, 0.145, 0.016), lightAlloy, -0.125, -0.185, -0.43, 0.18, 0, 0);
    addPart(swayGroup, new THREE.BoxGeometry(0.01, 0.145, 0.016), lightAlloy, 0.125, -0.185, -0.43, 0.18, 0, 0);
    addPart(swayGroup, new THREE.BoxGeometry(0.26, 0.009, 0.014), lightAlloy, 0, -0.115, -0.418, 0.18, 0, 0);
    const hudPane = addPart(swayGroup, new THREE.PlaneGeometry(0.238, 0.132), hudGreenMat, 0, -0.184, -0.428, 0.18, 0, 0);
    hudPane.renderOrder = 3;

    // Glowing Green Gun-Pipper Brackets + CCIP 30mm Pipper Ring + Pitch Ladder on Combiner Glass!
    for (const sx of [-1, 1]) {
      // Left & right vertical gun-pipper framing brackets with inward top/bottom serifs
      addPart(swayGroup, new THREE.BoxGeometry(0.0036, 0.068, 0.002), hudLineMat, sx * 0.062, -0.184, -0.424, 0.18, 0, 0);
      addPart(swayGroup, new THREE.BoxGeometry(0.018, 0.0034, 0.002), hudLineMat, sx * 0.054, -0.151, -0.418, 0.18, 0, 0);
      addPart(swayGroup, new THREE.BoxGeometry(0.018, 0.0034, 0.002), hudLineMat, sx * 0.054, -0.217, -0.43, 0.18, 0, 0);
      // Outer horizon wings
      addPart(swayGroup, new THREE.BoxGeometry(0.026, 0.003, 0.002), hudLineMat, sx * 0.092, -0.184, -0.424, 0.18, 0, 0);
    }
    // Center 30mm CCIP gun pipper ring + glowing center dot
    addPart(swayGroup, new THREE.TorusGeometry(0.022, 0.0024, 6, 24), greenGlow, 0, -0.184, -0.424, 0.18, 0, 0);
    glowPulses.push(
      addPart(swayGroup, new THREE.SphereGeometry(0.0045, 8, 8), greenGlow, 0, -0.184, -0.422),
    );
    // Upper heading tape ticks
    for (const hx of [-0.075, -0.045, -0.015, 0.015, 0.045, 0.075]) {
      addPart(swayGroup, new THREE.BoxGeometry(0.0026, 0.01, 0.002), hudLineMat, hx, -0.134, -0.417, 0.18, 0, 0);
    }

    // Protruding Nose GAU-8/A 30mm 7-Barrel Rotary Gatling Tip & Blazing Golden-Amber Muzzle Flash!
    const gauGroup = new THREE.Group();
    gauGroup.position.set(0, -0.34, -0.84);
    recoilGroup.add(gauGroup);
    addPart(gauGroup, new THREE.CylinderGeometry(0.032, 0.036, 0.28, 12), gunMetal, 0, 0, 0.08, Math.PI / 2, 0, 0);
    const gauCluster = new THREE.Group();
    gauCluster.position.set(0, 0, -0.12);
    gauGroup.add(gauCluster);
    for (let i = 0; i < 6; i++) {
      const ang = (i * Math.PI * 2) / 6;
      addPart(
        gauCluster,
        new THREE.CylinderGeometry(0.0065, 0.0065, 0.26, 8),
        darkMetal,
        Math.cos(ang) * 0.016,
        Math.sin(ang) * 0.016,
        0,
        Math.PI / 2,
        0,
        0,
      );
    }
    addPart(gauCluster, new THREE.CylinderGeometry(0.026, 0.026, 0.022, 12), lightAlloy, 0, 0, -0.08, Math.PI / 2, 0, 0);
    spinners.push({ obj: gauCluster, axis: "z", speed: 24 });
    addMuzzleFlash(gauGroup, 0, 0, -0.3, 2.45, 0xffb438);
  } else if (kind === "ac130") {
    // AC-130 Spectre FLIR Gunner Optics: crisp military thermal-scope framing bezel + azimuth ticks + glowing side-mounted 105mm howitzer barrel!
    const flirObsidian = getChassisMat("#141920", 0.56, 0.44);
    const flirTickGlow = getGlowMat("#58ffa0", 1.7);
    const thermalHotGlow = getGlowMat("#ff9832", 1.65);
    const flirTintMat = trackMat(
      new THREE.MeshBasicMaterial({
        color: 0x38ff8c,
        transparent: true,
        opacity: 0.06,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );

    // Military Thermal-Scope Perimeter Framing Bezel (clean wide-open center for gunship fire control!)
    addPart(swayGroup, new RoundedBoxGeometry(1.12, 0.055, 0.1, 2, 0.01), flirObsidian, 0, 0.345, -0.45, 0.12, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(1.14, 0.075, 0.14, 2, 0.012), flirObsidian, 0, -0.34, -0.46, -0.22, 0, 0);
    for (const sx of [-1, 1]) {
      addPart(swayGroup, new RoundedBoxGeometry(0.056, 0.68, 0.1, 2, 0.01), flirObsidian, sx * 0.54, 0.0, -0.45, 0, -sx * 0.16, 0);
      // Glowing phosphor-green FLIR thermal scope corner L-brackets
      for (const sy of [-1, 1]) {
        addPart(swayGroup, new THREE.BoxGeometry(0.095, 0.0055, 0.006), flirTickGlow, sx * 0.4, sy * 0.265, -0.43);
        addPart(swayGroup, new THREE.BoxGeometry(0.0055, 0.078, 0.006), flirTickGlow, sx * 0.445, sy * 0.228, -0.43);
      }
      // Side elevation stadia ticks along inner left/right thermal-scope bezel
      for (const ey of [-0.12, -0.06, 0, 0.06, 0.12]) {
        const tickW = ey === 0 ? 0.032 : 0.018;
        addPart(swayGroup, new THREE.BoxGeometry(tickW, 0.0038, 0.004), flirTickGlow, sx * 0.44, ey, -0.43);
      }
    }

    // Upper Azimuth Compass Tick Strip + Center Lubber Marker across top FLIR bezel!
    for (let i = -6; i <= 6; i++) {
      const major = i % 3 === 0;
      addPart(
        swayGroup,
        new THREE.BoxGeometry(major ? 0.005 : 0.003, major ? 0.022 : 0.012, 0.004),
        i === 0 ? cyanGlow : flirTickGlow,
        i * 0.048,
        0.295,
        -0.43,
      );
    }
    addPart(swayGroup, new THREE.BoxGeometry(0.62, 0.003, 0.004), flirTickGlow, 0, 0.308, -0.432);

    // Subtle upper & lower thermal-optic glass rim bands (keeps center razor clear)
    const flirGlassTop = addPart(swayGroup, new THREE.PlaneGeometry(0.96, 0.06), flirTintMat, 0, 0.295, -0.44);
    flirGlassTop.renderOrder = 2;

    // Lower FCO Fire-Control Console: 105MM / 40MM / 25MM weapon-station status LEDs + spinning FLIR gimbal lock ring
    addPart(swayGroup, new RoundedBoxGeometry(0.14, 0.018, 0.024, 1, 0.003), factionMat, -0.34, -0.3, -0.42);
    addPart(swayGroup, new RoundedBoxGeometry(0.14, 0.018, 0.024, 1, 0.003), factionMat, 0.34, -0.3, -0.42);
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.056, 0.01, 0.008), thermalHotGlow, -0.14, -0.298, -0.415),
      addPart(swayGroup, new THREE.BoxGeometry(0.046, 0.01, 0.008), amberGlow, -0.072, -0.298, -0.415),
      addPart(swayGroup, new THREE.BoxGeometry(0.046, 0.01, 0.008), flirTickGlow, 0.072, -0.298, -0.415),
      addPart(swayGroup, new THREE.BoxGeometry(0.056, 0.01, 0.008), cyanGlow, 0.14, -0.298, -0.415),
    );
    const flirLockRing = addPart(swayGroup, new THREE.TorusGeometry(0.036, 0.004, 8, 24), flirTickGlow, 0, -0.298, -0.42);
    spinners.push({ obj: flirLockRing, axis: "z", speed: -1.8 });

    // Glowing Side-Mounted 105mm M102 Howitzer Barrel Protruding from Port Gun Bay!
    const howitzer = new THREE.Group();
    howitzer.position.set(-0.34, -0.26, -0.78);
    howitzer.rotation.set(0.06, -0.26, 0.05);
    recoilGroup.add(howitzer);
    // Heavy armored blast shroud & recoil recuperator cradle
    addPart(howitzer, new RoundedBoxGeometry(0.12, 0.11, 0.28, 2, 0.016), darkMetal, 0, -0.01, 0.24);
    addPart(howitzer, new THREE.CylinderGeometry(0.048, 0.056, 0.34, 16), gunMetal, 0, 0, 0.02, Math.PI / 2, 0, 0);
    // Long heavy-caliber 105mm rifled tube + slotted muzzle brake collar
    addPart(howitzer, new THREE.CylinderGeometry(0.038, 0.045, 0.56, 16), lightAlloy, 0, 0, -0.34, Math.PI / 2, 0, 0);
    addPart(howitzer, new THREE.CylinderGeometry(0.052, 0.05, 0.09, 14), darkMetal, 0, 0, -0.62, Math.PI / 2, 0, 0);
    // Glowing superheated thermal barrel sleeve & bore ring (distinctive FLIR thermal signature!)
    glowPulses.push(
      addPart(howitzer, new THREE.TorusGeometry(0.044, 0.0065, 8, 20), thermalHotGlow, 0, 0, -0.48),
      addPart(howitzer, new THREE.TorusGeometry(0.048, 0.0055, 8, 20), thermalHotGlow, 0, 0, -0.65),
    );
    addMuzzleFlash(howitzer, 0, 0, -0.74, 2.55, 0xffa634);
  } else if (kind === "hypersonic") {
    // Mach-9 Kamikaze: ultra-sleek terminal-dive thermal visor + delta needle nose + cyan-gold plasma rails + armed crimson warhead bar!
    const titaniumMat = getChassisMat("#323d4c", 0.24, 0.86);
    addAircraftCanopy(false, false);
    // Swept aerodynamic Mach-9 thermal visor arch overlay + armed kamikaze red warning bar
    addPart(swayGroup, new RoundedBoxGeometry(0.76, 0.026, 0.07, 2, 0.006), titaniumMat, 0, 0.345, -0.45, 0.22, 0, 0);
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.14, 0.01, 0.008), redGlow, 0, 0.318, -0.425),
    );
    // Long needle-sharp hypersonic delta nose cone & chine strakes extending forward!
    addPart(swayGroup, new THREE.ConeGeometry(0.068, 0.68, 6), titaniumMat, 0, -0.315, -0.92, -Math.PI / 2, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.14, 0.022, 0.42, 1, 0.004), factionMat, 0, -0.302, -0.78, 0.04, 0, 0);
    // Superheated gold-amber plasma tip + blazing cyan scramjet plasma glow rails along the swept nose chines
    glowPulses.push(
      addPart(swayGroup, new THREE.ConeGeometry(0.032, 0.16, 8), amberGlow, 0, -0.315, -1.24, -Math.PI / 2, 0, 0),
    );
    for (const sx of [-1, 1]) {
      glowPulses.push(
        addPart(swayGroup, new THREE.BoxGeometry(0.012, 0.012, 0.46), cyanGlow, sx * 0.095, -0.305, -0.82, 0.04, -sx * 0.14, 0),
        addPart(swayGroup, new THREE.BoxGeometry(0.009, 0.009, 0.34), amberGlow, sx * 0.125, -0.302, -0.86, 0.04, -sx * 0.14, 0),
      );
      addMuzzleFlash(recoilGroup, sx * 0.18, -0.28, -1.16, 2.15, 0xffaa38);
    }
    addMuzzleFlash(recoilGroup, 0, -0.31, -1.28, 2.45, 0x72f8ff);
  } else if (kind === "carrier") {
    // Nimitz Carrier: commanding panoramic supercarrier island bridge + helm radar + catapult flight deck!
    // Wide commanding bridge window brow & heavy sloped bridge stanchions
    addPart(swayGroup, new RoundedBoxGeometry(1.18, 0.07, 0.16, 2, 0.012), cockpitTrim, 0, 0.355, -0.45, 0.14, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.056, 0.62, 0.09, 2, 0.008), cockpitTrim, -0.54, 0.04, -0.45, -0.1, 0.2, -0.1);
    addPart(swayGroup, new RoundedBoxGeometry(0.056, 0.62, 0.09, 2, 0.008), cockpitTrim, 0.54, 0.04, -0.45, -0.1, -0.2, 0.1);
    // Subtle slim upper bridge window mullions (leaves wide panoramic view clear)
    addPart(swayGroup, new RoundedBoxGeometry(0.022, 0.14, 0.04, 1, 0.004), gunMetal, -0.25, 0.295, -0.45, 0.12, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.022, 0.14, 0.04, 1, 0.004), gunMetal, 0.25, 0.295, -0.45, 0.12, 0, 0);
    // Commanding bridge console desk + faction fleet insignia trim
    addPart(swayGroup, new RoundedBoxGeometry(1.14, 0.115, 0.26, 2, 0.016), cockpitTrim, 0, -0.33, -0.48, -0.22, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.24, 0.024, 0.04, 1, 0.004), factionMat, -0.38, -0.275, -0.43, -0.22, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.24, 0.024, 0.04, 1, 0.004), factionMat, 0.38, -0.275, -0.43, -0.22, 0, 0);
    // Central illuminated tactical fleet radar table with sweeping cyan radar beam!
    addPart(swayGroup, new THREE.CylinderGeometry(0.072, 0.078, 0.022, 20), darkMetal, 0, -0.275, -0.42, 0.42, 0, 0);
    addPart(swayGroup, new THREE.CylinderGeometry(0.062, 0.062, 0.006, 20), glassTint, 0, -0.266, -0.415, 0.42, 0, 0);
    const radarSweep = new THREE.Group();
    radarSweep.position.set(0, -0.262, -0.412);
    radarSweep.rotation.x = 0.42;
    swayGroup.add(radarSweep);
    addPart(radarSweep, new THREE.BoxGeometry(0.006, 0.004, 0.056), cyanGlow, 0, 0, -0.028);
    spinners.push({ obj: radarSweep, axis: "y", speed: -2.4 });
    // Port & starboard fleet air-wing telemetry MFD strips + brass telegraph levers
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.11, 0.012, 0.008), greenGlow, -0.2, -0.272, -0.415, -0.3, 0.1, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.11, 0.012, 0.008), cyanGlow, 0.2, -0.272, -0.415, -0.3, -0.1, 0),
    );
    addPart(swayGroup, new THREE.CylinderGeometry(0.009, 0.009, 0.07, 8), brassMat, -0.115, -0.265, -0.42, -0.22, 0, 0);
    addPart(swayGroup, new THREE.CylinderGeometry(0.009, 0.009, 0.07, 8), brassMat, 0.115, -0.265, -0.42, -0.22, 0, 0);
    // Forward flight deck bow strip & twin electromagnetic catapult launch rails visible low ahead
    addPart(swayGroup, new RoundedBoxGeometry(0.56, 0.024, 0.58, 2, 0.006), gunMetal, 0, -0.365, -0.88, 0.04, 0, 0);
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.014, 0.006, 0.48), amberGlow, -0.12, -0.35, -0.88, 0.04, 0, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.014, 0.006, 0.48), amberGlow, 0.12, -0.35, -0.88, 0.04, 0, 0),
    );
    // Twin forward CIWS / drone-catapult launch muzzle flashes
    addPart(recoilGroup, new THREE.CylinderGeometry(0.018, 0.02, 0.28, 10), lightAlloy, -0.24, -0.3, -0.78, Math.PI / 2, 0, 0);
    addPart(recoilGroup, new THREE.CylinderGeometry(0.018, 0.02, 0.28, 10), lightAlloy, 0.24, -0.3, -0.78, Math.PI / 2, 0, 0);
    addMuzzleFlash(recoilGroup, -0.24, -0.3, -0.96, 1.5, 0x62f2ff);
    addMuzzleFlash(recoilGroup, 0.24, -0.3, -0.96, 1.5, 0x62f2ff);
  } else {
    // Kraken Sub: armored periscope visor bezel framing the ocean surface
    // Outer thick dark submarine steel ring (leaves huge clean optical viewport in center)
    addPart(swayGroup, new THREE.TorusGeometry(0.365, 0.056, 12, 32), cockpitTrim, 0, 0, -0.47);
    // Inner machined brass/steel optical collar
    addPart(swayGroup, new THREE.TorusGeometry(0.312, 0.011, 10, 32), brassMat, 0, 0, -0.46);
    // Subtle optical glass edge rim
    addPart(swayGroup, new THREE.TorusGeometry(0.302, 0.006, 8, 32), glassTint, 0, 0, -0.458);
    // Clamp bolts around bezel
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2 + Math.PI / 8;
      addPart(
        swayGroup,
        new THREE.CylinderGeometry(0.013, 0.013, 0.025, 8),
        lightAlloy,
        Math.cos(ang) * 0.365,
        Math.sin(ang) * 0.365,
        -0.43,
        Math.PI / 2,
        0,
        0,
      );
    }
    // Lower torpedo tube readiness LEDs
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.044, 0.012, 0.01), cyanGlow, -0.1, -0.305, -0.42),
      addPart(swayGroup, new THREE.BoxGeometry(0.044, 0.012, 0.01), cyanGlow, 0.1, -0.305, -0.42),
    );
    addMuzzleFlash(recoilGroup, 0, -0.26, -0.78, 1.35, 0x52f2ff);
  }

  return {
    root,
    swayGroup,
    recoilGroup,
    keyLight,
    muzzleFlashes,
    spinners,
    glowPulses,
    supplyBar,
    geometries,
    uniqueMaterials,
  };
}

// ---------- First-Person 3D Controller ----------

export class FirstPersonController {
  active = false;
  entId: number | null = null;
  onExit: (reason?: "dead" | "user") => void = () => {};
  onFireSfx: (kind: EntKind, vet: number) => void = () => {};
  // Auxiliary 1P feedback sfx: "lock" | "locked" | "lost" | "sprint" | "boost"
  // | "wpn" | "ads" | "crouch" | "hitmark" | "damage" | "climb" | "dive"
  onSfx: (name: string) => void = () => {};

  private gs: GameScene;
  private renderer: Renderer;
  private net: Net;
  private getSlot: () => number;
  private isAlly: (slot: number) => boolean;

  private kind: UnitKind = "tank";
  private domain: UnitDomain = "land";
  private profile: UnitCameraProfile = UNIT_PROFILES.tank;

  // Predicted world position & damped camera orientation
  private predX = 32;
  private predY = 32;
  private curEyeY = 1.0;
  private targetYaw = 0;
  private targetPitch = 0;
  private renderYaw = 0;
  private renderPitch = 0;
  private curFov = 68;
  private curSpeed = 0;

  // Input state
  private keys = new Set<string>();
  private pointerLocked = false;
  private dragLooking = false;
  private lastMouseX = 0;
  private lastMouseY = 0;
  private mouseFire = false;
  private lastFireSent = false;
  private lastDriveSentAt = 0;

  // Animation, recoil & viewmodel state
  private viewmodel: ViewmodelRig | null = null;
  private bobPhase = 0;
  private swayX = 0;
  private swayY = 0;
  private swayRoll = 0;
  private recoil = 0;
  private pitchKick = 0;
  private flashTimer = 0;
  private lastShotAt = 0;
  private reloadDurMs = 0;
  private elapsed = 0;

  // Reusable math objects
  private raycaster = new THREE.Raycaster();
  private camPos = new THREE.Vector3();
  private groundHit = new THREE.Vector3();
  private lastTelemetry: FpvTelemetry | null = null;

  // Bound event listeners (stored for clean disposal)
  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundKeyUp: (e: KeyboardEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundPointerDown: (e: PointerEvent) => void;
  private boundPointerUp: (e: PointerEvent) => void;
  private boundContextMenu: (e: MouseEvent) => void;
  private boundPointerLockChange: () => void;
  private boundBlur: () => void;
  private boundWheel: (e: WheelEvent) => void;

  constructor(
    gs: GameScene,
    renderer: Renderer,
    net: Net,
    getSlot: () => number,
    isAlly: (slot: number) => boolean,
  ) {
    this.gs = gs;
    this.renderer = renderer;
    this.net = net;
    this.getSlot = getSlot;
    this.isAlly = isAlly;
    this.predX = gs.mapW / 2;
    this.predY = gs.mapH / 2;

    this.boundKeyDown = (e) => this.onKeyDown(e);
    this.boundKeyUp = (e) => this.onKeyUp(e);
    this.boundMouseMove = (e) => this.onMouseMove(e);
    this.boundPointerDown = (e) => this.onPointerDown(e);
    this.boundPointerUp = (e) => this.onPointerUp(e);
    this.boundContextMenu = (e) => {
      if (this.active) e.preventDefault();
    };
    this.boundPointerLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.gs.canvas;
      if (this.pointerLocked) {
        this.dragLooking = false;
      }
    };
    this.boundBlur = () => {
      this.keys.clear();
      this.mouseFire = false;
      this.dragLooking = false;
    };
    this.boundWheel = (e) => {
      if (this.active) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };

    const canvas = this.gs.canvas;
    // Capture phase ensures FPV controls intercept WASD/Space/clicks before RTS Input handlers while active
    window.addEventListener("keydown", this.boundKeyDown, true);
    window.addEventListener("keyup", this.boundKeyUp, true);
    window.addEventListener("mousemove", this.boundMouseMove);
    canvas.addEventListener("pointerdown", this.boundPointerDown, true);
    window.addEventListener("pointerup", this.boundPointerUp);
    canvas.addEventListener("contextmenu", this.boundContextMenu);
    canvas.addEventListener("wheel", this.boundWheel, { capture: true, passive: false });
    document.addEventListener("pointerlockchange", this.boundPointerLockChange);
    window.addEventListener("blur", this.boundBlur);
  }

  enter(id: number): boolean {
    const t = this.renderer.tracked.get(id);
    if (!t) return false;
    if (t.last.o !== this.getSlot()) return false;
    if (isBuildingKind(t.last.k)) return false;

    // Clean up any previous FPV session cleanly without triggering external exit callback
    if (this.active) {
      this.disposeViewmodel();
      this.renderer.setHiddenEntity(null);
      if (this.entId !== null && this.entId !== id) {
        this.net.send({ t: "driveExit", id: this.entId });
      }
    }

    const kind = t.last.k as UnitKind;
    const def = UNITS[kind];
    const profile = UNIT_PROFILES[kind] ?? DEFAULT_PROFILE;
    const pos = this.renderer.getEntityWorldPos(id) ?? { x: t.last.x, y: t.last.y, d: t.last.d / 10 };

    this.entId = id;
    this.kind = kind;
    this.domain = def.domain;
    this.profile = profile;
    this.predX = pos.x;
    this.predY = pos.y;
    const initYaw = wrapAngle(pos.d);
    const initPitch = def.domain === "air" ? -0.22 : profile.initPitch;
    this.targetYaw = initYaw;
    this.renderYaw = initYaw;
    this.targetPitch = initPitch;
    this.renderPitch = initPitch;
    this.curFov = profile.fov;
    this.curEyeY = kind === "sub" && t.last.sub && profile.subEyeY !== undefined ? profile.subEyeY : profile.eyeY;
    this.curSpeed = 0;

    this.keys.clear();
    this.mouseFire = false;
    this.dragLooking = false;
    this.lastFireSent = false;
    this.lastDriveSentAt = 0;
    this.bobPhase = 0;
    this.swayX = 0;
    this.swayY = 0;
    this.swayRoll = 0;
    this.recoil = 0;
    this.pitchKick = 0;
    this.flashTimer = 0;
    this.lastShotAt = 0;
    this.reloadDurMs = def.rof > 0 ? def.rof * TICK_MS : 0;

    // Build sculpted 3D weapon / cockpit viewmodel attached to camera
    const factionColor = this.renderer.slotColors.get(t.last.o) ?? "#3390ff";
    this.viewmodel = buildViewmodel(kind, factionColor);
    this.gs.camera.add(this.viewmodel.root);

    // Hide our own unit mesh so we don't see the inside of its hull/helmet
    this.renderer.setHiddenEntity(id);
    this.active = true;

    // Place camera immediately so there's zero 1-frame jump
    this.camPos.set(this.predX, this.curEyeY, this.predY);
    this.gs.setFpvCamera(this.camPos, this.renderYaw, this.renderPitch, this.curFov);

    // Attempt pointer lock safely (browsers may reject outside user gesture or in headless mode)
    this.requestLock();

    return true;
  }

  exit(reason: "dead" | "user" = "user", silent = false): void {
    if (!this.active) return;
    const prevId = this.entId;
    this.active = false;
    this.entId = null;
    this.keys.clear();
    this.mouseFire = false;
    this.dragLooking = false;
    this.lastFireSent = false;
    this.lastTelemetry = null;

    if (!silent && reason === "user" && prevId !== null) {
      this.net.send({ t: "driveExit", id: prevId });
    }

    this.disposeViewmodel();
    this.renderer.setHiddenEntity(null);

    if (document.pointerLockElement === this.gs.canvas) {
      try {
        document.exitPointerLock?.();
      } catch {
        /* ignore pointer lock exit errors */
      }
    }
    this.pointerLocked = false;

    this.gs.restoreRtsCamera(this.predX, this.predY);
    if (!silent) this.onExit(reason);
  }

  requestLock(): void {
    try {
      const req = (this.gs.canvas as HTMLCanvasElement & { requestPointerLock?: () => Promise<void> | void })
        .requestPointerLock;
      if (typeof req === "function") {
        const res = req.call(this.gs.canvas);
        if (res && typeof (res as Promise<void>).catch === "function") {
          (res as Promise<void>).catch(() => {
            /* pointer lock declined or unsupported — drag-look & keyboard turn remain active */
          });
        }
      }
    } catch {
      /* ignore pointer lock errors */
    }
  }

  // Called when a shot event fires (accepts no args, shooter entity id, or GameEvent)
  onShotEvent(srcOrEv?: number | Extract<GameEvent, { e: "shot" }>): void {
    if (!this.active || this.entId === null) return;
    let vet = 0;
    if (srcOrEv !== undefined) {
      if (typeof srcOrEv === "number") {
        if (srcOrEv !== this.entId) return;
      } else {
        if (srcOrEv.src !== this.entId) return;
        vet = srcOrEv.vet ?? 0;
      }
    }
    const t = this.renderer.tracked.get(this.entId);
    if (t && vet === 0) vet = t.last.vet ?? 0;

    this.lastShotAt = performance.now();
    this.recoil = 1.0;
    this.pitchKick = Math.min(0.08, this.pitchKick + this.profile.recoilPitch);
    this.flashTimer = 0.085;
    this.gs.shake(this.profile.recoilShake);
    this.onFireSfx(this.kind, vet);
  }

  // Optional batch helper so caller can pass snapshot events directly
  onEvents(events: GameEvent[]): void {
    if (!this.active || this.entId === null) return;
    for (const ev of events) {
      if (ev.e === "shot" && ev.src === this.entId) {
        this.onShotEvent(ev);
      } else if (ev.e === "hit" && ev.id === this.entId) {
        this.gs.shake(0.26);
      }
    }
  }

  getTelemetry(): FpvTelemetry | null {
    return this.lastTelemetry;
  }

  update(dt: number): FpvTelemetry | null {
    if (!this.active || this.entId === null) return null;

    const t = this.renderer.tracked.get(this.entId);
    if (!t || t.last.hp <= 0 || t.last.o !== this.getSlot()) {
      this.exit("dead");
      return null;
    }

    const clampedDt = Math.min(0.05, Math.max(0.001, dt));
    this.elapsed += clampedDt;

    const def = UNITS[this.kind];
    const prof = this.profile;

    // 1. Read WASD + Arrow controls
    const fwdIn =
      (this.keys.has("KeyW") || this.keys.has("ArrowUp") ? 1 : 0) -
      (this.keys.has("KeyS") || this.keys.has("ArrowDown") ? 1 : 0);
    const adIn = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
    const arrowTurn = (this.keys.has("ArrowRight") ? 1 : 0) - (this.keys.has("ArrowLeft") ? 1 : 0);

    let strafeIn = 0;
    let steerTurn = arrowTurn;
    if (prof.strafeMode === "strafe") {
      strafeIn = adIn;
    } else {
      // Ground vehicles, naval ships & jets: A/D smoothly steers yaw + light lateral drift
      steerTurn += adIn;
      strafeIn = adIn * 0.3;
    }

    if (steerTurn !== 0) {
      const deltaYaw = steerTurn * prof.turnRate * clampedDt;
      this.targetYaw = wrapAngle(this.targetYaw + deltaYaw);
      this.swayX = clamp(this.swayX - deltaYaw * 0.25, -0.05, 0.05);
      this.swayRoll = clamp(this.swayRoll - deltaYaw * 0.7, -0.09, 0.09);
    }

    // Silky-smooth exponentially damped mouse/keyboard look (eliminates polling stair-stepping)
    const lookAlpha = 1 - Math.exp(-36 * clampedDt);
    const yawDiff = wrapAngle(this.targetYaw - this.renderYaw);
    this.renderYaw = wrapAngle(this.renderYaw + yawDiff * lookAlpha);
    this.renderPitch += (this.targetPitch - this.renderPitch) * lookAlpha;

    // 2. 60fps Client-Side Movement Prediction with terrain wall-sliding
    let vx = Math.cos(this.renderYaw) * fwdIn - Math.sin(this.renderYaw) * strafeIn;
    let vy = Math.sin(this.renderYaw) * fwdIn + Math.cos(this.renderYaw) * strafeIn;
    const vLen = Math.hypot(vx, vy);
    if (vLen > 1) {
      vx /= vLen;
      vy /= vLen;
    }

    const baseMaxTilesPerSec = def.speed * 1.15 * 10;
    const fuelMult = t.last.fl !== undefined && t.last.fl <= 0 ? 0.38 : 1;
    const maxTilesPerSec = baseMaxTilesPerSec * fuelMult;
    const step = maxTilesPerSec * clampedDt;
    const prevX = this.predX;
    const prevY = this.predY;

    if (vLen > 0.001) {
      const nx = this.predX + vx * step;
      const ny = this.predY + vy * step;
      if (this.canOccupy(nx, ny, this.domain)) {
        this.predX = nx;
        this.predY = ny;
      } else if (this.canOccupy(nx, this.predY, this.domain)) {
        this.predX = nx;
      } else if (this.canOccupy(this.predX, ny, this.domain)) {
        this.predY = ny;
      }
    }

    // 3. Zero-rubberband authoritative server reconciliation:
    // Project 5 Hz server snapshot forward by ~160ms of current velocity; apply a 0.85-tile
    // deadzone while moving (zero backward pull under normal latency!) and gently correct outside it.
    if (vLen > 0.01) {
      const srvProjX = t.last.x + vx * maxTilesPerSec * 0.16;
      const srvProjY = t.last.y + vy * maxTilesPerSec * 0.16;
      const errX = srvProjX - this.predX;
      const errY = srvProjY - this.predY;
      const errDist = Math.hypot(errX, errY);
      if (errDist > 4.0) {
        this.predX = t.last.x;
        this.predY = t.last.y;
      } else if (errDist > 0.85) {
        const excessFrac = (errDist - 0.85) / errDist;
        const blend = 1 - Math.exp(-2.8 * clampedDt);
        this.predX += errX * excessFrac * blend;
        this.predY += errY * excessFrac * blend;
      }
    } else {
      const errX = t.last.x - this.predX;
      const errY = t.last.y - this.predY;
      const errDist = Math.hypot(errX, errY);
      if (errDist > 4.0) {
        this.predX = t.last.x;
        this.predY = t.last.y;
      } else if (errDist > 0.0005) {
        const blend = 1 - Math.exp(-6.5 * clampedDt);
        this.predX += errX * blend;
        this.predY += errY * blend;
      }
    }

    const { w: mapW, h: mapH } = this.getMapBounds();
    this.predX = clamp(this.predX, 0.6, mapW - 0.6);
    this.predY = clamp(this.predY, 0.6, mapH - 0.6);

    const actualDisp = Math.hypot(this.predX - prevX, this.predY - prevY);
    const instantSpeed = actualDisp / clampedDt;
    this.curSpeed += (instantSpeed - this.curSpeed) * (1 - Math.exp(-12 * clampedDt));

    // 4. Compute eye height, bob, sprint FOV easing & subtle recoil pitch kick
    const firing = (this.mouseFire || this.keys.has("Space")) && def.range > 0;
    const kamikazeDive = Boolean(def.kamikaze) && firing;
    const submerged = this.kind === "sub" && Boolean(t.last.sub);
    const baseEyeY = submerged && prof.subEyeY !== undefined ? prof.subEyeY : prof.eyeY;
    const targetEyeY = kamikazeDive && this.domain === "air" ? Math.max(0.85, baseEyeY - 0.9) : baseEyeY;
    this.curEyeY += (targetEyeY - this.curEyeY) * (1 - Math.exp(-(kamikazeDive ? 8 : 6) * clampedDt));

    const moveRatio = clamp(this.curSpeed / Math.max(0.5, baseMaxTilesPerSec), 0, 1);
    if (moveRatio > 0.05) {
      this.bobPhase += clampedDt * prof.bobFreq * (0.65 + moveRatio * 0.45);
    } else if (this.domain === "sea" || this.domain === "air") {
      this.bobPhase += clampedDt * prof.bobFreq * 0.5;
    }

    const idleHeave =
      this.domain === "sea"
        ? Math.sin(this.elapsed * (this.kind === "usv" ? 3.0 : 2.1)) * (this.kind === "usv" ? 0.02 : 0.032)
        : this.domain === "air"
          ? Math.sin(this.elapsed * 2.6) * (this.kind === "fpvdrone" ? 0.028 : 0.045)
          : 0;
    const walkBobY = Math.sin(this.bobPhase * 2) * prof.bobAmp * moveRatio;

    // Smooth sprint / forward-flight / kamikaze terminal-dive FOV boost
    const forwardSpeedFrac = fwdIn > 0.1 ? moveRatio : 0;
    const targetFov = prof.fov + forwardSpeedFrac * 4.5 + (kamikazeDive ? 5.5 : 0);
    this.curFov += (targetFov - this.curFov) * (1 - Math.exp(-7 * clampedDt));

    // Decay pitch kick smoothly
    this.pitchKick *= Math.exp(-clampedDt * 14);
    if (this.pitchKick < 0.0005) this.pitchKick = 0;

    // 5. Update 3D FPV Camera
    const camY = this.curEyeY + idleHeave + walkBobY;
    this.camPos.set(this.predX, camY, this.predY);
    const divePitch = kamikazeDive && this.domain === "air" ? -0.14 : 0;
    const effPitch = clamp(this.renderPitch + this.pitchKick + divePitch, prof.minPitch, prof.maxPitch + 0.08);
    this.gs.setFpvCamera(this.camPos, this.renderYaw, effPitch, this.curFov);
    this.gs.camera.updateMatrixWorld();

    // 6. Animate camera-attached 3D weapon / cockpit viewmodel
    const supplyFrac =
      this.kind === "supplytruck"
        ? clamp((t.last.cargo ?? (UNITS.supplytruck.capacity ?? 500)) / Math.max(1, UNITS.supplytruck.capacity ?? 500), 0.04, 1)
        : 1;
    this.updateViewmodel(clampedDt, moveRatio, supplyFrac);

    // 7. Center-Screen 3D Crosshair Raycast for aiming & telemetry
    const aim = this.computeCrosshairAim(def);

    // 8. Send drive packet at ~18 Hz (every 55ms) or immediately on fire state edge
    const now = performance.now();
    if (now - this.lastDriveSentAt >= DRIVE_SEND_INTERVAL_MS || firing !== this.lastFireSent) {
      this.lastDriveSentAt = now;
      this.lastFireSent = firing;
      this.net.send({
        t: "drive",
        id: this.entId,
        fwd: Math.round(fwdIn * 1000) / 1000,
        strafe: Math.round(strafeIn * 1000) / 1000,
        yaw: Math.round(this.renderYaw * 10000) / 10000,
        fire: firing,
        aimX: Math.round(aim.aimX * 100) / 100,
        aimY: Math.round(aim.aimY * 100) / 100,
        aimTarget: aim.target?.enemy ? aim.target.id : undefined,
      });
    }

    // 9. Build live telemetry snapshot for HUD
    const headingDeg = ((Math.round(((this.renderYaw + Math.PI / 2) * 180) / Math.PI) % 360) + 360) % 360;
    const reloading =
      this.reloadDurMs > 0 && this.lastShotAt > 0
        ? clamp(1 - (now - this.lastShotAt) / this.reloadDurMs, 0, 1)
        : 0;

    const telemetry: FpvTelemetry = {
      id: this.entId,
      kind: this.kind,
      domain: this.domain,
      hp: t.last.hp,
      mhp: t.last.mhp,
      vet: t.last.vet ?? 0,
      fuel: t.last.fl,
      ammo: t.last.am,
      speed: Number(this.curSpeed.toFixed(2)),
      altitude: this.domain === "air" ? Number((camY * 10).toFixed(0)) : 0,
      headingDeg,
      submerged,
      pointerLocked: this.pointerLocked,
      reloading,
      sprint: false,
      alt: 0,
      wpn: 0,
      wpnName: "",
      lockState: "none",
      lockPct: 0,
      crouch: false,
      target: aim.target,
      aimDist: Number(aim.aimDist.toFixed(1)),
    };
    this.lastTelemetry = telemetry;
    return telemetry;
  }

  dispose(): void {
    if (this.active) this.exit("user", true);
    const canvas = this.gs.canvas;
    window.removeEventListener("keydown", this.boundKeyDown, true);
    window.removeEventListener("keyup", this.boundKeyUp, true);
    window.removeEventListener("mousemove", this.boundMouseMove);
    canvas.removeEventListener("pointerdown", this.boundPointerDown, true);
    window.removeEventListener("pointerup", this.boundPointerUp);
    canvas.removeEventListener("contextmenu", this.boundContextMenu);
    canvas.removeEventListener("wheel", this.boundWheel, true);
    document.removeEventListener("pointerlockchange", this.boundPointerLockChange);
    window.removeEventListener("blur", this.boundBlur);
  }

  // ---------- internal helpers ----------

  private getMapBounds(): { w: number; h: number } {
    return { w: this.gs.mapW, h: this.gs.mapH };
  }

  private canOccupy(x: number, y: number, domain: UnitDomain): boolean {
    const { w: mapW, h: mapH } = this.getMapBounds();
    if (x < 0.6 || x > mapW - 0.6 || y < 0.6 || y > mapH - 0.6) return false;
    if (domain === "air") return true;
    if (domain === "sea") return this.gs.isWater(x, y);
    return !this.gs.isCliff(x, y) && !this.gs.isWater(x, y);
  }

  private computeCrosshairAim(def: (typeof UNITS)[UnitKind]): {
    aimX: number;
    aimY: number;
    aimDist: number;
    target: FpvTelemetry["target"];
  } {
    const { w: mapW, h: mapH } = this.getMapBounds();
    this.raycaster.setFromCamera(CENTER_NDC, this.gs.camera);
    const visibleRoots = this.gs.pickables.filter(
      (r) => r.visible && r.userData?.entityId !== this.entId,
    );
    const hits = this.raycaster.intersectObjects(visibleRoots, true);
    const mySlot = this.getSlot();

    for (const h of hits) {
      if (h.object.userData?.isBar || h.object.userData?.isAirShadow) continue;
      let o: THREE.Object3D | null = h.object;
      let skip = false;
      let foundId: number | undefined;
      while (o) {
        if (!o.visible || o.userData?.isBar || o.userData?.isAirShadow) {
          skip = true;
          break;
        }
        if (foundId === undefined && o.userData?.entityId !== undefined) {
          foundId = o.userData.entityId as number;
        }
        o = o.parent;
      }
      if (skip || foundId === undefined || foundId === this.entId) continue;

      const hitT = this.renderer.tracked.get(foundId);
      if (!hitT) continue;

      const dist = Math.hypot(hitT.last.x - this.predX, hitT.last.y - this.predY);
      const enemy = hitT.last.o >= 0 && hitT.last.o !== mySlot && !this.isAlly(hitT.last.o);
      const targetIsAir = !isBuildingKind(hitT.last.k) && UNITS[hitT.last.k as UnitKind].domain === "air";
      const canEngageDomain = !targetIsAir || Boolean(def.canHitAir);
      const inRange = def.range > 0 && canEngageDomain && dist <= def.range + 0.75;

      return {
        aimX: clamp(hitT.last.x, 0, mapW),
        aimY: clamp(hitT.last.y, 0, mapH),
        aimDist: dist,
        target: {
          id: foundId,
          kind: hitT.last.k,
          hp: hitT.last.hp,
          mhp: hitT.last.mhp,
          dist: Number(dist.toFixed(1)),
          enemy,
          inRange,
        },
      };
    }

    // No entity under reticle — intersect ground plane y = 0
    if (this.raycaster.ray.intersectPlane(GROUND_PLANE, this.groundHit)) {
      const dist = Math.hypot(this.groundHit.x - this.predX, this.groundHit.z - this.predY);
      if (dist <= Math.max(80, mapW, mapH)) {
        return {
          aimX: clamp(this.groundHit.x, 0, mapW),
          aimY: clamp(this.groundHit.z, 0, mapH),
          aimDist: dist,
          target: null,
        };
      }
    }

    // Looking above horizon — project 24 tiles along renderYaw
    const fallbackDist = Math.max(12, def.range > 0 ? def.range : 16);
    return {
      aimX: clamp(this.predX + Math.cos(this.renderYaw) * fallbackDist, 0, mapW),
      aimY: clamp(this.predY + Math.sin(this.renderYaw) * fallbackDist, 0, mapH),
      aimDist: fallbackDist,
      target: null,
    };
  }

  private updateViewmodel(dt: number, moveRatio: number, supplyFrac = 1): void {
    const vm = this.viewmodel;
    if (!vm) return;

    // Smooth exponential sway decay
    const swayDecay = Math.exp(-dt * 10);
    this.swayX *= swayDecay;
    this.swayY *= swayDecay;
    this.swayRoll *= swayDecay;

    // Smooth figure-8 sinusoidal weapon bob + subtle organic idle breathing
    const bobX = Math.sin(this.bobPhase) * this.profile.bobAmp * 0.58 * moveRatio;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * this.profile.bobAmp * 0.68 * moveRatio;
    const idleX = Math.cos(this.elapsed * 1.15) * 0.0016;
    const idleY = Math.sin(this.elapsed * 2.3) * 0.0022;
    const waveRoll = this.domain === "sea" ? Math.sin(this.elapsed * 1.7) * 0.018 : 0;

    vm.swayGroup.position.set(this.swayX + bobX + idleX, this.swayY + bobY + idleY, 0);
    vm.swayGroup.rotation.set(this.swayY * 0.65, this.swayX * 0.85, this.swayRoll + waveRoll);

    // Recoil kick & smooth spring recovery
    this.recoil *= Math.exp(-dt * 11.5);
    if (this.recoil < 0.0015) this.recoil = 0;
    vm.recoilGroup.position.z = this.recoil * this.profile.recoilKickZ;
    vm.recoilGroup.rotation.x = this.recoil * this.profile.recoilPitch * 1.4;

    // Muzzle flash flicker
    if (this.flashTimer > 0) {
      this.flashTimer = Math.max(0, this.flashTimer - dt);
      const show = this.flashTimer > 0;
      const s = 0.75 + (this.flashTimer / 0.085) * 0.55;
      for (const f of vm.muzzleFlashes) {
        f.visible = show;
        if (show) {
          f.scale.set(s, s, s);
          f.rotation.z += dt * 42;
        }
      }
    }

    // Spinners (chopper overhead rotor, harvester ore-scoop drum, sapper scanner ring)
    for (const sp of vm.spinners) {
      if (sp.axis === "x") sp.obj.rotation.x += sp.speed * dt;
      else if (sp.axis === "y") sp.obj.rotation.y += sp.speed * dt;
      else sp.obj.rotation.z += sp.speed * dt;
    }

    // Subtle cockpit / optic LED pulse
    const pulseScale = 0.92 + Math.sin(this.elapsed * 5.2) * 0.08;
    for (const g of vm.glowPulses) {
      g.scale.setScalar(pulseScale);
    }

    // Live dashboard supply-level bar for Supply Convoy cab
    if (vm.supplyBar) {
      const f = clamp(supplyFrac, 0.04, 1);
      vm.supplyBar.mesh.scale.x = f;
      vm.supplyBar.mesh.position.x = vm.supplyBar.baseX - (1 - f) * vm.supplyBar.halfW;
    }
  }

  private disposeViewmodel(): void {
    const vm = this.viewmodel;
    if (!vm) return;
    vm.root.remove(vm.keyLight);
    vm.keyLight.dispose();
    this.gs.camera.remove(vm.root);
    for (const g of vm.geometries) g.dispose();
    for (const m of vm.uniqueMaterials) m.dispose();
    this.viewmodel = null;
  }

  // ---------- event handlers ----------

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.active) return;
    if (isTypingTarget(e.target)) return;

    if (e.code === "KeyE") {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.exit("user");
      return;
    }

    if (e.code === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (document.pointerLockElement === this.gs.canvas) {
        try {
          document.exitPointerLock?.();
        } catch {
          /* ignore */
        }
      } else {
        this.exit("user");
      }
      return;
    }

    if (
      e.code === "KeyW" ||
      e.code === "KeyA" ||
      e.code === "KeyS" ||
      e.code === "KeyD" ||
      e.code === "ArrowUp" ||
      e.code === "ArrowDown" ||
      e.code === "ArrowLeft" ||
      e.code === "ArrowRight" ||
      e.code === "Space"
    ) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.keys.add(e.code);
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (!this.active) return;
    if (this.keys.has(e.code)) {
      this.keys.delete(e.code);
      e.stopImmediatePropagation();
    }
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.active) return;
    e.preventDefault();
    e.stopImmediatePropagation();

    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;

    if (e.button === 0) {
      if (!this.pointerLocked) {
        // First click re-locks pointer cleanly without wasting a shot; hold/drag still aims
        this.dragLooking = true;
        this.requestLock();
      } else {
        this.mouseFire = true;
      }
    } else if (e.button === 2) {
      this.dragLooking = true;
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.active) return;
    if (e.button === 0) {
      this.mouseFire = false;
      if ((e.buttons & 2) === 0) this.dragLooking = false;
    } else if (e.button === 2) {
      if ((e.buttons & 1) === 0) this.dragLooking = false;
    }
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.active) return;
    if (!this.pointerLocked && !this.dragLooking) return;

    const rawDx =
      this.pointerLocked || e.movementX !== 0 || e.movementY !== 0
        ? e.movementX
        : e.clientX - this.lastMouseX;
    const rawDy =
      this.pointerLocked || e.movementX !== 0 || e.movementY !== 0
        ? e.movementY
        : e.clientY - this.lastMouseY;
    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;

    // Guard against browser pointer-lock focus spikes
    const dx = clamp(rawDx, -220, 220);
    const dy = clamp(rawDy, -220, 220);
    if (dx === 0 && dy === 0) return;

    const sens = this.pointerLocked ? MOUSE_SENS : MOUSE_SENS * 1.35;
    const dYaw = dx * sens;
    const dPitch = -dy * sens;

    this.targetYaw = wrapAngle(this.targetYaw + dYaw);
    this.targetPitch = clamp(this.targetPitch + dPitch, this.profile.minPitch, this.profile.maxPitch);

    // Subtle inertial weapon/cockpit lag on mouse movement
    this.swayX = clamp(this.swayX - dYaw * 0.22, -0.045, 0.045);
    this.swayY = clamp(this.swayY - dPitch * 0.18, -0.035, 0.035);
    this.swayRoll = clamp(this.swayRoll - dYaw * 0.45, -0.075, 0.075);
  }
}
