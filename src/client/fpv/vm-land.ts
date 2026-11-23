// Land-domain 1P viewmodels (infantry, engineer, rocket + all ground vehicles).
// Each entry fully replaces the legacy fpv.ts cockpit branch for that kind.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { UnitKind } from "../../shared/gamedefs";
import type { VmKit } from "./vmkit";

// ---------- shared helpers ----------

// Custom cloth/polymer PBR material — auto-disposed via trackMat (kit.mats are shared!).
const armor = (kit: VmKit, hex: string, rough = 0.55, metal = 0.4): THREE.MeshStandardMaterial =>
  kit.trackMat(new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: rough, metalness: metal }));

// Emissive MFD / tablet screen face.
const screen = (kit: VmKit, hex = "#0c2b38"): THREE.MeshStandardMaterial =>
  kit.trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color("#050a0f"),
      emissive: new THREE.Color(hex),
      emissiveIntensity: 0.9,
      roughness: 0.35,
      metalness: 0.3,
    }),
  );

// Translucent additive holo/optic pane.
const holo = (kit: VmKit, hex: number, opacity = 0.16): THREE.MeshBasicMaterial =>
  kit.trackMat(
    new THREE.MeshBasicMaterial({
      color: hex,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );

// Rifled tank cannon: mantlet, recuperators, jacket, barrel, brake + flash.
function addTankCannon(
  kit: VmKit,
  ox: number,
  oy: number,
  rad: number,
  len: number,
  heavyBore: boolean,
  flashScale: number,
): void {
  const m = kit.mats;
  const R = kit.recoilGroup;
  kit.addPart(R, new RoundedBoxGeometry(rad * 3.15, rad * 2.55, 0.24, 2, 0.014), m.darkMetal, ox, oy, -0.46);
  kit.addPart(R, new THREE.CylinderGeometry(rad * 1.48, rad * 1.56, 0.055, 16), m.lightAlloy, ox, oy, -0.57, Math.PI / 2, 0, 0);
  for (const s of [-1, 1]) {
    kit.addPart(R, new THREE.CylinderGeometry(rad * 0.34, rad * 0.36, 0.28, 10), m.lightAlloy, ox + s * rad * 1.42, oy + rad * 0.56, -0.56, Math.PI / 2, 0, 0);
    kit.addPart(R, new THREE.CylinderGeometry(rad * 0.17, rad * 0.17, 0.16, 8), m.brassMat, ox + s * rad * 1.42, oy + rad * 0.56, -0.72, Math.PI / 2, 0, 0);
  }
  kit.glowPulses.push(kit.addPart(R, new THREE.BoxGeometry(rad * 0.65, 0.008, 0.022), m.greenGlow, ox, oy + rad * 1.28, -0.46));
  kit.addPart(R, new RoundedBoxGeometry(rad * 2.35, rad * 1.9, 0.3, 2, 0.012), m.factionMat, ox, oy + 0.006, -0.6);
  kit.addPart(R, new THREE.CylinderGeometry(rad * 0.88, rad, len, 16), m.gunMetal, ox, oy, -0.58 - len * 0.5, Math.PI / 2, 0, 0);
  if (heavyBore) {
    kit.addPart(R, new THREE.CylinderGeometry(rad * 1.32, rad * 1.28, 0.17, 14), m.lightAlloy, ox, oy, -0.58 - len * 0.45, Math.PI / 2, 0, 0);
  }
  kit.addPart(R, new RoundedBoxGeometry(rad * 2.5, rad * 2.1, 0.09, 2, 0.01), m.darkMetal, ox, oy, -0.58 - len);
  kit.addPart(R, new THREE.CylinderGeometry(rad * 1.15, rad * 1.15, 0.026, 12), m.lightAlloy, ox, oy, -0.53 - len, Math.PI / 2, 0, 0);
  kit.addMuzzleFlash(R, ox, oy, -0.66 - len, flashScale, 0xffb33a);
}

// ---------- infantry: bullpup pulse rifle + arms + holstered sidearm ----------
function buildInfantry(kit: VmKit): void {
  const m = kit.mats;
  const gun = new THREE.Group();
  gun.position.set(0.25, -0.23, -0.46);
  gun.rotation.set(0.02, 0.08, -0.03);
  kit.recoilGroup.add(gun);

  const sleeveMat = armor(kit, "#1f2630", 0.58, 0.32);
  const gloveMat = armor(kit, "#151920", 0.44, 0.44);

  // Sculpted receiver, faction panels, ventilated shroud
  kit.addPart(gun, new RoundedBoxGeometry(0.072, 0.105, 0.44, 3, 0.012), m.darkMetal, 0, 0, 0.04);
  kit.addPart(gun, new RoundedBoxGeometry(0.078, 0.042, 0.24, 2, 0.008), m.factionMat, 0, 0.012, 0.08);
  kit.addPart(gun, new RoundedBoxGeometry(0.056, 0.072, 0.26, 2, 0.01), m.gunMetal, 0, 0.012, -0.26);
  for (let i = 0; i < 4; i++) {
    kit.addPart(gun, new THREE.BoxGeometry(0.06, 0.006, 0.012), m.cockpitTrim, 0, 0.05, -0.36 + i * 0.045);
  }
  // Rifled barrel + compensator + glowing pulse-accelerator collars
  kit.addPart(gun, new THREE.CylinderGeometry(0.014, 0.016, 0.22, 12), m.lightAlloy, 0, 0.016, -0.44, Math.PI / 2, 0, 0);
  kit.addPart(gun, new THREE.CylinderGeometry(0.02, 0.018, 0.048, 8), m.darkMetal, 0, 0.016, -0.54, Math.PI / 2, 0, 0);
  for (const z of [-0.33, -0.395, -0.46]) {
    kit.glowPulses.push(kit.addPart(gun, new THREE.TorusGeometry(0.024, 0.0026, 6, 18), m.cyanGlow, 0, 0.016, z));
  }
  // Foregrip, pistol grip, mag well + glowing energy-cell window
  kit.addPart(gun, new RoundedBoxGeometry(0.042, 0.095, 0.05, 2, 0.008), m.cockpitTrim, 0, -0.065, -0.18, 0.25, 0, 0);
  kit.addPart(gun, new RoundedBoxGeometry(0.044, 0.095, 0.052, 2, 0.008), m.cockpitTrim, 0, -0.075, 0.035, -0.24, 0, 0);
  kit.addPart(gun, new RoundedBoxGeometry(0.048, 0.11, 0.075, 2, 0.008), m.cockpitTrim, 0, -0.07, 0.16, -0.16, 0, 0);
  kit.addPart(gun, new THREE.BoxGeometry(0.008, 0.052, 0.034), m.glassTint, -0.025, -0.075, 0.145, -0.16, 0, 0);
  kit.glowPulses.push(kit.addPart(gun, new THREE.BoxGeometry(0.006, 0.014, 0.026), m.cyanGlow, -0.029, -0.075, 0.145, -0.16, 0, 0));
  // Top rail + risers
  kit.addPart(gun, new RoundedBoxGeometry(0.032, 0.014, 0.34, 1, 0.003), m.lightAlloy, 0, 0.058, -0.06);
  for (let i = 0; i < 5; i++) {
    kit.addPart(gun, new THREE.BoxGeometry(0.036, 0.006, 0.012), m.darkMetal, 0, 0.067, -0.2 + i * 0.07);
  }
  // Live segmented ammo counter (cyan full -> amber low) + red reserve pip
  kit.addPart(gun, new RoundedBoxGeometry(0.014, 0.03, 0.13, 1, 0.003), m.cockpitTrim, -0.04, 0.024, -0.03);
  const segs: [THREE.Material, number][] = [
    [m.cyanGlow, -0.078],
    [m.cyanGlow, -0.062],
    [m.cyanGlow, -0.046],
    [m.greenGlow, -0.03],
    [m.greenGlow, -0.014],
    [m.amberGlow, 0.002],
  ];
  for (const [mat, z] of segs) {
    kit.glowPulses.push(kit.addPart(gun, new THREE.BoxGeometry(0.006, 0.013, 0.011), mat, -0.047, 0.024, z));
  }
  kit.addPart(gun, new THREE.BoxGeometry(0.006, 0.008, 0.01), m.redGlow, -0.047, 0.024, 0.018);

  // Holo reflex sight: frame, combiner glass, cross-dot reticle
  kit.addPart(gun, new RoundedBoxGeometry(0.052, 0.012, 0.078, 1, 0.003), m.darkMetal, 0, 0.068, -0.02);
  kit.addPart(gun, new RoundedBoxGeometry(0.008, 0.042, 0.062, 1, 0.002), m.darkMetal, -0.022, 0.09, -0.02);
  kit.addPart(gun, new RoundedBoxGeometry(0.008, 0.042, 0.062, 1, 0.002), m.darkMetal, 0.022, 0.09, -0.02);
  kit.addPart(gun, new RoundedBoxGeometry(0.052, 0.008, 0.062, 1, 0.002), m.darkMetal, 0, 0.112, -0.02);
  kit.addPart(gun, new THREE.PlaneGeometry(0.036, 0.034), holo(kit, 0x3ce8ff, 0.18), 0, 0.09, -0.02);
  kit.addPart(gun, new THREE.SphereGeometry(0.0026, 8, 8), m.cyanGlow, 0, 0.09, -0.017);
  kit.addPart(gun, new THREE.BoxGeometry(0.009, 0.0014, 0.0014), m.cyanGlow, -0.009, 0.09, -0.017);
  kit.addPart(gun, new THREE.BoxGeometry(0.009, 0.0014, 0.0014), m.cyanGlow, 0.009, 0.09, -0.017);
  kit.addPart(gun, new THREE.BoxGeometry(0.0014, 0.008, 0.0014), m.cyanGlow, 0, 0.098, -0.017);
  kit.addPart(gun, new THREE.BoxGeometry(0.0014, 0.008, 0.0014), m.cyanGlow, 0, 0.082, -0.017);
  kit.addPart(gun, new THREE.TorusGeometry(0.0115, 0.001, 6, 20), m.cyanGlow, 0, 0.09, -0.017);

  // Left forearm gripping the forend
  const leftArm = new THREE.Group();
  leftArm.position.set(-0.028, -0.062, -0.18);
  gun.add(leftArm);
  kit.addPart(leftArm, new RoundedBoxGeometry(0.058, 0.052, 0.072, 2, 0.014), gloveMat, 0.012, -0.002, 0.004, 0.14, 0.16, 0.25);
  kit.addPart(leftArm, new RoundedBoxGeometry(0.038, 0.022, 0.058, 2, 0.008), m.darkMetal, 0.044, -0.012, -0.014, 0.08, 0.12, -0.2);
  kit.addPart(leftArm, new RoundedBoxGeometry(0.022, 0.022, 0.054, 2, 0.007), gloveMat, -0.016, 0.036, -0.018, 0.28, 0.15, -0.1);
  kit.addPart(leftArm, new RoundedBoxGeometry(0.064, 0.06, 0.24, 2, 0.018), sleeveMat, -0.092, -0.052, 0.115, -0.34, -0.58, 0.18);
  kit.addPart(leftArm, new RoundedBoxGeometry(0.068, 0.032, 0.14, 2, 0.01), m.darkMetal, -0.078, -0.025, 0.095, -0.34, -0.58, 0.18);
  kit.addPart(leftArm, new RoundedBoxGeometry(0.069, 0.018, 0.028, 1, 0.005), m.factionMat, -0.046, -0.016, 0.054, -0.34, -0.58, 0.18);

  // Right forearm gripping the pistol grip
  const rightArm = new THREE.Group();
  rightArm.position.set(0.018, -0.078, 0.048);
  gun.add(rightArm);
  kit.addPart(rightArm, new RoundedBoxGeometry(0.056, 0.062, 0.068, 2, 0.014), gloveMat, 0.002, 0.002, 0.006, -0.22, -0.1, -0.12);
  kit.addPart(rightArm, new RoundedBoxGeometry(0.024, 0.046, 0.048, 2, 0.008), m.darkMetal, 0.026, 0.008, -0.006, -0.22, -0.1, -0.12);
  kit.addPart(rightArm, new RoundedBoxGeometry(0.016, 0.018, 0.052, 2, 0.006), gloveMat, 0.018, 0.028, -0.042, 0.08, -0.18, 0);
  kit.addPart(rightArm, new RoundedBoxGeometry(0.066, 0.062, 0.24, 2, 0.018), sleeveMat, 0.052, -0.058, 0.135, -0.38, 0.3, -0.15);
  kit.addPart(rightArm, new RoundedBoxGeometry(0.07, 0.032, 0.13, 2, 0.01), m.darkMetal, 0.046, -0.032, 0.115, -0.38, 0.3, -0.15);
  kit.addPart(rightArm, new RoundedBoxGeometry(0.071, 0.018, 0.028, 1, 0.005), m.factionMat, 0.028, -0.018, 0.062, -0.38, 0.3, -0.15);

  // Holstered sidearm hint on the belt line, lower-left edge
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.075, 0.13, 0.055, 2, 0.012), m.cockpitTrim, -0.47, -0.33, -0.5, -0.15, 0.3, -0.08);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.05, 0.06, 0.03, 1, 0.008), m.gunMetal, -0.455, -0.25, -0.485, -0.15, 0.3, -0.08);
  kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.078, 0.018, 0.058), m.factionMat, -0.462, -0.295, -0.49, -0.15, 0.3, -0.08);

  kit.addMuzzleFlash(gun, 0, 0.016, -0.61, 1.0, 0xffd15c);
}

