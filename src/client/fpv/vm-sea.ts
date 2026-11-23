// Sea-domain 1P viewmodels (ships, sub, kamikaze USV, carrier).
// Each entry fully replaces the legacy fpv.ts cockpit branch for that kind.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { UnitKind } from "../../shared/gamedefs";
import type { VmKit } from "./vmkit";

const RX = Math.PI / 2;

// Sea-Baby USV: ultra-low unmanned bow-cam — splash guard, contact-fuse tips,
// shaped-charge nose, satcom dome peeking top corner, spray speckle, LEDs.
function buildUsvVm(kit: VmKit): void {
  const { swayGroup: S, recoilGroup: R, mats: M, glowPulses } = kit;
  const sprayMat = kit.trackMat(
    new THREE.MeshBasicMaterial({ color: 0xcfeaf8, transparent: true, opacity: 0.16, depthWrite: false }),
  );

  // Low splash-guard frame hugging the bottom edge
  kit.addPart(S, new RoundedBoxGeometry(1.04, 0.05, 0.12, 2, 0.01), M.cockpitTrim, 0, -0.365, -0.44, -0.2, 0, 0);
  kit.addPart(S, new RoundedBoxGeometry(0.3, 0.028, 0.05, 1, 0.006), M.gunMetal, 0, -0.338, -0.47, -0.2, 0, 0);
  for (const sx of [-1, 1]) {
    kit.addPart(S, new RoundedBoxGeometry(0.07, 0.22, 0.1, 2, 0.01), M.cockpitTrim, sx * 0.52, -0.26, -0.44, -0.1, -sx * 0.18, sx * 0.12);
    kit.addPart(S, new RoundedBoxGeometry(0.1, 0.016, 0.026, 1, 0.003), M.factionMat, sx * 0.4, -0.335, -0.42, -0.2, 0, 0);
  }

  // Wave-piercing bow spine + shaped-charge nose + twin contact-fuse tips
  kit.addPart(R, new RoundedBoxGeometry(0.16, 0.024, 0.3, 2, 0.006), M.darkMetal, 0, -0.345, -0.62, 0.05, 0, 0);
  kit.addPart(R, new RoundedBoxGeometry(0.11, 0.014, 0.12, 1, 0.003), M.factionMat, 0, -0.33, -0.55, 0.05, 0, 0);
  kit.addPart(R, new THREE.CylinderGeometry(0.055, 0.068, 0.1, 12), M.gunMetal, 0, -0.3, -0.58, RX, 0, 0);
  kit.addPart(R, new THREE.CylinderGeometry(0.02, 0.02, 0.05, 8), M.factionMat, 0, -0.3, -0.63, RX, 0, 0);
  kit.addPart(R, new THREE.ConeGeometry(0.05, 0.16, 12), M.darkMetal, 0, -0.3, -0.72, -RX, 0, 0);
  for (const sx of [-1, 1]) {
    kit.addPart(R, new THREE.CylinderGeometry(0.007, 0.01, 0.15, 8), M.lightAlloy, sx * 0.058, -0.3, -0.62, RX, -sx * 0.14, 0);
    kit.addPart(R, new THREE.SphereGeometry(0.012, 8, 8), M.darkMetal, sx * 0.068, -0.3, -0.7);
  }
  kit.addMuzzleFlash(R, 0, -0.3, -0.84, 2.3, 0xff4a24);

  // Satcom dome edge peeking top-right corner + whip antenna
  const domeGeo = new THREE.SphereGeometry(0.082, 16, 12);
  domeGeo.scale(1, 0.6, 1);
  kit.addPart(S, domeGeo, M.lightAlloy, 0.47, 0.32, -0.42);
  kit.addPart(S, new THREE.CylinderGeometry(0.05, 0.06, 0.028, 12), M.darkMetal, 0.47, 0.29, -0.42);
  kit.addPart(S, new THREE.CylinderGeometry(0.0025, 0.0025, 0.1, 6), M.darkMetal, 0.41, 0.365, -0.4, 0, 0, -0.24);

  // Sea-spray speckle hints on the lens edges
  const specks: [number, number][] = [
    [-0.5, 0.16],
    [-0.45, -0.08],
    [-0.34, 0.31],
    [0.51, 0.05],
    [0.44, -0.16],
    [0.28, -0.34],
  ];
  specks.forEach(([sx, sy], i) => {
    const drop = kit.addPart(
      S,
      new THREE.PlaneGeometry(0.014 + (i % 3) * 0.009, 0.01 + (i % 2) * 0.007),
      sprayMat,
      sx,
      sy,
      -0.4,
      0,
      0,
      i * 0.9,
    );
    drop.renderOrder = 2;
  });

  // Waterproof telemetry status LEDs
  glowPulses.push(
    kit.addPart(S, new THREE.BoxGeometry(0.042, 0.009, 0.01), M.cyanGlow, -0.3, -0.34, -0.405, -0.2, 0, 0),
    kit.addPart(S, new THREE.BoxGeometry(0.042, 0.009, 0.01), M.greenGlow, -0.24, -0.34, -0.405, -0.2, 0, 0),
    kit.addPart(S, new THREE.BoxGeometry(0.03, 0.009, 0.01), M.redGlow, 0.32, -0.34, -0.405, -0.2, 0, 0),
    kit.addPart(R, new THREE.SphereGeometry(0.02, 10, 8), M.redGlow, 0, -0.27, -0.5),
  );
}

