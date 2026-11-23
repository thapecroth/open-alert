// Shared 1P viewmodel construction kit.
//
// Domain viewmodel modules (vm-land.ts, vm-air.ts, vm-sea.ts) receive a VmKit
// and sculpt camera-attached weapon/cockpit geometry with it. Everything is
// tracked so FirstPersonController can animate (sway/recoil/flashes/spinners/
// glow pulses/supply bar) and fully dispose the rig on exit.
//
// Do NOT dispose materials from kit.mats — they are shared cached PBR
// materials from textures.ts. Only materials you create yourself via
// trackMat() are yours (they auto-register for disposal).

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { getChassisMat, getAccentMat, getGlassMat, getGlowMat } from "../textures";

export interface ViewmodelRig {
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

export interface VmMats {
  darkMetal: THREE.Material;
  gunMetal: THREE.Material;
  lightAlloy: THREE.Material;
  cockpitTrim: THREE.Material;
  factionMat: THREE.Material;
  glassCyan: THREE.Material;
  glassTint: THREE.Material;
  cyanGlow: THREE.Material;
  amberGlow: THREE.Material;
  redGlow: THREE.Material;
  greenGlow: THREE.Material;
  brassMat: THREE.Material;
}

export interface VmKit extends ViewmodelRig {
  mats: VmMats;
  rig: ViewmodelRig;
  trackGeo<T extends THREE.BufferGeometry>(g: T): T;
  trackMat<T extends THREE.Material>(m: T): T;
  /** Add a mesh: tracked geometry, no shadow, frustumCulled=false. */
  addPart(
    parent: THREE.Object3D,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    rx?: number,
    ry?: number,
    rz?: number,
  ): THREE.Mesh;
  /** Flickering muzzle flash; controller shows it ~85ms on each shot. */
  addMuzzleFlash(parent: THREE.Object3D, x: number, y: number, z: number, scale?: number, colorHex?: number): THREE.Mesh;
  /** Peripheral armored gunner viewport bezel (keeps center clear). */
  addGunnerCowl(topY?: number, botY?: number, accentHex?: string, withRangefinder?: boolean): void;
  /** Angled canopy struts + avionics dashboard + holographic HUD combiner. */
  addAircraftCanopy(wide: boolean, heavy?: boolean): void;
  /** Live dashboard bar (e.g. supply/ammo gauge) driven 0..1 by the controller. */
  addSupplyBar(parent: THREE.Object3D, x: number, y: number, z: number, w: number, h: number, colorHex?: string): void;
}

export function makeVmKit(factionColor: string): VmKit {
  const root = new THREE.Group();
  const swayGroup = new THREE.Group();
  const recoilGroup = new THREE.Group();
  root.add(swayGroup);
  swayGroup.add(recoilGroup);

  // Dedicated 1P weapon & cockpit key fill light so PBR metals & rims gleam
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

  const mats: VmMats = {
    darkMetal: getChassisMat("#262d36", 0.36, 0.78),
    gunMetal: getChassisMat("#38424e", 0.34, 0.72),
    lightAlloy: getChassisMat("#647282", 0.32, 0.68),
    cockpitTrim: getChassisMat("#1b2128", 0.48, 0.6),
    factionMat: getAccentMat(factionColor),
    glassCyan: getGlassMat("#64e4ff"),
    glassTint: getGlassMat("#2b6a7a"),
    cyanGlow: getGlowMat("#38f2ff", 1.6),
    amberGlow: getGlowMat("#ffae2b", 1.55),
    redGlow: getGlowMat("#ff3d2e", 1.6),
    greenGlow: getGlowMat("#3cf084", 1.45),
    brassMat: getChassisMat("#9f8048", 0.34, 0.8),
  };
  const { darkMetal, gunMetal, lightAlloy, cockpitTrim, factionMat, glassCyan, glassTint, cyanGlow, amberGlow, redGlow, greenGlow, brassMat } = mats;
  void glassCyan;
  void amberGlow;
  void redGlow;
  void greenGlow;
  void brassMat;

  const addPart: VmKit["addPart"] = (parent, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
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

  const addMuzzleFlash: VmKit["addMuzzleFlash"] = (parent, x, y, z, scale = 1, colorHex = 0xffc64a) => {
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

  const addGunnerCowl: VmKit["addGunnerCowl"] = (topY = 0.34, botY = -0.33, accentHex = "#38f2ff", withRangefinder = false) => {
    const ledMat = getGlowMat(accentHex, 1.5);
    addPart(swayGroup, new RoundedBoxGeometry(1.06, 0.07, 0.14, 2, 0.012), cockpitTrim, 0, topY, -0.44, 0.18, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.08, 0.36, 0.14, 2, 0.012), cockpitTrim, -0.52, 0.04, -0.44, 0, 0.24, -0.14);
    addPart(swayGroup, new RoundedBoxGeometry(0.08, 0.36, 0.14, 2, 0.012), cockpitTrim, 0.52, 0.04, -0.44, 0, -0.24, 0.14);
    addPart(swayGroup, new RoundedBoxGeometry(1.08, 0.085, 0.16, 2, 0.014), cockpitTrim, 0, botY, -0.44, -0.22, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.18, 0.022, 0.03, 1, 0.004), factionMat, -0.34, botY + 0.04, -0.41, -0.22, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.18, 0.022, 0.03, 1, 0.004), factionMat, 0.34, botY + 0.04, -0.41, -0.22, 0, 0);
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.032, 0.01, 0.01), ledMat, -0.42, topY - 0.025, -0.38),
      addPart(swayGroup, new THREE.BoxGeometry(0.032, 0.01, 0.01), ledMat, 0.42, topY - 0.025, -0.38),
    );

    if (withRangefinder) {
      const rfY = botY + 0.052;
      const rfZ = -0.415;
      addPart(swayGroup, new RoundedBoxGeometry(0.25, 0.044, 0.03, 2, 0.006), darkMetal, 0, rfY, rfZ, -0.34, 0, 0);
      addPart(swayGroup, new THREE.BoxGeometry(0.215, 0.028, 0.006), glassTint, 0, rfY + 0.002, rfZ + 0.014, -0.34, 0, 0);
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

  const addAircraftCanopy: VmKit["addAircraftCanopy"] = (wide, heavy = false) => {
    const xSpan = wide ? 0.52 : 0.46;
    const strutW = heavy ? 0.048 : 0.034;
    addPart(swayGroup, new RoundedBoxGeometry(strutW, 0.56, 0.06, 2, 0.008), cockpitTrim, -xSpan, 0.06, -0.45, -0.24, 0.25, -0.28);
    addPart(swayGroup, new RoundedBoxGeometry(strutW, 0.56, 0.06, 2, 0.008), cockpitTrim, xSpan, 0.06, -0.45, -0.24, -0.25, 0.28);
    addPart(swayGroup, new RoundedBoxGeometry(xSpan * 1.78, strutW * 1.15, 0.06, 2, 0.008), cockpitTrim, 0, 0.34, -0.46, 0.16, 0, 0);
    addPart(swayGroup, new THREE.BoxGeometry(0.012, 0.22, 0.02), factionMat, -xSpan + 0.022, 0.02, -0.43, -0.24, 0.25, -0.28);
    addPart(swayGroup, new THREE.BoxGeometry(0.012, 0.22, 0.02), factionMat, xSpan - 0.022, 0.02, -0.43, -0.24, -0.25, 0.28);
    addPart(swayGroup, new RoundedBoxGeometry(0.86, 0.115, 0.22, 2, 0.016), cockpitTrim, 0, -0.32, -0.48, -0.3, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.28, 0.048, 0.022, 1, 0.004), gunMetal, 0, -0.265, -0.42, -0.42, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.15, 0.044, 0.02, 1, 0.004), darkMetal, -0.22, -0.278, -0.422, -0.32, 0.14, 0);
    addPart(swayGroup, new THREE.BoxGeometry(0.15, 0.044, 0.02, 1, 0.004), darkMetal, 0.22, -0.278, -0.422, -0.32, -0.14, 0);
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.125, 0.012, 0.008), cyanGlow, 0, -0.258, -0.408, -0.42, 0, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.09, 0.007, 0.008), greenGlow, 0, -0.274, -0.406, -0.42, 0, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.098, 0.012, 0.008), greenGlow, -0.22, -0.271, -0.41, -0.32, 0.14, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.072, 0.007, 0.008), cyanGlow, -0.22, -0.286, -0.408, -0.32, 0.14, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.098, 0.012, 0.008), amberGlow, 0.22, -0.271, -0.41, -0.32, -0.14, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.072, 0.007, 0.008), cyanGlow, 0.22, -0.286, -0.408, -0.32, -0.14, 0),
    );
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
    const hudBarMat = trackMat(
      new THREE.MeshBasicMaterial({
        color: 0x5af8ff,
        transparent: true,
        opacity: 0.78,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    addPart(swayGroup, new THREE.BoxGeometry(0.052, 0.0032, 0.002), hudBarMat, -0.048, -0.202, -0.425, 0.18, 0, 0);
    addPart(swayGroup, new THREE.BoxGeometry(0.052, 0.0032, 0.002), hudBarMat, 0.048, -0.202, -0.425, 0.18, 0, 0);
    addPart(swayGroup, new THREE.BoxGeometry(0.016, 0.0032, 0.002), cyanGlow, 0, -0.202, -0.424, 0.18, 0, 0);
    addPart(swayGroup, new THREE.BoxGeometry(0.032, 0.0024, 0.002), hudBarMat, -0.04, -0.182, -0.422, 0.18, 0, 0);
    addPart(swayGroup, new THREE.BoxGeometry(0.032, 0.0024, 0.002), hudBarMat, 0.04, -0.182, -0.422, 0.18, 0, 0);
    addPart(swayGroup, new THREE.BoxGeometry(0.032, 0.0024, 0.002), hudBarMat, -0.04, -0.222, -0.428, 0.18, 0, 0);
    addPart(swayGroup, new THREE.BoxGeometry(0.032, 0.0024, 0.002), hudBarMat, 0.04, -0.222, -0.428, 0.18, 0, 0);
  };

  const addSupplyBar: VmKit["addSupplyBar"] = (parent, x, y, z, w, h, colorHex = "#3cf084") => {
    const frame = addPart(parent, new RoundedBoxGeometry(w + 0.016, h + 0.016, 0.014, 1, 0.003), cockpitTrim, x, y, z);
    const fillMat = getGlowMat(colorHex, 1.5);
    const fill = addPart(parent, new THREE.BoxGeometry(w, h, 0.008), fillMat, x, y, z + 0.008);
    supplyBar = { mesh: fill, baseX: x, halfW: w / 2 };
    return frame;
  };

  const rig: ViewmodelRig = {
    root,
    swayGroup,
    recoilGroup,
    keyLight,
    muzzleFlashes,
    spinners,
    glowPulses,
    get supplyBar() {
      return supplyBar;
    },
    geometries,
    uniqueMaterials,
  };

  return {
    ...rig,
    get supplyBar() {
      return supplyBar;
    },
    mats,
    rig,
    trackGeo,
    trackMat,
    addPart,
    addMuzzleFlash,
    addGunnerCowl,
    addAircraftCanopy,
    addSupplyBar,
  };
}