// ---------- engineer: hacking tablet + multi-tool arm + capture dish ----------
function buildEngineer(kit: VmKit): void {
  const m = kit.mats;
  const sleeveMat = armor(kit, "#232a30", 0.6, 0.3);
  const gloveMat = armor(kit, "#171c22", 0.5, 0.4);

  // Diagnostic tablet tilted toward the operator
  const pad = new THREE.Group();
  pad.position.set(-0.3, -0.21, -0.4);
  pad.rotation.set(0.14, 0.3, 0.08);
  kit.swayGroup.add(pad);
  kit.addPart(pad, new RoundedBoxGeometry(0.21, 0.15, 0.024, 2, 0.008), m.cockpitTrim, 0, 0, 0);
  kit.addPart(pad, new THREE.BoxGeometry(0.186, 0.126, 0.008), screen(kit, "#0d3040"), 0, 0.004, 0.012);
  // "Scrolling" diagnostic bar rows of varied width
  const rows: [number, number, THREE.Material][] = [
    [0.05, 0.135, m.cyanGlow],
    [0.028, 0.1, m.greenGlow],
    [0.006, 0.15, m.cyanGlow],
    [-0.016, 0.08, m.amberGlow],
    [-0.038, 0.125, m.greenGlow],
    [-0.058, 0.06, m.cyanGlow],
  ];
  for (const [ry, w, mat] of rows) {
    kit.glowPulses.push(kit.addPart(pad, new THREE.BoxGeometry(w, 0.008, 0.004), mat, -0.088 + w / 2, ry, 0.017));
  }
  // Hex-dump tick pips + bright scanning sweep line
  for (let i = 0; i < 6; i++) {
    kit.addPart(pad, new THREE.BoxGeometry(0.012, 0.005, 0.004), i % 2 ? m.cyanGlow : m.greenGlow, 0.045 + (i % 3) * 0.016, 0.032 - Math.floor(i / 3) * 0.02, 0.017);
  }
  kit.glowPulses.push(kit.addPart(pad, new THREE.BoxGeometry(0.17, 0.003, 0.004), m.cyanGlow, 0, -0.02, 0.018));
  kit.addPart(pad, new THREE.BoxGeometry(0.03, 0.012, 0.006), m.factionMat, -0.075, 0.085, 0.006);
  // Rotating capture-scanner dish on a corner mast
  const mast = new THREE.Group();
  mast.position.set(0.11, 0.1, 0);
  pad.add(mast);
  kit.addPart(mast, new THREE.CylinderGeometry(0.006, 0.008, 0.07, 8), m.lightAlloy, 0, 0.02, 0);
  const dish = new THREE.Group();
  dish.position.set(0, 0.062, 0);
  mast.add(dish);
  kit.addPart(dish, new THREE.SphereGeometry(0.032, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.45), m.lightAlloy, 0, 0, 0, Math.PI / 2 - 0.35, 0, 0);
  kit.glowPulses.push(kit.addPart(dish, new THREE.SphereGeometry(0.008, 8, 8), m.amberGlow, 0, 0.014, 0));
  kit.spinners.push({ obj: dish, axis: "y", speed: 1.6 });

  // Rugged multi-tool arm with plasma prongs + capture ring
  const tool = new THREE.Group();
  tool.position.set(0.25, -0.24, -0.44);
  tool.rotation.set(0.05, 0.12, -0.04);
  kit.recoilGroup.add(tool);
  kit.addPart(tool, new RoundedBoxGeometry(0.082, 0.092, 0.28, 3, 0.014), m.gunMetal, 0, 0, 0);
  kit.addPart(tool, new RoundedBoxGeometry(0.088, 0.038, 0.18, 2, 0.008), m.factionMat, 0, 0.014, 0.01);
  kit.addPart(tool, new RoundedBoxGeometry(0.045, 0.09, 0.052, 2, 0.008), m.cockpitTrim, 0, -0.07, 0.07, -0.22, 0, 0);
  kit.addPart(tool, new RoundedBoxGeometry(0.016, 0.02, 0.16, 1, 0.004), m.brassMat, -0.03, 0.008, -0.2);
  kit.addPart(tool, new RoundedBoxGeometry(0.016, 0.02, 0.16, 1, 0.004), m.brassMat, 0.03, 0.008, -0.2);
  kit.glowPulses.push(kit.addPart(tool, new THREE.OctahedronGeometry(0.022, 1), m.cyanGlow, 0, 0.008, -0.25));
  const ring = kit.addPart(tool, new THREE.TorusGeometry(0.044, 0.005, 8, 24), m.cyanGlow, 0, 0.008, -0.23);
  kit.spinners.push({ obj: ring, axis: "z", speed: 3.4 });
  // Telemetry glass, cable loop, antenna stub with tip light
  kit.addPart(tool, new THREE.BoxGeometry(0.056, 0.016, 0.08), m.glassCyan, 0, 0.052, 0.02, 0.18, 0, 0);
  kit.addPart(tool, new THREE.TorusGeometry(0.028, 0.005, 6, 14, Math.PI), m.cockpitTrim, 0.048, -0.008, 0.1, 0, Math.PI / 2, 0);
  kit.addPart(tool, new THREE.CylinderGeometry(0.003, 0.004, 0.06, 6), m.lightAlloy, 0.03, 0.08, 0.06, -0.3, 0, 0);
  kit.glowPulses.push(kit.addPart(tool, new THREE.SphereGeometry(0.005, 8, 6), m.redGlow, 0.04, 0.108, 0.052));
  // Bulky engineer vambrace + glove
  kit.addPart(tool, new RoundedBoxGeometry(0.07, 0.066, 0.22, 2, 0.018), sleeveMat, 0.055, -0.06, 0.14, -0.38, 0.3, -0.15);
  kit.addPart(tool, new RoundedBoxGeometry(0.074, 0.03, 0.05, 1, 0.006), m.factionMat, 0.035, -0.02, 0.06, -0.38, 0.3, -0.15);
  kit.addPart(tool, new RoundedBoxGeometry(0.058, 0.056, 0.066, 2, 0.012), gloveMat, 0.012, -0.055, 0.05, -0.2, -0.05, -0.1);
}