// Viper Hydrofoil: compact patrol helm — single windscreen, wiper hints,
// gun-shield plates flanking center, deck gun below, dash radar dome sweep.
function buildGunboatVm(kit: VmKit): void {
  const { swayGroup: S, recoilGroup: R, mats: M, glowPulses, spinners } = kit;

  // Single-pane windscreen frame (no mullions)
  kit.addPart(S, new RoundedBoxGeometry(0.98, 0.055, 0.11, 2, 0.01), M.cockpitTrim, 0, 0.345, -0.45, 0.16, 0, 0);
  kit.addPart(S, new RoundedBoxGeometry(1.0, 0.095, 0.2, 2, 0.014), M.cockpitTrim, 0, -0.34, -0.48, -0.24, 0, 0);
  for (const sx of [-1, 1]) {
    kit.addPart(S, new RoundedBoxGeometry(0.05, 0.6, 0.09, 2, 0.008), M.cockpitTrim, sx * 0.49, 0, -0.45, -0.14, -sx * 0.16, sx * 0.1);
    kit.addPart(S, new THREE.BoxGeometry(0.012, 0.2, 0.02), M.factionMat, sx * 0.463, 0.02, -0.43, -0.14, -sx * 0.16, sx * 0.1);
    // Parked wiper arm + blade hint along lower pane edges
    kit.addPart(S, new RoundedBoxGeometry(0.007, 0.22, 0.012, 1, 0.002), M.darkMetal, sx * 0.3, -0.24, -0.42, -0.2, 0, sx * 1.05);
    kit.addPart(S, new THREE.CylinderGeometry(0.011, 0.011, 0.016, 8), M.gunMetal, sx * 0.31, -0.3, -0.415, RX, 0, 0);
  }

  // Angled gun-shield plates left/right of center
  for (const sx of [-1, 1]) {
    kit.addPart(S, new RoundedBoxGeometry(0.15, 0.24, 0.024, 2, 0.006), M.gunMetal, sx * 0.3, -0.14, -0.47, -0.08, -sx * 0.34, 0);
    kit.addPart(S, new THREE.BoxGeometry(0.014, 0.22, 0.014), M.lightAlloy, sx * 0.375, -0.14, -0.45, -0.08, -sx * 0.34, 0);
  }

  // Rapid-fire deck gun: mantlet + barrel + muzzle brake, low-center
  kit.addPart(R, new RoundedBoxGeometry(0.15, 0.12, 0.12, 2, 0.012), M.darkMetal, 0, -0.3, -0.52);
  kit.addPart(R, new THREE.CylinderGeometry(0.017, 0.021, 0.52, 12), M.gunMetal, 0, -0.3, -0.82, RX, 0, 0);
  kit.addPart(R, new THREE.CylinderGeometry(0.011, 0.011, 0.3, 8), M.darkMetal, -0.06, -0.29, -0.74, RX, 0, 0);
  kit.addPart(R, new RoundedBoxGeometry(0.048, 0.044, 0.07, 1, 0.008), M.darkMetal, 0, -0.3, -1.06);
  kit.addMuzzleFlash(R, 0, -0.3, -1.13, 1.6, 0xffb33a);

  // Small radar dome with sweep bar on dash
  kit.addPart(S, new THREE.CylinderGeometry(0.052, 0.062, 0.024, 16), M.darkMetal, -0.31, -0.29, -0.42, -0.24, 0, 0);
  const domeGeo = new THREE.SphereGeometry(0.046, 14, 10);
  domeGeo.scale(1, 0.55, 1);
  kit.addPart(S, domeGeo, M.glassTint, -0.31, -0.272, -0.415, -0.24, 0, 0);
  const sweep = new THREE.Group();
  sweep.position.set(-0.31, -0.264, -0.412);
  sweep.rotation.x = -0.24;
  S.add(sweep);
  kit.addPart(sweep, new THREE.BoxGeometry(0.005, 0.004, 0.046), M.cyanGlow, 0, 0, -0.023);
  spinners.push({ obj: sweep, axis: "y", speed: -2.8 });

  // Compact helm console glows + compass strip
  glowPulses.push(
    kit.addPart(S, new THREE.BoxGeometry(0.16, 0.012, 0.008), M.cyanGlow, 0.05, -0.3, -0.405, -0.24, 0, 0),
    kit.addPart(S, new THREE.BoxGeometry(0.09, 0.007, 0.008), M.greenGlow, 0.05, -0.316, -0.403, -0.24, 0, 0),
    kit.addPart(S, new THREE.BoxGeometry(0.07, 0.01, 0.008), M.amberGlow, 0.32, -0.297, -0.408, -0.24, 0, 0),
    kit.addPart(S, new THREE.BoxGeometry(0.07, 0.01, 0.008), M.greenGlow, -0.18, -0.297, -0.408, -0.24, 0, 0),
  );
}

