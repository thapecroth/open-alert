import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { MAP_W, MAP_H, TICK_MS, UNITS, EntKind, UnitKind, UnitDomain } from "../shared/gamedefs";
import type { GameEvent } from "../shared/protocol";
import { GameScene } from "./scene";
import { Renderer } from "./render";
import { Net } from "./net";
import { getChassisMat, getAccentMat, getGlassMat, getGlowMat } from "./textures";
import { isBuildingKind } from "./util";

export interface FpvTelemetry {
  id: number;
  kind: EntKind;
  domain: UnitDomain;
  hp: number;
  mhp: number;
  vet: number;
  speed: number;
  altitude: number;
  headingDeg: number;
  submerged: boolean;
  pointerLocked: boolean;
  reloading: number; // 0 = ready, 0..1 = cooldown fraction
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
};

interface ViewmodelRig {
  root: THREE.Group;
  swayGroup: THREE.Group;
  recoilGroup: THREE.Group;
  keyLight: THREE.PointLight;
  muzzleFlashes: THREE.Mesh[];
  spinners: { obj: THREE.Object3D; axis: "x" | "y" | "z"; speed: number }[];
  glowPulses: THREE.Mesh[];
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

function buildViewmodel(kind: UnitKind, factionColor: string): ViewmodelRig {
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

  private gs: GameScene;
  private renderer: Renderer;
  private net: Net;
  private getSlot: () => number;
  private isAlly: (slot: number) => boolean;

  private kind: UnitKind = "tank";
  private domain: UnitDomain = "land";
  private profile: UnitCameraProfile = UNIT_PROFILES.tank;

  // Predicted world position & damped camera orientation
  private predX = MAP_W / 2;
  private predY = MAP_H / 2;
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

    const maxTilesPerSec = def.speed * 1.15 * 10;
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

    const actualDisp = Math.hypot(this.predX - prevX, this.predY - prevY);
    const instantSpeed = actualDisp / clampedDt;
    this.curSpeed += (instantSpeed - this.curSpeed) * (1 - Math.exp(-12 * clampedDt));

    // 4. Compute eye height, bob, sprint FOV easing & subtle recoil pitch kick
    const submerged = this.kind === "sub" && Boolean(t.last.sub);
    const targetEyeY = submerged && prof.subEyeY !== undefined ? prof.subEyeY : prof.eyeY;
    this.curEyeY += (targetEyeY - this.curEyeY) * (1 - Math.exp(-6 * clampedDt));

    const moveRatio = clamp(this.curSpeed / Math.max(0.5, maxTilesPerSec), 0, 1);
    if (moveRatio > 0.05) {
      this.bobPhase += clampedDt * prof.bobFreq * (0.65 + moveRatio * 0.45);
    } else if (this.domain === "sea" || this.domain === "air") {
      this.bobPhase += clampedDt * prof.bobFreq * 0.5;
    }

    const idleHeave =
      this.domain === "sea"
        ? Math.sin(this.elapsed * 2.1) * 0.032
        : this.domain === "air"
          ? Math.sin(this.elapsed * 2.6) * 0.045
          : 0;
    const walkBobY = Math.sin(this.bobPhase * 2) * prof.bobAmp * moveRatio;

    // Smooth sprint / forward-flight FOV boost (baseFov -> baseFov + 4.5, damped at dt * 7)
    const forwardSpeedFrac = fwdIn > 0.1 ? moveRatio : 0;
    const targetFov = prof.fov + forwardSpeedFrac * 4.5;
    this.curFov += (targetFov - this.curFov) * (1 - Math.exp(-7 * clampedDt));

    // Decay pitch kick smoothly
    this.pitchKick *= Math.exp(-clampedDt * 14);
    if (this.pitchKick < 0.0005) this.pitchKick = 0;

    // 5. Update 3D FPV Camera
    const camY = this.curEyeY + idleHeave + walkBobY;
    this.camPos.set(this.predX, camY, this.predY);
    const effPitch = clamp(this.renderPitch + this.pitchKick, prof.minPitch, prof.maxPitch + 0.08);
    this.gs.setFpvCamera(this.camPos, this.renderYaw, effPitch, this.curFov);
    this.gs.camera.updateMatrixWorld();

    // 6. Animate camera-attached 3D weapon / cockpit viewmodel
    this.updateViewmodel(clampedDt, moveRatio);

    // 7. Center-Screen 3D Crosshair Raycast for aiming & telemetry
    const aim = this.computeCrosshairAim(def);

    // 8. Send drive packet at ~18 Hz (every 55ms) or immediately on fire state edge
    const firing = (this.mouseFire || this.keys.has("Space")) && def.range > 0;
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
      speed: Number(this.curSpeed.toFixed(2)),
      altitude: this.domain === "air" ? Number((camY * 10).toFixed(0)) : 0,
      headingDeg,
      submerged,
      pointerLocked: this.pointerLocked,
      reloading,
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

  private canOccupy(x: number, y: number, domain: UnitDomain): boolean {
    if (x < 0.6 || x > MAP_W - 0.6 || y < 0.6 || y > MAP_H - 0.6) return false;
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
        aimX: clamp(hitT.last.x, 0, MAP_W),
        aimY: clamp(hitT.last.y, 0, MAP_H),
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
      if (dist <= 80) {
        return {
          aimX: clamp(this.groundHit.x, 0, MAP_W),
          aimY: clamp(this.groundHit.z, 0, MAP_H),
          aimDist: dist,
          target: null,
        };
      }
    }

    // Looking above horizon — project 24 tiles along renderYaw
    const fallbackDist = Math.max(12, def.range > 0 ? def.range : 16);
    return {
      aimX: clamp(this.predX + Math.cos(this.renderYaw) * fallbackDist, 0, MAP_W),
      aimY: clamp(this.predY + Math.sin(this.renderYaw) * fallbackDist, 0, MAP_H),
      aimDist: fallbackDist,
      target: null,
    };
  }

  private updateViewmodel(dt: number, moveRatio: number): void {
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