// ---------- rocket: shoulder quad-tube AT launcher ----------
function buildRocket(kit: VmKit): void {
  const m = kit.mats;
  const pod = new THREE.Group();
  pod.position.set(0.34, -0.14, -0.44);
  pod.rotation.set(0.02, 0.07, -0.02);
  kit.recoilGroup.add(pod);

  // Armored housing, faction plates, front collar, rear backblast bell
  kit.addPart(pod, new RoundedBoxGeometry(0.185, 0.185, 0.56, 3, 0.018), m.gunMetal, 0, 0, -0.04);
  kit.addPart(pod, new RoundedBoxGeometry(0.195, 0.065, 0.34, 2, 0.01), m.factionMat, 0, 0, -0.02);
  kit.addPart(pod, new RoundedBoxGeometry(0.205, 0.205, 0.055, 2, 0.012), m.darkMetal, 0, 0, -0.31);
  kit.addPart(pod, new THREE.CylinderGeometry(0.06, 0.11, 0.1, 14), m.darkMetal, 0, 0, 0.27, -Math.PI / 2, 0, 0);
  // 4 tubes: alloy mouth rim + dark bore + visible warhead tip
  const offs: [number, number][] = [
    [-0.046, 0.046],
    [0.046, 0.046],
    [-0.046, -0.046],
    [0.046, -0.046],
  ];
  offs.forEach(([ox, oy], i) => {
    kit.addPart(pod, new THREE.CylinderGeometry(0.04, 0.042, 0.05, 12), m.darkMetal, ox, oy, -0.315, Math.PI / 2, 0, 0);
    kit.addPart(pod, new THREE.CylinderGeometry(0.034, 0.034, 0.08, 12), m.cockpitTrim, ox, oy, -0.33, Math.PI / 2, 0, 0);
    kit.addPart(pod, new THREE.ConeGeometry(0.022, 0.055, 10), i % 2 ? m.redGlow : m.amberGlow, ox, oy, -0.345, -Math.PI / 2, 0, 0);
    kit.addPart(pod, new THREE.TorusGeometry(0.037, 0.0035, 6, 16), m.lightAlloy, ox, oy, -0.325);
  });
  // Flip-up graduated leaf sight at the rear
  const leaf = new THREE.Group();
  leaf.position.set(0, 0.105, 0.16);
  leaf.rotation.x = -0.5;
  pod.add(leaf);
  kit.addPart(leaf, new RoundedBoxGeometry(0.05, 0.03, 0.03, 1, 0.004), m.darkMetal, 0, 0, 0);
  kit.addPart(leaf, new RoundedBoxGeometry(0.034, 0.09, 0.008, 1, 0.003), m.lightAlloy, 0, 0.055, -0.012);
  for (let i = 0; i < 4; i++) {
    kit.addPart(leaf, new THREE.BoxGeometry(i === 0 ? 0.03 : 0.018, 0.0035, 0.003), m.cockpitTrim, 0, 0.025 + i * 0.019, -0.0175);
  }
  kit.addPart(leaf, new THREE.TorusGeometry(0.011, 0.0022, 6, 14), m.lightAlloy, 0, 0.105, -0.012);
  // Shoulder rest + firing grip with armed pip
  kit.addPart(pod, new RoundedBoxGeometry(0.11, 0.05, 0.16, 2, 0.014), m.cockpitTrim, 0, -0.115, 0.1, -0.1, 0, 0);
  kit.addPart(pod, new RoundedBoxGeometry(0.04, 0.07, 0.045, 2, 0.008), m.darkMetal, -0.02, -0.1, 0.18, -0.25, 0, 0);
  kit.addPart(pod, new THREE.BoxGeometry(0.012, 0.008, 0.008), m.redGlow, -0.02, -0.062, 0.175);
  // Side lock-on optic pod + glow strip
  kit.addPart(pod, new RoundedBoxGeometry(0.068, 0.072, 0.17, 2, 0.01), m.darkMetal, -0.125, 0.035, -0.11);
  kit.addPart(pod, new THREE.CylinderGeometry(0.024, 0.024, 0.02, 14), m.glassCyan, -0.125, 0.035, -0.195, Math.PI / 2, 0, 0);
  kit.glowPulses.push(kit.addPart(pod, new THREE.BoxGeometry(0.012, 0.022, 0.08), m.cyanGlow, -0.16, 0.04, -0.08));
  // Hazard placard + carry handle + sling loop
  kit.addPart(pod, new THREE.BoxGeometry(0.006, 0.05, 0.1), m.amberGlow, -0.098, -0.05, -0.05, 0, 0, 0.35);
  kit.addPart(pod, new THREE.BoxGeometry(0.007, 0.05, 0.016), m.cockpitTrim, -0.099, -0.05, -0.08, 0, 0, 0.35);
  kit.addPart(pod, new THREE.BoxGeometry(0.007, 0.05, 0.016), m.cockpitTrim, -0.099, -0.05, -0.02, 0, 0, 0.35);
  kit.addPart(pod, new RoundedBoxGeometry(0.032, 0.018, 0.22, 1, 0.005), m.lightAlloy, 0, 0.12, -0.06);
  kit.addPart(pod, new THREE.BoxGeometry(0.01, 0.028, 0.2), m.cockpitTrim, 0.1, -0.02, 0.05);
  // Shoulder-pad silhouette at lower-left edge for balance
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.15, 0.07, 0.2, 2, 0.018), armor(kit, "#232a31", 0.62, 0.3), -0.42, -0.36, -0.5, -0.2, 0.2, -0.1);

  kit.addMuzzleFlash(pod, 0, 0, -0.47, 2.1, 0xff7b2e);
}

// ---------- tank: commander's magnified gunsight ----------
function buildTank(kit: VmKit): void {
  const m = kit.mats;
  kit.addGunnerCowl(0.35, -0.34, "#ffae2b", true);

  // Magnified optic ring + glass center-low (below the reticle)
  const sight = new THREE.Group();
  sight.position.set(0, -0.185, -0.4);
  kit.swayGroup.add(sight);
  kit.addPart(sight, new RoundedBoxGeometry(0.09, 0.045, 0.05, 1, 0.006), m.darkMetal, 0, -0.025, 0.02, -0.2, 0, 0);
  kit.addPart(sight, new THREE.TorusGeometry(0.052, 0.007, 8, 24), m.lightAlloy, 0, 0.015, 0);
  kit.addPart(sight, new THREE.CylinderGeometry(0.047, 0.047, 0.008, 20), m.glassCyan, 0, 0.015, 0, Math.PI / 2, 0, 0);
  for (const [dx, dy] of [
    [-0.028, 0],
    [0.028, 0],
    [0, 0.026],
    [0, -0.026],
  ] as const) {
    kit.addPart(sight, new THREE.BoxGeometry(dx === 0 ? 0.002 : 0.014, dy === 0 ? 0.002 : 0.014, 0.002), m.cockpitTrim, dx, 0.015 + dy, 0.005);
  }
  kit.glowPulses.push(kit.addPart(sight, new THREE.BoxGeometry(0.02, 0.004, 0.004), m.greenGlow, 0, 0.075, 0.02));

  // Periscope blocks under the brow
  for (const px of [-0.26, 0, 0.26]) {
    kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.07, 0.05, 0.05, 1, 0.006), m.darkMetal, px, 0.292, -0.43, 0.12, 0, 0);
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.055, 0.03, 0.006), m.glassTint, px, 0.29, -0.405, 0.12, 0, 0);
  }
  // Turret basket side walls + rib detail
  for (const s of [-1, 1]) {
    kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.05, 0.22, 0.3, 2, 0.01), m.darkMetal, s * 0.46, -0.24, -0.5, 0, s * 0.25, 0);
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.054, 0.02, 0.26), m.cockpitTrim, s * 0.46, -0.15, -0.5, 0, s * 0.25, 0);
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.054, 0.02, 0.26), m.cockpitTrim, s * 0.46, -0.33, -0.5, 0, s * 0.25, 0);
  }
  // Ready-rack: brass shells with dark tips on the right wall
  const rack = new THREE.Group();
  rack.position.set(0.41, -0.27, -0.5);
  rack.rotation.set(0, 0.3, -0.1);
  kit.swayGroup.add(rack);
  kit.addPart(rack, new RoundedBoxGeometry(0.07, 0.1, 0.2, 1, 0.006), m.cockpitTrim, 0, 0, 0);
  for (let i = 0; i < 3; i++) {
    const y = -0.028 + i * 0.028;
    kit.addPart(rack, new THREE.CylinderGeometry(0.011, 0.011, 0.16, 10), m.brassMat, 0.02, y, -0.02, Math.PI / 2, 0, 0);
    kit.addPart(rack, new THREE.CylinderGeometry(0.008, 0.011, 0.035, 10), m.darkMetal, 0.02, y, -0.115, Math.PI / 2, 0, 0);
  }
  kit.glowPulses.push(kit.addPart(rack, new THREE.BoxGeometry(0.012, 0.006, 0.02), m.amberGlow, 0.02, 0.028, -0.075, Math.PI / 2, 0, 0));

  // Single 120mm + coax MG
  addTankCannon(kit, 0, -0.255, 0.036, 0.62, true, 1.65);
  kit.addPart(kit.recoilGroup, new THREE.CylinderGeometry(0.012, 0.013, 0.34, 10), m.darkMetal, 0.085, -0.24, -0.68, Math.PI / 2, 0, 0);
}