// Aegis Destroyer: full bridge — wide multi-pane windows, gun director horns
// above, VLS hatch grid, helm wheel, sonar waterfall, 5" gun low center.
function buildDestroyerVm(kit: VmKit): void {
  const { swayGroup: S, recoilGroup: R, mats: M, glowPulses, spinners } = kit;

  // Wide bridge window: brow, sill, posts, twin mullions (three panes)
  kit.addPart(S, new RoundedBoxGeometry(1.14, 0.062, 0.14, 2, 0.012), M.cockpitTrim, 0, 0.355, -0.45, 0.13, 0, 0);
  kit.addPart(S, new RoundedBoxGeometry(1.14, 0.08, 0.18, 2, 0.014), M.cockpitTrim, 0, -0.335, -0.47, -0.22, 0, 0);
  for (const sx of [-1, 1]) {
    kit.addPart(S, new RoundedBoxGeometry(0.055, 0.64, 0.1, 2, 0.008), M.cockpitTrim, sx * 0.55, 0.01, -0.45, -0.12, -sx * 0.17, sx * 0.09);
    kit.addPart(S, new RoundedBoxGeometry(0.02, 0.6, 0.045, 1, 0.004), M.gunMetal, sx * 0.265, 0.02, -0.45, -0.12, -sx * 0.05, sx * 0.05);
    // Gun director horn funnels peeking over the brow edge
    kit.addPart(S, new RoundedBoxGeometry(0.045, 0.06, 0.09, 1, 0.008), M.darkMetal, sx * 0.155, 0.302, -0.45, -0.5, 0, 0);
    kit.addPart(S, new THREE.ConeGeometry(0.026, 0.08, 10), M.lightAlloy, sx * 0.155, 0.315, -0.435, -0.6, 0, 0);
  }
  kit.addPart(S, new RoundedBoxGeometry(0.4, 0.028, 0.05, 1, 0.005), M.darkMetal, 0, 0.3, -0.46);
  kit.addPart(S, new THREE.BoxGeometry(0.05, 0.02, 0.01), M.glassTint, 0, 0.295, -0.435);

  // Bridge console desk + faction fleet tabs
  kit.addPart(S, new RoundedBoxGeometry(0.94, 0.1, 0.24, 2, 0.014), M.cockpitTrim, 0, -0.33, -0.5, -0.24, 0, 0);
  kit.addPart(S, new RoundedBoxGeometry(0.16, 0.02, 0.03, 1, 0.004), M.factionMat, -0.38, -0.283, -0.42, -0.24, 0, 0);
  kit.addPart(S, new RoundedBoxGeometry(0.16, 0.02, 0.03, 1, 0.004), M.factionMat, 0.38, -0.283, -0.42, -0.24, 0, 0);

  // Helm wheel on right console
  const wheel = new THREE.Group();
  wheel.position.set(0.3, -0.26, -0.43);
  wheel.rotation.x = -0.5;
  S.add(wheel);
  kit.addPart(wheel, new THREE.TorusGeometry(0.048, 0.007, 8, 20), M.brassMat, 0, 0, 0);
  kit.addPart(wheel, new THREE.BoxGeometry(0.008, 0.1, 0.008), M.brassMat, 0, 0, 0);
  kit.addPart(wheel, new THREE.BoxGeometry(0.1, 0.008, 0.008), M.brassMat, 0, 0, 0);
  kit.addPart(wheel, new THREE.CylinderGeometry(0.013, 0.013, 0.02, 8), M.darkMetal, 0, 0, 0, RX, 0, 0);
  spinners.push({ obj: wheel, axis: "z", speed: 0.22 });

  // VLS hatch-status grid on left console (mix of lit/unlit cells)
  kit.addPart(S, new RoundedBoxGeometry(0.21, 0.058, 0.02, 1, 0.004), M.darkMetal, -0.3, -0.272, -0.43, -0.26, 0.08, 0);
  for (let i = 0; i < 8; i++) {
    const cx = -0.372 + (i % 4) * 0.048;
    const cy = -0.26 - Math.floor(i / 4) * 0.024;
    const lit = i % 3 !== 0;
    const cell = kit.addPart(S, new THREE.BoxGeometry(0.034, 0.016, 0.006), lit ? M.greenGlow : M.gunMetal, cx, cy, -0.419, -0.26, 0.08, 0);
    if (lit) glowPulses.push(cell);
  }

  // Sonar waterfall screen: stacked glowing bars on center-left console
  kit.addPart(S, new RoundedBoxGeometry(0.2, 0.078, 0.02, 1, 0.004), M.darkMetal, -0.02, -0.27, -0.43, -0.26, 0, 0);
  for (let i = 0; i < 6; i++) {
    const w = 0.15 - (i % 3) * 0.032;
    glowPulses.push(
      kit.addPart(
        S,
        new THREE.BoxGeometry(w, 0.0075, 0.006),
        i % 2 ? M.greenGlow : M.cyanGlow,
        -0.02 - (0.15 - w) / 2,
        -0.249 - i * 0.0112,
        -0.417,
        -0.26,
        0,
        0,
      ),
    );
  }
  glowPulses.push(
    kit.addPart(S, new THREE.BoxGeometry(0.05, 0.011, 0.008), M.cyanGlow, 0.16, -0.263, -0.42, -0.26, -0.06, 0),
    kit.addPart(S, new THREE.BoxGeometry(0.05, 0.011, 0.008), M.amberGlow, 0.16, -0.281, -0.418, -0.26, -0.06, 0),
  );

  // Single 5" deck gun low center: mantlet, barrel, brake, flash
  kit.addPart(R, new RoundedBoxGeometry(0.17, 0.13, 0.13, 2, 0.014), M.darkMetal, 0, -0.33, -0.52);
  kit.addPart(R, new THREE.CylinderGeometry(0.02, 0.024, 0.58, 14), M.gunMetal, 0, -0.33, -0.86, RX, 0, 0);
  kit.addPart(R, new THREE.CylinderGeometry(0.027, 0.026, 0.12, 12), M.lightAlloy, 0, -0.33, -0.72, RX, 0, 0);
  kit.addPart(R, new RoundedBoxGeometry(0.056, 0.05, 0.08, 1, 0.008), M.darkMetal, 0, -0.33, -1.13);
  kit.addMuzzleFlash(R, 0, -0.33, -1.2, 1.9, 0xffb33a);
}