// ---------- heavy: twin-cannon assault cowl ----------
function buildHeavy(kit: VmKit): void {
  const m = kit.mats;
  kit.addGunnerCowl(0.36, -0.34, "#ffae2b", true);

  // Heavier sloped armor brow stacked over the cowl
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(1.14, 0.05, 0.12, 2, 0.012), m.darkMetal, 0, 0.42, -0.45, 0.14, 0, 0);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(1.1, 0.03, 0.08, 1, 0.006), m.gunMetal, 0, 0.385, -0.42, 0.14, 0, 0);
  // Warning placards on the brow face
  for (const x of [-0.3, 0.3]) {
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.1, 0.028, 0.008), m.amberGlow, x, 0.372, -0.385, 0.14, 0, 0);
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.1, 0.006, 0.009), m.cockpitTrim, x, 0.372, -0.384, 0.14, 0, 0.5);
  }
  // Twin 155mm cannons + central trunnion guard + strobe
  addTankCannon(kit, -0.155, -0.25, 0.044, 0.66, true, 2.1);
  addTankCannon(kit, 0.155, -0.25, 0.044, 0.66, true, 2.1);
  kit.addPart(kit.recoilGroup, new RoundedBoxGeometry(0.09, 0.16, 0.3, 2, 0.014), m.darkMetal, 0, -0.25, -0.5);
  kit.glowPulses.push(kit.addPart(kit.recoilGroup, new THREE.BoxGeometry(0.02, 0.03, 0.02), m.redGlow, 0, -0.16, -0.46));
  // Ready-rack shell drums + low armed strobes
  for (const s of [-1, 1]) {
    kit.addPart(kit.swayGroup, new THREE.CylinderGeometry(0.05, 0.05, 0.06, 14), m.cockpitTrim, s * 0.42, -0.3, -0.5, Math.PI / 2, 0, 0);
    kit.addPart(kit.swayGroup, new THREE.CylinderGeometry(0.036, 0.036, 0.064, 10), m.brassMat, s * 0.42, -0.3, -0.5, Math.PI / 2, 0, 0);
    kit.glowPulses.push(kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.05, 0.006, 0.01), m.redGlow, s * 0.42, -0.25, -0.46));
  }
}

// ---------- arty: gun-layer seat, elevation quadrant, recoil sled ----------
function buildArty(kit: VmKit): void {
  const m = kit.mats;
  kit.addGunnerCowl(0.36, -0.34, "#ff5030", false);

  // Left elevation quadrant: toothed arc, graduated ticks, needle, readout
  const quad = new THREE.Group();
  quad.position.set(-0.37, -0.26, -0.45);
  quad.rotation.set(-0.2, 0.3, 0);
  kit.swayGroup.add(quad);
  kit.addPart(quad, new RoundedBoxGeometry(0.1, 0.14, 0.05, 2, 0.01), m.cockpitTrim, 0, -0.02, 0);
  kit.addPart(quad, new THREE.TorusGeometry(0.085, 0.008, 6, 20, Math.PI * 0.55), m.lightAlloy, 0.01, 0.045, 0.02, 0, 0, -Math.PI * 0.25);
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI * 0.22 + (i / 5) * Math.PI * 0.5;
    kit.addPart(quad, new THREE.BoxGeometry(0.012, 0.004, 0.004), m.darkMetal, 0.01 + Math.cos(a) * 0.085, 0.045 + Math.sin(a) * 0.085, 0.028, 0, 0, a);
  }
  kit.addPart(quad, new THREE.BoxGeometry(0.006, 0.055, 0.006), m.redGlow, 0.01, 0.028, 0.03, 0, 0, 0.5);
  kit.glowPulses.push(kit.addPart(quad, new THREE.BoxGeometry(0.05, 0.012, 0.006), m.greenGlow, 0, -0.07, 0.026));

  // Center-low recoil sled: slide rails, breech, stub howitzer barrel
  const sled = new THREE.Group();
  sled.position.set(0, -0.3, -0.5);
  kit.recoilGroup.add(sled);
  for (const s of [-1, 1]) {
    kit.addPart(sled, new RoundedBoxGeometry(0.028, 0.024, 0.5, 1, 0.004), m.lightAlloy, s * 0.06, -0.01, -0.15);
    kit.addPart(sled, new RoundedBoxGeometry(0.02, 0.05, 0.4, 1, 0.004), m.darkMetal, s * 0.085, -0.04, -0.12);
  }
  kit.addPart(sled, new RoundedBoxGeometry(0.17, 0.1, 0.16, 2, 0.012), m.darkMetal, 0, 0.02, -0.06);
  kit.addPart(sled, new THREE.CylinderGeometry(0.036, 0.042, 0.4, 14), m.gunMetal, 0, 0.03, -0.32, Math.PI / 2, 0, 0);
  kit.addPart(sled, new THREE.CylinderGeometry(0.05, 0.05, 0.07, 10), m.lightAlloy, 0, 0.03, -0.52, Math.PI / 2, 0, 0);
  kit.addMuzzleFlash(sled, 0, 0.03, -0.62, 1.9, 0xff8a30);

  // Right shell cradle: tray with stacked brass shells + tips
  const cradle = new THREE.Group();
  cradle.position.set(0.37, -0.27, -0.48);
  cradle.rotation.set(0, -0.24, 0.1);
  kit.swayGroup.add(cradle);
  kit.addPart(cradle, new RoundedBoxGeometry(0.08, 0.05, 0.24, 1, 0.008), m.cockpitTrim, 0, 0, 0);
  kit.addPart(cradle, new THREE.BoxGeometry(0.09, 0.014, 0.03), m.factionMat, 0, 0.03, 0.09);
  for (const y of [0.035, 0.068]) {
    kit.addPart(cradle, new THREE.CylinderGeometry(0.016, 0.016, 0.19, 10), m.brassMat, 0, y, -0.01, Math.PI / 2, 0, 0);
    kit.addPart(cradle, new THREE.ConeGeometry(0.016, 0.05, 10), m.lightAlloy, 0, y, -0.13, -Math.PI / 2, 0, 0);
  }
  // Gun-layer handwheel by the quadrant + seat pan
  const wheel = new THREE.Group();
  wheel.position.set(-0.19, -0.28, -0.42);
  wheel.rotation.set(0.3, 0.6, 0);
  kit.swayGroup.add(wheel);
  kit.addPart(wheel, new THREE.TorusGeometry(0.045, 0.007, 8, 18), m.gunMetal, 0, 0, 0);
  for (let i = 0; i < 3; i++) {
    kit.addPart(wheel, new THREE.CylinderGeometry(0.003, 0.003, 0.085, 6), m.lightAlloy, 0, 0, 0, 0, 0, (i / 3) * Math.PI);
  }
  kit.addPart(wheel, new THREE.CylinderGeometry(0.008, 0.008, 0.05, 8), m.darkMetal, 0, 0, 0.03, Math.PI / 2, 0, 0);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.16, 0.04, 0.14, 2, 0.012), m.cockpitTrim, -0.3, -0.4, -0.42);
  kit.addPart(kit.swayGroup, new THREE.CylinderGeometry(0.016, 0.02, 0.1, 8), m.darkMetal, -0.3, -0.34, -0.42);
}