// Submarine attack center: periscope column + etched reticle glass, depth dial,
// dive-plane indicator, torpedo ready lights, sonar ping arcs, cramped trim.
function buildSubVm(kit: VmKit): void {
  const { swayGroup: S, recoilGroup: R, mats: M, glowPulses } = kit;
  const etchMat = kit.trackMat(
    new THREE.MeshBasicMaterial({
      color: 0x46e8ff,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );

  // Dark cramped interior: overhead pipe runs + side rib panels
  for (const pz of [-0.52, -0.6]) {
    kit.addPart(S, new THREE.CylinderGeometry(0.013, 0.013, 1.04, 8), M.gunMetal, 0, 0.295, pz, 0, 0, RX);
    kit.addPart(S, new THREE.CylinderGeometry(0.018, 0.018, 0.03, 8), M.brassMat, -0.3, 0.295, pz, 0, 0, RX);
    kit.addPart(S, new THREE.CylinderGeometry(0.018, 0.018, 0.03, 8), M.brassMat, 0.3, 0.295, pz, 0, 0, RX);
  }
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      kit.addPart(S, new RoundedBoxGeometry(0.05, 0.5, 0.07, 1, 0.006), M.cockpitTrim, sx * (0.44 - i * 0.03), -0.02 + i * 0.012, -0.46 - i * 0.012, -0.1, -sx * (0.3 - i * 0.06), sx * 0.1);
    }
  }

  // Periscope: mast above + handle post below, etched reticle gap at center
  kit.addPart(S, new RoundedBoxGeometry(0.052, 0.24, 0.08, 2, 0.008), M.darkMetal, 0, 0.21, -0.46);
  kit.addPart(S, new RoundedBoxGeometry(0.078, 0.06, 0.1, 2, 0.008), M.gunMetal, 0, 0.305, -0.47, 0.3, 0, 0);
  kit.addPart(S, new THREE.BoxGeometry(0.05, 0.02, 0.012), M.glassTint, 0, 0.292, -0.425, 0.3, 0, 0);
  kit.addPart(S, new RoundedBoxGeometry(0.05, 0.22, 0.07, 2, 0.008), M.darkMetal, 0, -0.28, -0.46);
  for (const sx of [-1, 1]) {
    kit.addPart(S, new THREE.CylinderGeometry(0.009, 0.009, 0.09, 8), M.brassMat, sx * 0.075, -0.16, -0.45, 0, 0, RX);
    kit.addPart(S, new THREE.SphereGeometry(0.012, 8, 8), M.cockpitTrim, sx * 0.115, -0.16, -0.45);
  }
  // Etched optic reticle: thin ring + cardinal ticks (aim point stays clear)
  const ring = kit.addPart(S, new THREE.TorusGeometry(0.088, 0.0016, 6, 40), etchMat, 0, 0, -0.44);
  ring.renderOrder = 2;
  for (const [tx, ty, vert] of [
    [0, 0.088, true],
    [0, -0.088, true],
    [0.088, 0, false],
    [-0.088, 0, false],
  ] as [number, number, boolean][]) {
    const tick = kit.addPart(
      S,
      new THREE.BoxGeometry(vert ? 0.0022 : 0.02, vert ? 0.02 : 0.0022, 0.001),
      etchMat,
      tx,
      ty,
      -0.44,
    );
    tick.renderOrder = 2;
  }

  // Depth-gauge dial (brass bezel, dark face, needle + ticks) on left console
  const dial = new THREE.Group();
  dial.position.set(-0.3, -0.19, -0.44);
  dial.rotation.x = -0.32;
  S.add(dial);
  kit.addPart(dial, new THREE.TorusGeometry(0.052, 0.008, 8, 24), M.brassMat, 0, 0, 0);
  kit.addPart(dial, new THREE.CircleGeometry(0.05, 24), M.cockpitTrim, 0, 0, -0.003);
  kit.addPart(dial, new THREE.BoxGeometry(0.0035, 0.042, 0.003), M.amberGlow, 0.008, 0.004, 0.002, 0, 0, -0.4);
  for (let i = 0; i < 5; i++) {
    const a = -2.3 + i * 1.15;
    kit.addPart(dial, new THREE.BoxGeometry(0.003, 0.009, 0.002), M.lightAlloy, Math.sin(a) * 0.043, Math.cos(a) * 0.043, 0.001, 0, 0, -a);
  }
  // Dive-plane attitude indicator beside it
  kit.addPart(S, new RoundedBoxGeometry(0.11, 0.02, 0.012, 1, 0.003), M.darkMetal, -0.15, -0.19, -0.44, -0.32, 0, 0);
  glowPulses.push(kit.addPart(S, new THREE.BoxGeometry(0.014, 0.008, 0.006), M.greenGlow, -0.15, -0.187, -0.432, -0.32, 0, 0));

  // Torpedo-tube ready lights x2 on right console
  kit.addPart(S, new RoundedBoxGeometry(0.15, 0.05, 0.016, 1, 0.004), M.darkMetal, 0.28, -0.19, -0.44, -0.32, -0.08, 0);
  glowPulses.push(
    kit.addPart(S, new THREE.CylinderGeometry(0.013, 0.013, 0.008, 10), M.greenGlow, 0.24, -0.19, -0.43, RX, 0, 0),
    kit.addPart(S, new THREE.CylinderGeometry(0.013, 0.013, 0.008, 10), M.redGlow, 0.32, -0.19, -0.43, RX, 0, 0),
  );

  // Sonar ping arcs on bottom console
  for (let i = 0; i < 3; i++) {
    glowPulses.push(
      kit.addPart(S, new THREE.TorusGeometry(0.028 + i * 0.017, 0.0018, 6, 20, Math.PI), M.cyanGlow, 0.16, -0.27, -0.42, -0.3, 0, 0),
    );
  }
  // Lower console desk + torpedo launch flash
  kit.addPart(S, new RoundedBoxGeometry(0.86, 0.09, 0.22, 2, 0.014), M.cockpitTrim, 0, -0.33, -0.49, -0.2, 0, 0);
  kit.addMuzzleFlash(R, 0, -0.3, -0.85, 1.5, 0x52f2ff);
}