// ---------- spider: walker view between front legs ----------
function buildSpider(kit: VmKit): void {
  const m = kit.mats;
  // Articulated front leg struts framing the view
  for (const s of [-1, 1]) {
    const leg = new THREE.Group();
    leg.position.set(s * 0.44, -0.12, -0.5);
    leg.rotation.set(0.06, -s * 0.16, s * 0.1);
    kit.swayGroup.add(leg);
    kit.addPart(leg, new RoundedBoxGeometry(0.07, 0.3, 0.09, 2, 0.014), m.factionMat, s * 0.03, 0.1, -0.02, 0.2, 0, s * 0.22);
    kit.addPart(leg, new THREE.CylinderGeometry(0.052, 0.052, 0.05, 12), m.gunMetal, s * 0.005, -0.055, -0.05, Math.PI / 2, 0, 0);
    kit.glowPulses.push(kit.addPart(leg, new THREE.TorusGeometry(0.045, 0.006, 6, 16), m.cyanGlow, s * 0.005, -0.055, -0.055));
    kit.addPart(leg, new RoundedBoxGeometry(0.05, 0.28, 0.07, 2, 0.012), m.gunMetal, -s * 0.015, -0.19, -0.08, -0.12, 0, -s * 0.12);
    kit.addPart(leg, new THREE.CylinderGeometry(0.012, 0.014, 0.2, 8), m.lightAlloy, s * 0.04, -0.16, -0.03, -0.12, 0, -s * 0.1);
    kit.addPart(leg, new RoundedBoxGeometry(0.09, 0.03, 0.1, 1, 0.008), m.darkMetal, -s * 0.01, -0.335, -0.1);
  }
  // Hip joint discs + glowing axle rings at the bottom edge
  for (const s of [-1, 1]) {
    kit.addPart(kit.swayGroup, new THREE.CylinderGeometry(0.042, 0.042, 0.04, 12), m.darkMetal, s * 0.18, -0.4, -0.46, Math.PI / 2, 0, 0);
    kit.glowPulses.push(kit.addPart(kit.swayGroup, new THREE.TorusGeometry(0.036, 0.005, 6, 14), m.amberGlow, s * 0.18, -0.4, -0.44));
  }
  // Cybernetic pincer mandibles low left/right
  for (const side of [-1, 1]) {
    const mand = new THREE.Group();
    mand.position.set(side * 0.3, -0.24, -0.5);
    mand.rotation.set(0.08, -side * 0.22, side * 0.15);
    kit.recoilGroup.add(mand);
    kit.addPart(mand, new RoundedBoxGeometry(0.1, 0.075, 0.15, 2, 0.012), m.factionMat, side * 0.04, 0, 0.06);
    kit.addPart(mand, new RoundedBoxGeometry(0.036, 0.04, 0.24, 2, 0.008), m.gunMetal, 0, 0, -0.1, 0, side * 0.18, 0);
    kit.addPart(mand, new THREE.ConeGeometry(0.024, 0.2, 6), m.lightAlloy, -side * 0.05, 0, -0.28, -Math.PI / 2, 0, side * 0.34);
    kit.glowPulses.push(kit.addPart(mand, new THREE.BoxGeometry(0.007, 0.01, 0.18), m.cyanGlow, -side * 0.02, 0.014, -0.14, 0, side * 0.18, 0));
  }
  // Sensor dome mast upper-left with spinning scanner ring
  const mast = new THREE.Group();
  mast.position.set(-0.32, 0.26, -0.5);
  mast.rotation.z = 0.3;
  kit.swayGroup.add(mast);
  kit.addPart(mast, new THREE.CylinderGeometry(0.01, 0.014, 0.1, 8), m.darkMetal, 0, -0.04, 0);
  kit.addPart(mast, new THREE.SphereGeometry(0.035, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), m.glassCyan, 0, 0.02, 0);
  const scan = new THREE.Group();
  scan.position.set(0, 0.02, 0);
  mast.add(scan);
  kit.addPart(scan, new THREE.TorusGeometry(0.052, 0.0035, 6, 24), m.cyanGlow, 0, 0, 0, Math.PI / 2, 0, 0);
  kit.addPart(scan, new THREE.SphereGeometry(0.006, 8, 6), m.cyanGlow, 0.052, 0, 0);
  kit.addPart(scan, new THREE.SphereGeometry(0.006, 8, 6), m.cyanGlow, -0.052, 0, 0);
  kit.spinners.push({ obj: scan, axis: "y", speed: 2.4 });
  // Optical HUD rim arc + tri-lens eye strip at the bottom edge
  kit.addPart(kit.swayGroup, new THREE.TorusGeometry(0.36, 0.007, 6, 32, Math.PI * 0.55), m.cyanGlow, 0, 0.06, -0.46, 0, 0, Math.PI * 0.225);
  kit.glowPulses.push(
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.016, 0.008, 0.008), m.cyanGlow, -0.03, -0.315, -0.42),
    kit.addPart(kit.swayGroup, new THREE.SphereGeometry(0.008, 8, 6), m.cyanGlow, 0, -0.315, -0.42),
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.016, 0.008, 0.008), m.cyanGlow, 0.03, -0.315, -0.42),
  );
  kit.addMuzzleFlash(kit.recoilGroup, 0, -0.2, -0.72, 1.1, 0x4ef6ff);
}

// ---------- himars: launch pod sight-line + fire-control MFD ----------
function buildHimars(kit: VmKit): void {
  const m = kit.mats;
  // Armored truck cab frame + divider
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(1.06, 0.078, 0.14, 2, 0.012), m.cockpitTrim, 0, 0.35, -0.44, 0.16, 0, 0);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.074, 0.64, 0.1, 2, 0.012), m.cockpitTrim, -0.5, 0.03, -0.44, -0.08, 0.22, -0.1);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.074, 0.64, 0.1, 2, 0.012), m.cockpitTrim, 0.5, 0.03, -0.44, -0.08, -0.22, 0.1);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.026, 0.16, 0.05, 1, 0.005), m.darkMetal, 0, 0.27, -0.44, 0.08, 0, 0);
  // Lower dash + faction corner plates
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(1.06, 0.105, 0.2, 2, 0.014), m.cockpitTrim, 0, -0.33, -0.46, -0.24, 0, 0);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.24, 0.024, 0.035, 1, 0.004), m.factionMat, -0.31, -0.285, -0.42, -0.24, 0, 0);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.24, 0.024, 0.035, 1, 0.004), m.factionMat, 0.31, -0.285, -0.42, -0.24, 0, 0);
  // Fire-control MFD: bezel + emissive screen + pulsing grid bars
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.26, 0.062, 0.026, 2, 0.005), m.darkMetal, 0, -0.272, -0.415, -0.36, 0, 0);
  kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.236, 0.05, 0.006), screen(kit, "#12303c"), 0, -0.27, -0.4, -0.36, 0, 0);
  const grid: [number, number, number, THREE.Material][] = [
    [-0.08, -0.264, 0.05, m.cyanGlow],
    [-0.02, -0.264, 0.04, m.greenGlow],
    [0.055, -0.264, 0.06, m.amberGlow],
    [-0.07, -0.278, 0.075, m.cyanGlow],
    [0.02, -0.278, 0.05, m.greenGlow],
    [0.08, -0.278, 0.03, m.cyanGlow],
    [-0.05, -0.29, 0.035, m.amberGlow],
    [0.05, -0.29, 0.07, m.cyanGlow],
  ];
  for (const [gx, gy, w, mat] of grid) {
    kit.glowPulses.push(kit.addPart(kit.swayGroup, new THREE.BoxGeometry(w, 0.006, 0.004), mat, gx, gy, -0.396, -0.36, 0, 0));
  }
  // Arming light row, right side of the console
  [m.redGlow, m.amberGlow, m.amberGlow, m.greenGlow].forEach((mat, i) => {
    kit.glowPulses.push(kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.014, 0.008, 0.006), mat, 0.15 + i * 0.028, -0.272, -0.402, -0.36, 0, 0));
  });

  // Elevated 6-tube pod on the right gantry
  const pod = new THREE.Group();
  pod.position.set(0.37, 0.02, -0.54);
  pod.rotation.set(0.22, -0.09, -0.03);
  kit.recoilGroup.add(pod);
  kit.addPart(pod, new RoundedBoxGeometry(0.24, 0.175, 0.56, 3, 0.016), m.gunMetal, 0, 0, 0);
  kit.addPart(pod, new RoundedBoxGeometry(0.252, 0.052, 0.36, 2, 0.008), m.factionMat, 0, 0.01, 0.02);
  for (const sx of [-0.085, 0.085]) {
    kit.addPart(pod, new RoundedBoxGeometry(0.024, 0.022, 0.62, 1, 0.004), m.lightAlloy, sx, 0.098, -0.02);
    kit.addPart(pod, new RoundedBoxGeometry(0.024, 0.022, 0.62, 1, 0.004), m.lightAlloy, sx, -0.098, -0.02);
  }
  kit.addPart(pod, new THREE.CylinderGeometry(0.02, 0.024, 0.3, 10), m.darkMetal, 0, -0.13, 0.1, Math.PI / 2, 0, 0);
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) {
      const tx = (c - 1) * 0.068;
      const ty = (r === 0 ? 1 : -1) * 0.038;
      kit.addPart(pod, new THREE.CylinderGeometry(0.026, 0.026, 0.09, 10), m.cockpitTrim, tx, ty, -0.27, Math.PI / 2, 0, 0);
      kit.addPart(pod, new THREE.ConeGeometry(0.018, 0.052, 10), (r + c) % 2 === 0 ? m.redGlow : m.amberGlow, tx, ty, -0.31, -Math.PI / 2, 0, 0);
      kit.addPart(pod, new THREE.TorusGeometry(0.028, 0.003, 6, 14), m.darkMetal, tx, ty, -0.315);
    }
  }
  kit.addMuzzleFlash(pod, 0, 0, -0.45, 2.15, 0xff7826);

  // Left stabilizer rail + rangefinder head
  const rail = new THREE.Group();
  rail.position.set(-0.4, -0.08, -0.56);
  rail.rotation.set(0.18, 0.09, 0.03);
  kit.recoilGroup.add(rail);
  kit.addPart(rail, new RoundedBoxGeometry(0.075, 0.09, 0.44, 2, 0.01), m.darkMetal, 0, 0, 0);
  kit.addPart(rail, new RoundedBoxGeometry(0.024, 0.024, 0.48, 1, 0.004), m.lightAlloy, 0, 0.056, -0.02);
  kit.glowPulses.push(kit.addPart(rail, new THREE.BoxGeometry(0.042, 0.026, 0.014), m.cyanGlow, 0, 0.01, -0.22));
  kit.addPart(rail, new THREE.CylinderGeometry(0.02, 0.02, 0.014, 12), m.glassCyan, 0, 0.02, -0.232, Math.PI / 2, 0, 0);
  kit.addMuzzleFlash(rail, 0, 0.02, -0.34, 1.35, 0xff9238);
}

// ---------- spy: suppressed pistol + covert sabotage tablet ----------
function buildSpy(kit: VmKit): void {
  const m = kit.mats;
  const gun = new THREE.Group();
  gun.position.set(0.24, -0.24, -0.44);
  gun.rotation.set(0.03, 0.07, -0.02);
  kit.recoilGroup.add(gun);

  const sleeveMat = armor(kit, "#1a1d24", 0.6, 0.28);
  const gloveMat = armor(kit, "#101318", 0.5, 0.38);

  // Compact suppressed pistol: slide, frame, suppressor tube
  kit.addPart(gun, new RoundedBoxGeometry(0.052, 0.058, 0.21, 2, 0.008), m.gunMetal, 0, 0.01, -0.05);
  kit.addPart(gun, new RoundedBoxGeometry(0.048, 0.05, 0.19, 2, 0.007), m.darkMetal, 0, -0.018, -0.045);
  kit.addPart(gun, new RoundedBoxGeometry(0.042, 0.078, 0.05, 2, 0.008), m.cockpitTrim, 0, -0.075, 0.03, -0.22, 0, 0);
  // Suppressor — the spy's signature
  kit.addPart(gun, new THREE.CylinderGeometry(0.021, 0.021, 0.15, 14), m.darkMetal, 0, 0.012, -0.235, Math.PI / 2, 0, 0);
  for (const z of [-0.19, -0.24, -0.29]) {
    kit.addPart(gun, new THREE.TorusGeometry(0.023, 0.0024, 6, 16), m.lightAlloy, 0, 0.012, z);
  }
  // Slide serrations + low-profile night sights
  for (let i = 0; i < 4; i++) {
    kit.addPart(gun, new THREE.BoxGeometry(0.056, 0.004, 0.008), m.cockpitTrim, 0, 0.028, 0.01 - i * 0.014);
  }
  kit.glowPulses.push(kit.addPart(gun, new THREE.BoxGeometry(0.005, 0.008, 0.004), m.greenGlow, 0, 0.045, -0.155));
  kit.glowPulses.push(kit.addPart(gun, new THREE.BoxGeometry(0.016, 0.006, 0.003), m.greenGlow, 0, 0.043, 0.045));
  kit.addMuzzleFlash(gun, 0, 0.012, -0.33, 0.55, 0x9adfff);

  // Left hand steadying — dark operative glove
  const leftArm = new THREE.Group();
  leftArm.position.set(-0.055, -0.085, -0.06);
  gun.add(leftArm);
  kit.addPart(leftArm, new RoundedBoxGeometry(0.05, 0.046, 0.06, 2, 0.012), gloveMat, 0.03, 0, 0, 0.12, 0.3, 0.22);
  kit.addPart(leftArm, new RoundedBoxGeometry(0.056, 0.05, 0.2, 2, 0.016), sleeveMat, -0.05, -0.05, 0.13, -0.3, -0.5, 0.16);

  // Covert sabotage tablet on the left — hacking interface with progress bars
  const tab = new THREE.Group();
  tab.position.set(-0.28, -0.16, -0.42);
  tab.rotation.set(-0.3, 0.3, 0.12);
  kit.swayGroup.add(tab);
  kit.addPart(tab, new RoundedBoxGeometry(0.2, 0.13, 0.012, 2, 0.004), m.darkMetal, 0, 0, 0);
  kit.addPart(tab, new THREE.BoxGeometry(0.184, 0.114, 0.004), screen(kit, "#0e3324"), 0, 0, 0.007);
  const bars: [number, number, THREE.Material][] = [
    [-0.045, 0.034, m.greenGlow],
    [0.02, 0.034, m.cyanGlow],
    [-0.02, 0.012, m.greenGlow],
    [0.045, 0.012, m.amberGlow],
    [-0.055, -0.01, m.cyanGlow],
    [0.01, -0.01, m.greenGlow],
    [0.058, -0.032, m.redGlow],
    [-0.03, -0.032, m.greenGlow],
  ];
  for (const [bx, by, mat] of bars) {
    kit.glowPulses.push(kit.addPart(tab, new THREE.BoxGeometry(0.032, 0.007, 0.003), mat, bx, by, 0.01));
  }
}

// ---------- ballistic: elevated SRBM launch rail + arming console ----------
function buildBallistic(kit: VmKit): void {
  const m = kit.mats;
  // Launch-vehicle cab frame + heavy dash
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(1.12, 0.08, 0.15, 2, 0.012), m.cockpitTrim, 0, 0.36, -0.46, 0.16, 0, 0);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.078, 0.66, 0.1, 2, 0.012), m.cockpitTrim, -0.53, 0.03, -0.46, -0.08, 0.24, -0.1);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.078, 0.66, 0.1, 2, 0.012), m.cockpitTrim, 0.53, 0.03, -0.46, -0.08, -0.24, 0.1);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(1.12, 0.11, 0.22, 2, 0.014), m.cockpitTrim, 0, -0.34, -0.48, -0.24, 0, 0);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.26, 0.026, 0.038, 1, 0.004), m.factionMat, -0.33, -0.29, -0.44, -0.24, 0, 0);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.26, 0.026, 0.038, 1, 0.004), m.factionMat, 0.33, -0.29, -0.44, -0.24, 0, 0);

  // Trajectory-plot MFD center console + launch-authorize key lights
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.3, 0.07, 0.028, 2, 0.005), m.darkMetal, 0, -0.27, -0.43, -0.38, 0, 0);
  kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.274, 0.056, 0.006), screen(kit, "#30180c"), 0, -0.268, -0.415, -0.38, 0, 0);
  const traj: [number, number, THREE.Material][] = [
    [-0.11, -0.258, m.amberGlow],
    [-0.06, -0.252, m.amberGlow],
    [0.0, -0.262, m.redGlow],
    [0.06, -0.274, m.amberGlow],
    [0.11, -0.28, m.redGlow],
  ];
  for (const [tx, ty, mat] of traj) {
    kit.glowPulses.push(kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.03, 0.006, 0.004), mat, tx, ty, -0.411, -0.38, 0, 0));
  }
  [m.redGlow, m.amberGlow, m.greenGlow].forEach((mat, i) => {
    kit.glowPulses.push(kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.016, 0.009, 0.006), mat, 0.18 + i * 0.03, -0.27, -0.417, -0.38, 0, 0));
  });

  // Elevated SRBM rail over the right shoulder — the big single-shot tube
  const rail = new THREE.Group();
  rail.position.set(0.34, 0.1, -0.58);
  rail.rotation.set(-0.34, -0.12, -0.04);
  kit.recoilGroup.add(rail);
  kit.addPart(rail, new RoundedBoxGeometry(0.22, 0.22, 0.72, 3, 0.02), m.gunMetal, 0, 0, 0);
  kit.addPart(rail, new RoundedBoxGeometry(0.232, 0.06, 0.5, 2, 0.008), m.factionMat, 0, 0.02, 0.04);
  kit.addPart(rail, new THREE.CylinderGeometry(0.085, 0.085, 0.62, 18), m.darkMetal, 0, 0.02, -0.05, Math.PI / 2, 0, 0);
  for (const z of [-0.24, -0.08, 0.08, 0.24]) {
    kit.addPart(rail, new THREE.TorusGeometry(0.088, 0.006, 8, 20), m.lightAlloy, 0, 0.02, z);
  }
  // Nose-cone tip peeking into view + warning chevrons
  kit.addPart(rail, new THREE.ConeGeometry(0.078, 0.16, 18), m.redGlow, 0, 0.02, -0.44, -Math.PI / 2, 0, 0);
  kit.addPart(rail, new THREE.BoxGeometry(0.19, 0.02, 0.06), m.amberGlow, 0, -0.1, 0.3);
  kit.addMuzzleFlash(rail, 0, 0.02, -0.5, 2.6, 0xffa02a);

  // Left launch-safety rail + countdown display
  const aux = new THREE.Group();
  aux.position.set(-0.42, -0.06, -0.56);
  aux.rotation.set(0.16, 0.1, 0.03);
  kit.recoilGroup.add(aux);
  kit.addPart(aux, new RoundedBoxGeometry(0.08, 0.1, 0.4, 2, 0.01), m.darkMetal, 0, 0, 0);
  kit.glowPulses.push(kit.addPart(aux, new THREE.BoxGeometry(0.05, 0.03, 0.016), m.redGlow, 0, 0.02, -0.2));
  kit.addPart(aux, new RoundedBoxGeometry(0.03, 0.03, 0.44, 1, 0.004), m.lightAlloy, 0, -0.06, 0);
}