// Poseidon Dreadnought: battleship fire-control — triple-gun turret silhouettes
// at edges, rangefinder wings, brass range clocks, heavy riveted trim.
function buildDreadnoughtVm(kit: VmKit): void {
  const { swayGroup: S, recoilGroup: R, mats: M, glowPulses } = kit;

  // Heavy riveted bridge brow + sloped armor cheeks + brass cheek trim
  kit.addPart(S, new RoundedBoxGeometry(1.16, 0.07, 0.15, 2, 0.012), M.cockpitTrim, 0, 0.325, -0.45, 0.13, 0, 0);
  for (const sx of [-1, 1]) {
    kit.addPart(S, new RoundedBoxGeometry(0.085, 0.62, 0.13, 2, 0.012), M.cockpitTrim, sx * 0.54, 0, -0.45, -0.12, -sx * 0.2, sx * 0.13);
    kit.addPart(S, new RoundedBoxGeometry(0.02, 0.4, 0.03, 1, 0.004), M.brassMat, sx * 0.49, 0, -0.42, -0.12, -sx * 0.2, sx * 0.13);
  }

  // Triple-gun turret silhouettes at lower left/right edges + barrels
  for (const sx of [-1, 1]) {
    const turret = new THREE.Group();
    turret.position.set(sx * 0.37, -0.32, -0.56);
    turret.rotation.y = -sx * 0.22;
    R.add(turret);
    kit.addPart(turret, new RoundedBoxGeometry(0.22, 0.14, 0.3, 2, 0.02), M.gunMetal, 0, 0, 0, 0.06, 0, 0);
    kit.addPart(turret, new RoundedBoxGeometry(0.19, 0.03, 0.2, 1, 0.006), M.factionMat, 0, 0.075, -0.02, 0.06, 0, 0);
    kit.addPart(turret, new RoundedBoxGeometry(0.16, 0.1, 0.03, 1, 0.006), M.darkMetal, 0, 0.01, -0.16, -0.2, 0, 0);
    for (const bx of [-0.048, 0, 0.048]) {
      kit.addPart(turret, new THREE.CylinderGeometry(0.013, 0.016, 0.4, 10), M.gunMetal, bx, 0.03, -0.35, RX, 0, 0);
      kit.addPart(turret, new THREE.CylinderGeometry(0.019, 0.019, 0.05, 10), M.darkMetal, bx, 0.03, -0.19, RX, 0, 0);
    }
    kit.addMuzzleFlash(turret, 0, 0.03, -0.58, 2.1, 0xff9a2e);
  }

  // Optical rangefinder wings at mid-height edges (end-cap optics)
  for (const sx of [-1, 1]) {
    kit.addPart(S, new RoundedBoxGeometry(0.28, 0.04, 0.06, 1, 0.008), M.darkMetal, sx * 0.4, 0.13, -0.45, 0, sx * 0.12, 0);
    kit.addPart(S, new RoundedBoxGeometry(0.05, 0.055, 0.07, 1, 0.008), M.lightAlloy, sx * 0.53, 0.13, -0.435, 0, sx * 0.12, 0);
    kit.addPart(S, new THREE.BoxGeometry(0.02, 0.026, 0.008), M.glassTint, sx * 0.5, 0.13, -0.4, 0, sx * 0.12, 0);
  }

  // Fire-control console + brass range-clock dials
  kit.addPart(S, new RoundedBoxGeometry(0.9, 0.11, 0.24, 2, 0.014), M.cockpitTrim, 0, -0.335, -0.5, -0.24, 0, 0);
  kit.addPart(S, new RoundedBoxGeometry(0.7, 0.018, 0.03, 1, 0.004), M.brassMat, 0, -0.285, -0.425, -0.24, 0, 0);
  for (let i = 0; i < 7; i++) {
    kit.addPart(S, new THREE.SphereGeometry(0.007, 6, 6), M.lightAlloy, -0.24 + i * 0.08, -0.271, -0.415, -0.24, 0, 0);
  }
  for (const sx of [-1, 1]) {
    const clock = new THREE.Group();
    clock.position.set(sx * 0.17, -0.265, -0.43);
    clock.rotation.x = -0.5;
    S.add(clock);
    kit.addPart(clock, new THREE.TorusGeometry(0.045, 0.007, 8, 22), M.brassMat, 0, 0, 0);
    kit.addPart(clock, new THREE.CircleGeometry(0.043, 22), M.darkMetal, 0, 0, -0.003);
    kit.addPart(clock, new THREE.BoxGeometry(0.0035, 0.036, 0.003), M.redGlow, 0, 0.009, 0.002, 0, 0, sx * 0.55);
    glowPulses.push(kit.addPart(clock, new THREE.BoxGeometry(0.01, 0.01, 0.004), M.amberGlow, 0, -0.03, 0.001));
    // Brass voice pipe curling up at each console edge
    kit.addPart(S, new THREE.CylinderGeometry(0.008, 0.01, 0.12, 8), M.brassMat, sx * 0.43, -0.24, -0.44, 0.5, 0, sx * 0.2);
  }
  glowPulses.push(
    kit.addPart(S, new THREE.BoxGeometry(0.04, 0.012, 0.008), M.redGlow, -0.05, -0.272, -0.42, -0.24, 0, 0),
    kit.addPart(S, new THREE.BoxGeometry(0.04, 0.012, 0.008), M.greenGlow, 0.05, -0.272, -0.42, -0.24, 0, 0),
  );
}