// ---------- railtank: electromagnetic twin rails + capacitors ----------
function buildRailtank(kit: VmKit): void {
  const m = kit.mats;
  kit.addGunnerCowl(0.35, -0.34, "#38f2ff", true);

  // Sleek central optic between the rails
  const optic = new THREE.Group();
  optic.position.set(0, -0.2, -0.4);
  kit.swayGroup.add(optic);
  kit.addPart(optic, new RoundedBoxGeometry(0.11, 0.05, 0.06, 2, 0.008), m.darkMetal, 0, -0.01, 0.01, -0.15, 0, 0);
  kit.addPart(optic, new THREE.CylinderGeometry(0.02, 0.02, 0.02, 14), m.glassCyan, 0, 0.02, -0.01, Math.PI / 2, 0, 0);
  kit.glowPulses.push(kit.addPart(optic, new THREE.TorusGeometry(0.026, 0.0026, 6, 18), m.cyanGlow, 0, 0.02, -0.022));
  // Charge-status bars flanking the rangefinder on the dash lip
  for (const s of [-1, 1]) {
    kit.glowPulses.push(kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.07, 0.007, 0.006), m.cyanGlow, s * 0.24, -0.295, -0.398, -0.34, 0, 0));
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.074, 0.012, 0.005), m.cockpitTrim, s * 0.24, -0.295, -0.401, -0.34, 0, 0);
  }

  for (const side of [-1, 1]) {
    const ox = side * 0.165;
    const oy = -0.245;
    // Armored breech + capacitor bottle bank with charge bands
    kit.addPart(kit.recoilGroup, new RoundedBoxGeometry(0.155, 0.135, 0.28, 2, 0.014), m.darkMetal, ox, oy, -0.48);
    kit.addPart(kit.recoilGroup, new RoundedBoxGeometry(0.165, 0.05, 0.24, 2, 0.008), m.factionMat, ox, oy + 0.045, -0.52);
    kit.glowPulses.push(kit.addPart(kit.recoilGroup, new THREE.BoxGeometry(0.058, 0.01, 0.085), m.cyanGlow, ox, oy + 0.075, -0.51));
    for (const cx of [-0.035, 0.035]) {
      kit.addPart(kit.recoilGroup, new THREE.CylinderGeometry(0.018, 0.018, 0.16, 10), m.lightAlloy, ox + cx, oy + 0.09, -0.5, Math.PI / 2, 0, 0);
      kit.glowPulses.push(kit.addPart(kit.recoilGroup, new THREE.CylinderGeometry(0.019, 0.019, 0.014, 10), m.cyanGlow, ox + cx, oy + 0.09, -0.47, Math.PI / 2, 0, 0));
    }
    // Parallel accelerator rails + plasma channel + armor fin
    kit.addPart(kit.recoilGroup, new RoundedBoxGeometry(0.048, 0.024, 0.78, 2, 0.005), m.lightAlloy, ox, oy + 0.028, -0.92);
    kit.addPart(kit.recoilGroup, new RoundedBoxGeometry(0.048, 0.024, 0.78, 2, 0.005), m.lightAlloy, ox, oy - 0.028, -0.92);
    kit.addPart(kit.recoilGroup, new RoundedBoxGeometry(0.016, 0.064, 0.62, 1, 0.004), m.gunMetal, ox + side * 0.032, oy, -0.84);
    kit.glowPulses.push(kit.addPart(kit.recoilGroup, new THREE.BoxGeometry(0.018, 0.022, 0.74), m.cyanGlow, ox, oy, -0.92));
    // Accelerator coil collars
    for (let c = 0; c < 4; c++) {
      const cz = -0.66 - c * 0.18;
      kit.addPart(kit.recoilGroup, new RoundedBoxGeometry(0.074, 0.086, 0.026, 2, 0.005), m.darkMetal, ox, oy, cz);
      kit.glowPulses.push(kit.addPart(kit.recoilGroup, new THREE.BoxGeometry(0.08, 0.014, 0.014), m.cyanGlow, ox, oy, cz));
    }
    // Muzzle prongs + electromagnetic flash
    kit.addPart(kit.recoilGroup, new RoundedBoxGeometry(0.068, 0.026, 0.08, 1, 0.004), m.darkMetal, ox, oy + 0.032, -1.32);
    kit.addPart(kit.recoilGroup, new RoundedBoxGeometry(0.068, 0.026, 0.08, 1, 0.004), m.darkMetal, ox, oy - 0.032, -1.32);
    kit.addMuzzleFlash(kit.recoilGroup, ox, oy, -1.4, 2.15, 0x5cf6ff);
  }
}