// Nimitz Carrier: island bridge — panoramic windows, flight-deck edge below,
// air-ops MFD drone grid, antenna masts at top corners, helm radar sweep.
function buildCarrierVm(kit: VmKit): void {
  const { swayGroup: S, recoilGroup: R, mats: M, glowPulses, spinners } = kit;

  // Panoramic window: brow, stanchions, three slim mullions, console sill
  kit.addPart(S, new RoundedBoxGeometry(1.2, 0.068, 0.15, 2, 0.012), M.cockpitTrim, 0, 0.358, -0.46, 0.13, 0, 0);
  for (const sx of [-1, 1]) {
    kit.addPart(S, new RoundedBoxGeometry(0.056, 0.64, 0.09, 2, 0.008), M.cockpitTrim, sx * 0.55, 0.02, -0.46, -0.1, -sx * 0.19, sx * 0.09);
    // Antenna mast hints at top corners
    kit.addPart(S, new THREE.CylinderGeometry(0.0035, 0.005, 0.16, 6), M.darkMetal, sx * 0.5, 0.37, -0.44, 0, 0, sx * 0.14);
    kit.addPart(S, new THREE.SphereGeometry(0.007, 6, 6), M.redGlow, sx * 0.51, 0.455, -0.44);
    kit.addPart(S, new THREE.BoxGeometry(0.055, 0.005, 0.005), M.darkMetal, sx * 0.5, 0.41, -0.44, 0, 0, sx * 0.14);
  }
  for (const mx of [-0.28, 0, 0.28]) {
    kit.addPart(S, new RoundedBoxGeometry(0.019, 0.58, 0.04, 1, 0.004), M.gunMetal, mx, 0.04, -0.46, -0.1, 0, mx * -0.1);
  }
  kit.addPart(S, new RoundedBoxGeometry(1.16, 0.11, 0.26, 2, 0.016), M.cockpitTrim, 0, -0.335, -0.49, -0.23, 0, 0);
  kit.addPart(S, new RoundedBoxGeometry(0.22, 0.022, 0.04, 1, 0.004), M.factionMat, -0.4, -0.28, -0.425, -0.23, 0, 0);
  kit.addPart(S, new RoundedBoxGeometry(0.22, 0.022, 0.04, 1, 0.004), M.factionMat, 0.4, -0.28, -0.425, -0.23, 0, 0);

  // Flight-deck edge visible at bottom + runway edge lights
  kit.addPart(S, new RoundedBoxGeometry(0.68, 0.018, 0.52, 2, 0.004), M.gunMetal, 0, -0.41, -0.95, 0.03, 0, 0);
  kit.addPart(S, new THREE.BoxGeometry(0.5, 0.005, 0.02), M.darkMetal, 0, -0.398, -0.78, 0.03, 0, 0);
  for (let i = 0; i < 3; i++) {
    glowPulses.push(
      kit.addPart(S, new THREE.BoxGeometry(0.014, 0.006, 0.014), M.redGlow, -0.3, -0.398, -0.76 - i * 0.14, 0.03, 0, 0),
      kit.addPart(S, new THREE.BoxGeometry(0.014, 0.006, 0.014), M.greenGlow, 0.3, -0.398, -0.76 - i * 0.14, 0.03, 0, 0),
    );
  }
  glowPulses.push(
    kit.addPart(S, new THREE.BoxGeometry(0.012, 0.006, 0.02), M.amberGlow, 0, -0.398, -0.82, 0.03, 0, 0),
    kit.addPart(S, new THREE.BoxGeometry(0.012, 0.006, 0.02), M.amberGlow, 0, -0.398, -1.02, 0.03, 0, 0),
  );

  // Air-ops MFD: screen + 2x4 drone-status cell grid on right console
  kit.addPart(S, new RoundedBoxGeometry(0.24, 0.095, 0.02, 1, 0.004), M.darkMetal, 0.29, -0.265, -0.43, -0.28, -0.1, 0);
  kit.addPart(S, new THREE.BoxGeometry(0.215, 0.075, 0.008), M.glassTint, 0.29, -0.265, -0.419, -0.28, -0.1, 0);
  for (let i = 0; i < 8; i++) {
    const cx = 0.215 + (i % 4) * 0.05;
    const cy = -0.24 - Math.floor(i / 4) * 0.03;
    glowPulses.push(
      kit.addPart(S, new THREE.BoxGeometry(0.036, 0.018, 0.005), i % 3 === 2 ? M.amberGlow : M.greenGlow, cx, cy, -0.414, -0.28, -0.1, 0),
    );
  }

  // Helm radar puck + sweep on left console
  kit.addPart(S, new THREE.CylinderGeometry(0.06, 0.066, 0.02, 18), M.darkMetal, -0.3, -0.272, -0.42, -0.28, 0, 0);
  kit.addPart(S, new THREE.CylinderGeometry(0.052, 0.052, 0.006, 18), M.glassTint, -0.3, -0.263, -0.417, -0.28, 0, 0);
  const sweep = new THREE.Group();
  sweep.position.set(-0.3, -0.259, -0.414);
  sweep.rotation.x = -0.28;
  S.add(sweep);
  kit.addPart(sweep, new THREE.BoxGeometry(0.006, 0.004, 0.05), M.cyanGlow, 0, 0, -0.025);
  spinners.push({ obj: sweep, axis: "y", speed: -2.4 });

  // Drone catapult launch flash at deck edge
  kit.addMuzzleFlash(R, 0, -0.38, -1.3, 1.7, 0x62f2ff);
}

export const SEA_VM: Partial<Record<UnitKind, (kit: VmKit) => void>> = {
  usv: buildUsvVm,
  gunboat: buildGunboatVm,
  destroyer: buildDestroyerVm,
  sub: buildSubVm,
  dreadnought: buildDreadnoughtVm,
  carrier: buildCarrierVm,
};