// ---------- supplytruck: armored logistics cab ----------
function buildSupplytruck(kit: VmKit): void {
  const m = kit.mats;
  const oliveArmor = armor(kit, "#323d35", 0.46, 0.56);
  // Sloped cab A-pillars + faction stripes
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.064, 0.62, 0.085, 2, 0.01), m.cockpitTrim, -0.5, 0.05, -0.45, -0.18, 0.22, -0.15);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.064, 0.62, 0.085, 2, 0.01), m.cockpitTrim, 0.5, 0.05, -0.45, -0.18, -0.22, 0.15);
  kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.014, 0.34, 0.02), m.factionMat, -0.468, 0.04, -0.43, -0.18, 0.22, -0.15);
  kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.014, 0.34, 0.02), m.factionMat, 0.468, 0.04, -0.43, -0.18, -0.22, 0.15);
  // Brow, visor strip, center mullion, clearance lights
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(1.06, 0.072, 0.14, 2, 0.012), oliveArmor, 0, 0.355, -0.45, 0.18, 0, 0);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.68, 0.024, 0.04, 1, 0.005), m.factionMat, 0, 0.325, -0.415, 0.18, 0, 0);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.024, 0.13, 0.045, 1, 0.004), m.darkMetal, 0, 0.29, -0.45, 0.12, 0, 0);
  kit.glowPulses.push(
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.042, 0.014, 0.012), m.amberGlow, -0.37, 0.33, -0.4),
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.042, 0.014, 0.012), m.amberGlow, 0.37, 0.33, -0.4),
  );
  // Side mirrors: twin arms + housing + tinted glass + marker pip
  for (const sx of [-1, 1]) {
    kit.addPart(kit.swayGroup, new THREE.CylinderGeometry(0.006, 0.006, 0.1, 8), m.darkMetal, sx * 0.54, 0.11, -0.48, 0, 0, Math.PI / 2);
    kit.addPart(kit.swayGroup, new THREE.CylinderGeometry(0.006, 0.006, 0.1, 8), m.darkMetal, sx * 0.54, -0.05, -0.48, 0, 0, Math.PI / 2);
    kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.068, 0.19, 0.026, 2, 0.006), m.cockpitTrim, sx * 0.585, 0.03, -0.49, 0, -sx * 0.34, 0);
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.054, 0.165, 0.006), m.glassTint, sx * 0.578, 0.03, -0.476, 0, -sx * 0.34, 0);
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.01, 0.024, 0.012), m.amberGlow, sx * 0.618, 0.03, -0.495, 0, -sx * 0.34, 0);
  }
  // Lower dash + faction badges
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(1.06, 0.11, 0.22, 2, 0.015), m.cockpitTrim, 0, -0.325, -0.46, -0.22, 0, 0);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.18, 0.022, 0.032, 1, 0.004), m.factionMat, -0.34, -0.278, -0.415, -0.22, 0, 0);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.18, 0.022, 0.032, 1, 0.004), m.factionMat, 0.34, -0.278, -0.415, -0.22, 0, 0);
  // Steering yoke: open-top rim + crossbar + hub + grips
  kit.addPart(kit.swayGroup, new THREE.TorusGeometry(0.11, 0.013, 10, 24, Math.PI * 0.95), m.darkMetal, -0.23, -0.36, -0.39, 0.52, 0, Math.PI * 1.02);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.19, 0.022, 0.02, 1, 0.004), m.darkMetal, -0.23, -0.318, -0.408, 0.52, 0, 0);
  kit.addPart(kit.swayGroup, new THREE.CylinderGeometry(0.026, 0.03, 0.05, 10), m.gunMetal, -0.23, -0.35, -0.4, 0.52 + Math.PI / 2, 0, 0);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.03, 0.016, 0.016, 1, 0.003), m.cockpitTrim, -0.315, -0.325, -0.405, 0.52, 0, 0);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.03, 0.016, 0.016, 1, 0.003), m.cockpitTrim, -0.145, -0.325, -0.405, 0.52, 0, 0);
  // Center console + live cargo gauge (tilted to match the dash face)
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.28, 0.056, 0.032, 2, 0.006), m.darkMetal, 0, -0.272, -0.415, -0.34, 0, 0);
  const gauge = new THREE.Group();
  gauge.position.set(0, -0.266, -0.402);
  gauge.rotation.x = -0.34;
  kit.swayGroup.add(gauge);
  kit.addSupplyBar(gauge, 0, 0, 0, 0.196, 0.014, "#3cf084");
  kit.glowPulses.push(
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.055, 0.007, 0.006), m.cyanGlow, -0.068, -0.284, -0.394, -0.34, 0, 0),
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.055, 0.007, 0.006), m.amberGlow, 0.068, -0.284, -0.394, -0.34, 0, 0),
  );
  // Convoy radio on the right dash: chassis, channel display, grille, whip
  const radio = new THREE.Group();
  radio.position.set(0.32, -0.27, -0.43);
  radio.rotation.set(-0.34, -0.15, 0);
  kit.swayGroup.add(radio);
  kit.addPart(radio, new RoundedBoxGeometry(0.12, 0.07, 0.035, 1, 0.005), m.darkMetal, 0, 0, 0);
  kit.glowPulses.push(kit.addPart(radio, new THREE.BoxGeometry(0.045, 0.014, 0.006), m.greenGlow, -0.025, 0.012, 0.02));
  for (let i = 0; i < 3; i++) {
    kit.addPart(radio, new THREE.BoxGeometry(0.008, 0.024, 0.006), m.cockpitTrim, 0.024 + i * 0.014, -0.008, 0.02);
  }
  kit.addPart(radio, new THREE.CylinderGeometry(0.0025, 0.0035, 0.14, 6), m.cockpitTrim, 0.045, 0.1, 0.005, -0.2, 0, 0.15);
  kit.addPart(radio, new THREE.SphereGeometry(0.004, 6, 6), m.redGlow, 0.052, 0.168, 0.018);
  // Twin round dash gauges left of console
  for (const gx of [-0.13, -0.19]) {
    kit.addPart(kit.swayGroup, new THREE.CylinderGeometry(0.021, 0.021, 0.012, 14), m.cockpitTrim, gx, -0.272, -0.42, Math.PI / 2 - 0.34, 0, 0);
    kit.addPart(kit.swayGroup, new THREE.CylinderGeometry(0.016, 0.016, 0.006, 12), m.glassCyan, gx, -0.27, -0.415, Math.PI / 2 - 0.34, 0, 0);
  }
  // Sloped hood + radiator grille + convoy marker
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.54, 0.06, 0.42, 2, 0.012), oliveArmor, 0, -0.365, -0.76, 0.06, 0, 0);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.32, 0.018, 0.34, 1, 0.004), m.gunMetal, 0, -0.332, -0.76, 0.06, 0, 0);
  for (let i = 0; i < 5; i++) {
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.012, 0.02, 0.012), m.cockpitTrim, -0.12 + i * 0.06, -0.33, -0.9, 0.06, 0, 0);
  }
  kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.14, 0.01, 0.025), m.greenGlow, 0, -0.335, -0.94, 0.06, 0, 0);
}

// ---------- harvester: industrial mining cab + scoop drum ----------
function buildHarvester(kit: VmKit): void {
  const m = kit.mats;
  // Chunky roll-cage frame + inner diagonal bars + faction brow
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.068, 0.62, 0.075, 2, 0.01), m.cockpitTrim, -0.49, 0.04, -0.45, -0.12, 0.2, -0.14);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.068, 0.62, 0.075, 2, 0.01), m.cockpitTrim, 0.49, 0.04, -0.45, -0.12, -0.2, 0.14);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.03, 0.5, 0.04, 1, 0.006), m.darkMetal, -0.36, 0.02, -0.44, -0.12, 0.24, -0.3);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.03, 0.5, 0.04, 1, 0.006), m.darkMetal, 0.36, 0.02, -0.44, -0.12, -0.24, 0.3);
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(1.02, 0.075, 0.12, 2, 0.012), m.factionMat, 0, 0.35, -0.46, 0.16, 0, 0);
  // Roof work-light bar on the brow face
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.3, 0.028, 0.03, 1, 0.005), m.darkMetal, 0, 0.318, -0.405, 0.16, 0, 0);
  kit.glowPulses.push(
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.05, 0.014, 0.01), m.amberGlow, -0.09, 0.316, -0.39, 0.16, 0, 0),
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.05, 0.014, 0.01), m.amberGlow, 0, 0.316, -0.39, 0.16, 0, 0),
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.05, 0.014, 0.01), m.amberGlow, 0.09, 0.316, -0.39, 0.16, 0, 0),
  );
  // Lower dash + hazard stripe strip (right half) + amber work lights
  kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.96, 0.09, 0.18, 2, 0.014), m.cockpitTrim, 0, -0.32, -0.46, -0.2, 0, 0);
  kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.32, 0.02, 0.008), m.amberGlow, 0.28, -0.307, -0.387, -0.2, 0, 0);
  for (let i = 0; i < 5; i++) {
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.02, 0.022, 0.009), m.cockpitTrim, 0.15 + i * 0.07, -0.307, -0.386, -0.2, 0, 0.5);
  }
  kit.glowPulses.push(
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.08, 0.022, 0.02), m.amberGlow, -0.32, -0.28, -0.4),
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.08, 0.022, 0.02), m.amberGlow, 0.32, -0.28, -0.4),
  );
  // Live ore cargo gauge, left dash
  const gauge = new THREE.Group();
  gauge.position.set(-0.2, -0.29, -0.404);
  gauge.rotation.x = -0.2;
  kit.swayGroup.add(gauge);
  kit.addSupplyBar(gauge, 0, 0, 0, 0.13, 0.014, "#ffae2b");
  // Spinning ore-scoop crusher drum + prongs low ahead
  const drum = new THREE.Group();
  drum.position.set(0, -0.31, -0.76);
  kit.swayGroup.add(drum);
  kit.addPart(drum, new THREE.CylinderGeometry(0.062, 0.062, 0.56, 12), m.gunMetal, 0, 0, 0, 0, 0, Math.PI / 2);
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2;
    for (const px of [-0.2, -0.07, 0.07, 0.2]) {
      kit.addPart(drum, new RoundedBoxGeometry(0.032, 0.085, 0.024, 1, 0.004), m.brassMat, px, Math.cos(ang) * 0.082, Math.sin(ang) * 0.082, ang, 0, 0);
    }
  }
  kit.spinners.push({ obj: drum, axis: "x", speed: -3.2 });
  // Intake housing cheeks + faction guards + feed fins
  for (const s of [-1, 1]) {
    kit.addPart(kit.swayGroup, new RoundedBoxGeometry(0.05, 0.16, 0.3, 2, 0.012), m.darkMetal, s * 0.33, -0.33, -0.74, 0.1, 0, 0);
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.054, 0.02, 0.1), m.factionMat, s * 0.33, -0.26, -0.78, 0.1, 0, 0);
  }
  for (const fx of [-0.12, -0.06, 0, 0.06, 0.12]) {
    kit.addPart(kit.swayGroup, new THREE.BoxGeometry(0.02, 0.09, 0.016), m.cockpitTrim, fx, -0.37, -0.68, 0.5, 0, 0);
  }
  // Exhaust stack up the right pillar
  kit.addPart(kit.swayGroup, new THREE.CylinderGeometry(0.022, 0.026, 0.22, 10), m.darkMetal, 0.43, -0.18, -0.5, 0.15, 0, -0.12);
  kit.addPart(kit.swayGroup, new THREE.CylinderGeometry(0.028, 0.024, 0.05, 10), m.gunMetal, 0.443, -0.07, -0.515, 0.15, 0, -0.12);
}

export const LAND_VM: Partial<Record<UnitKind, (kit: VmKit) => void>> = {
  infantry: buildInfantry,
  engineer: buildEngineer,
  rocket: buildRocket,
  tank: buildTank,
  heavy: buildHeavy,
  arty: buildArty,
  spider: buildSpider,
  himars: buildHimars,
  spy: buildSpy,
  ballistic: buildBallistic,
  railtank: buildRailtank,
  supplytruck: buildSupplytruck,
  harvester: buildHarvester,
};
