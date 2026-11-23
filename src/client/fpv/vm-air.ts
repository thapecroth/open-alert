// Air-domain 1P viewmodels (jets, drones, helicopters, gunships, airship).
// Each entry fully replaces the legacy fpv.ts cockpit branch for that kind.
//
// Camera space: forward is -Z. Cockpit frames live at z ≈ -0.40..-0.48, dashes
// at y ≈ -0.26..-0.36, screen edges at x ≈ ±0.5, top edge y ≈ 0.33..0.37.
// Gun/munition hardware hangs off recoilGroup and may extend to z ≈ -1.4.
// Center screen stays clear for the reticle on every build.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { UnitKind } from "../../shared/gamedefs";
import { getChassisMat, getGlowMat } from "../textures";
import type { VmKit } from "./vmkit";

// ---------- Shared sculpting helpers ----------

/** Four inward-facing L-brackets framing the reticle zone (center stays clear). */
function trackBrackets(kit: VmKit, mat: THREE.Material, radiusX = 0.15, radiusY = 0.115, z = -0.415, arm = 0.032, thick = 0.0055): void {
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      kit.addPart(kit.swayGroup, new THREE.BoxGeometry(arm, thick, 0.004), mat, sx * (radiusX - arm / 2), sy * radiusY, z);
      kit.addPart(kit.swayGroup, new THREE.BoxGeometry(thick, arm, 0.004), mat, sx * radiusX, sy * (radiusY - arm / 2), z);
    }
  }
}

// ---------- FPV Suicide Drone: full FPV-goggles fantasy ----------
function buildFpvDrone(kit: VmKit): void {
  const { swayGroup, recoilGroup, mats, addPart, addMuzzleFlash, spinners, glowPulses, trackMat } = kit;
  const { darkMetal, lightAlloy, factionMat, cyanGlow, amberGlow, redGlow, greenGlow } = mats;
  const carbonMat = getChassisMat("#161b22", 0.36, 0.54);
  const rubberMat = getChassisMat("#0c1015", 0.85, 0.08); // soft goggle face gasket
  const oliveWarhead = getChassisMat("#495738", 0.56, 0.28);
  const copperMat = getChassisMat("#c97a38", 0.32, 0.8);

  // Rounded goggle gasket hugging all four screen edges + carbon inner bezel
  addPart(swayGroup, new RoundedBoxGeometry(1.18, 0.09, 0.11, 2, 0.026), rubberMat, 0, 0.365, -0.4, 0.16, 0, 0);
  addPart(swayGroup, new RoundedBoxGeometry(1.2, 0.1, 0.12, 2, 0.026), rubberMat, 0, -0.37, -0.4, -0.24, 0, 0);
  addPart(swayGroup, new RoundedBoxGeometry(0.09, 0.6, 0.1, 2, 0.026), rubberMat, -0.57, -0.005, -0.4, 0, 0.2, 0);
  addPart(swayGroup, new RoundedBoxGeometry(0.09, 0.6, 0.1, 2, 0.026), rubberMat, 0.57, -0.005, -0.4, 0, -0.2, 0);
  addPart(swayGroup, new RoundedBoxGeometry(1.04, 0.034, 0.05, 2, 0.01), carbonMat, 0, 0.332, -0.41, 0.16, 0, 0);
  addPart(swayGroup, new RoundedBoxGeometry(1.06, 0.04, 0.05, 2, 0.01), carbonMat, 0, -0.334, -0.41, -0.22, 0, 0);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      // Rounded carbon L-elbows reinforcing each goggle corner
      addPart(swayGroup, new RoundedBoxGeometry(0.15, 0.024, 0.04, 1, 0.006), carbonMat, sx * 0.47, sy * 0.33, -0.41);
      addPart(swayGroup, new RoundedBoxGeometry(0.024, 0.13, 0.04, 1, 0.006), carbonMat, sx * 0.53, sy * 0.278, -0.41);
    }
    // Head-strap buckle posts on outer gasket edges with faction tape strips
    addPart(swayGroup, new THREE.CylinderGeometry(0.009, 0.009, 0.2, 8), lightAlloy, sx * 0.555, -0.02, -0.42);
    addPart(swayGroup, new THREE.BoxGeometry(0.016, 0.07, 0.016), factionMat, sx * 0.55, -0.05, -0.415);
  }

  // Spinning front prop tips poking into the top corners (tiny motor + blade pair + blur disc)
  const propBlurMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0x1a222b, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false }),
  );
  const propRimMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0xff5a36, transparent: true, opacity: 0.34, side: THREE.DoubleSide, depthWrite: false }),
  );
  for (const sx of [-1, 1]) {
    // Diagonal carbon arm reaching out of frame into the upper corner
    addPart(swayGroup, new RoundedBoxGeometry(0.042, 0.016, 0.4, 2, 0.005), carbonMat, sx * 0.37, 0.26, -0.52, -0.2, -sx * 0.5, sx * 0.07);
    addPart(swayGroup, new THREE.CylinderGeometry(0.032, 0.034, 0.03, 14), darkMetal, sx * 0.46, 0.305, -0.63, 0.22, 0, sx * 0.12);
    addPart(swayGroup, new THREE.CylinderGeometry(0.028, 0.028, 0.01, 14), copperMat, sx * 0.46, 0.307, -0.63, 0.22, 0, sx * 0.12);
    const propHub = new THREE.Group();
    propHub.position.set(sx * 0.46, 0.326, -0.63);
    propHub.rotation.set(0.22, 0, sx * 0.12);
    swayGroup.add(propHub);
    addPart(propHub, new THREE.CylinderGeometry(0.012, 0.014, 0.014, 10), lightAlloy, 0, 0, 0);
    addPart(propHub, new THREE.BoxGeometry(0.024, 0.004, 0.24), carbonMat, 0, 0, 0);
    addPart(propHub, new THREE.BoxGeometry(0.024, 0.004, 0.24), carbonMat, 0, 0, 0, 0, Math.PI / 2, 0);
    const disc = addPart(propHub, new THREE.CircleGeometry(0.21, 24), propBlurMat, 0, -0.003, 0, -Math.PI / 2, 0, 0);
    disc.renderOrder = 2;
    const rim = addPart(propHub, new THREE.RingGeometry(0.19, 0.214, 24), propRimMat, 0, -0.002, 0, -Math.PI / 2, 0, 0);
    rim.renderOrder = 2;
    spinners.push({ obj: propHub, axis: "y", speed: sx < 0 ? 46 : -46 });
  }

  // Underslung strapped RPG shaped-charge warhead along the lower edge
  const warhead = new THREE.Group();
  warhead.position.set(0, -0.315, -0.62);
  warhead.rotation.set(0.08, 0, 0);
  recoilGroup.add(warhead);
  addPart(warhead, new THREE.CylinderGeometry(0.062, 0.068, 0.2, 16), oliveWarhead, 0, 0, 0.05, Math.PI / 2, 0, 0);
  addPart(warhead, new THREE.ConeGeometry(0.062, 0.22, 16), oliveWarhead, 0, 0, -0.16, -Math.PI / 2, 0, 0);
  addPart(warhead, new THREE.CylinderGeometry(0.04, 0.052, 0.042, 14), lightAlloy, 0, 0, -0.12, Math.PI / 2, 0, 0);
  addPart(warhead, new THREE.CylinderGeometry(0.014, 0.02, 0.1, 10), darkMetal, 0, 0, -0.29, Math.PI / 2, 0, 0);
  // Twin copper contact-detonator trigger wires jutting past the nose tip
  addPart(warhead, new THREE.CylinderGeometry(0.004, 0.004, 0.1, 6), copperMat, -0.02, 0.004, -0.34, Math.PI / 2, 0.18, 0);
  addPart(warhead, new THREE.CylinderGeometry(0.004, 0.004, 0.1, 6), copperMat, 0.02, 0.004, -0.34, Math.PI / 2, -0.18, 0);
  // Strap cinch + faction zip-tie band + blinking arming LED
  addPart(warhead, new RoundedBoxGeometry(0.14, 0.024, 0.03, 1, 0.004), darkMetal, 0, 0.06, 0.04);
  addPart(warhead, new THREE.BoxGeometry(0.145, 0.013, 0.016), factionMat, 0, 0.067, 0.04);
  glowPulses.push(addPart(warhead, new THREE.SphereGeometry(0.014, 10, 8), redGlow, 0, 0.054, -0.08));
  addMuzzleFlash(warhead, 0, 0, -0.4, 2.2, 0xff5a28);

  // Goggles OSD: signal-strength bars upper-left, battery pack + ARMED upper-right
  for (let i = 0; i < 4; i++) {
    const h = 0.008 + i * 0.0065;
    const bar = addPart(swayGroup, new THREE.BoxGeometry(0.011, h, 0.006), i < 3 ? greenGlow : cyanGlow, -0.46 + i * 0.018, 0.3 + h * 0.5, -0.395);
    if (i === 3) glowPulses.push(bar); // top bar flickers with link quality
  }
  addPart(swayGroup, new THREE.BoxGeometry(0.052, 0.02, 0.008), darkMetal, 0.4, 0.312, -0.395);
  glowPulses.push(
    addPart(swayGroup, new THREE.BoxGeometry(0.036, 0.012, 0.006), greenGlow, 0.394, 0.312, -0.392),
    addPart(swayGroup, new THREE.BoxGeometry(0.008, 0.006, 0.006), amberGlow, 0.432, 0.312, -0.392),
    addPart(swayGroup, new THREE.BoxGeometry(0.06, 0.01, 0.008), redGlow, 0.3, 0.312, -0.395), // ARMED
  );

  // Interlaced scanline lens + faint vignette tint — the whole screen is the feed
  const scanCv = document.createElement("canvas");
  scanCv.width = 4;
  scanCv.height = 4;
  const scanCtx = scanCv.getContext("2d")!;
  scanCtx.fillStyle = "rgba(140,225,255,0.5)";
  scanCtx.fillRect(0, 0, 4, 1);
  const scanTex = new THREE.CanvasTexture(scanCv);
  scanTex.wrapS = scanTex.wrapT = THREE.RepeatWrapping;
  scanTex.repeat.set(1, 80);
  const scanMat = trackMat(
    new THREE.MeshBasicMaterial({ map: scanTex, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  const scanPane = addPart(swayGroup, new THREE.PlaneGeometry(1.12, 0.7), scanMat, 0, -0.01, -0.39);
  scanPane.renderOrder = 4;
  const vigMat = trackMat(new THREE.MeshBasicMaterial({ color: 0x06121a, transparent: true, opacity: 0.15, depthWrite: false }));
  const vigPane = addPart(swayGroup, new THREE.PlaneGeometry(1.14, 0.74), vigMat, 0, -0.01, -0.395);
  vigPane.renderOrder = 3;
}

// ---------- Reaper UAV: satcom ground-station control feed ----------
function buildUav(kit: VmKit): void {
  const { swayGroup, recoilGroup, mats, addPart, addMuzzleFlash, spinners, glowPulses, trackMat } = kit;
  const { darkMetal, gunMetal, lightAlloy, cockpitTrim, factionMat, glassTint, cyanGlow, amberGlow, redGlow, greenGlow } = mats;
  kit.addAircraftCanopy(true, false);
  const satWhite = getChassisMat("#dfe7ee", 0.4, 0.2);

  // Big gyro-stabilized sensor ball peeking below the nose lip, center-bottom
  const turret = new THREE.Group();
  turret.position.set(0, -0.355, -0.68);
  turret.rotation.set(0.1, 0, 0);
  swayGroup.add(turret);
  addPart(turret, new THREE.SphereGeometry(0.06, 18, 14), darkMetal, 0, 0, 0);
  addPart(turret, new THREE.SphereGeometry(0.042, 16, 12), glassTint, 0, -0.014, -0.034); // FLIR window
  addPart(turret, new THREE.CylinderGeometry(0.018, 0.024, 0.05, 10), gunMetal, 0, 0.05, 0.012); // yoke mount
  glowPulses.push(addPart(turret, new THREE.SphereGeometry(0.014, 10, 8), cyanGlow, 0, -0.024, -0.056)); // laser iris
  // Nose spine sloping down over the ball + pitot probe
  addPart(swayGroup, new RoundedBoxGeometry(0.16, 0.03, 0.34, 2, 0.006), cockpitTrim, 0, -0.315, -0.78, 0.1, 0, 0);
  addPart(swayGroup, new THREE.CylinderGeometry(0.005, 0.007, 0.2, 8), lightAlloy, 0.14, -0.3, -0.85, Math.PI / 2, 0.1, 0);

  // Radar MFD on the left dash: scope bezel + dark face + spinning sector sweep
  const scope = new THREE.Group();
  scope.position.set(-0.27, -0.264, -0.404);
  scope.rotation.set(-0.34, 0.12, 0);
  swayGroup.add(scope);
  addPart(scope, new THREE.TorusGeometry(0.021, 0.0035, 6, 20), lightAlloy, 0, 0, 0);
  addPart(scope, new THREE.CircleGeometry(0.019, 20), glassTint, 0, 0, 0.001);
  const sweepMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0x38f2ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }),
  );
  const wedge = addPart(scope, new THREE.CircleGeometry(0.0175, 10, 0, Math.PI * 0.32), sweepMat, 0, 0, 0.003);
  wedge.renderOrder = 3;
  spinners.push({ obj: wedge, axis: "z", speed: -2.2 });
  // Range ring pips on the scope face
  glowPulses.push(addPart(scope, new THREE.CircleGeometry(0.004, 8), cyanGlow, 0, 0, 0.002));

  // Satcom antenna trims: fold-out dish upper-left + twin whip aerials upper-right
  addPart(swayGroup, new THREE.CylinderGeometry(0.006, 0.008, 0.09, 8), lightAlloy, -0.4, 0.31, -0.44, 0.5, 0, -0.3);
  addPart(swayGroup, new THREE.ConeGeometry(0.028, 0.03, 12, 1, true), satWhite, -0.412, 0.345, -0.45, -0.95, 0, 0.3);
  glowPulses.push(addPart(swayGroup, new THREE.SphereGeometry(0.007, 8, 6), cyanGlow, -0.416, 0.352, -0.462));
  for (const wx of [0.4, 0.44]) {
    addPart(swayGroup, new THREE.CylinderGeometry(0.0035, 0.005, 0.13, 6), darkMetal, wx, 0.34, -0.44, 0.24, 0, 0.12);
    glowPulses.push(addPart(swayGroup, new THREE.SphereGeometry(0.006, 8, 6), redGlow, wx + 0.014, 0.402, -0.452));
  }

  // Satcom uplink status ladder on the right dash + downlink bars
  glowPulses.push(
    addPart(swayGroup, new THREE.BoxGeometry(0.05, 0.008, 0.008), greenGlow, 0.27, -0.26, -0.408, -0.32, -0.12, 0),
    addPart(swayGroup, new THREE.BoxGeometry(0.038, 0.008, 0.008), cyanGlow, 0.27, -0.273, -0.406, -0.32, -0.12, 0),
    addPart(swayGroup, new THREE.BoxGeometry(0.026, 0.008, 0.008), amberGlow, 0.27, -0.286, -0.404, -0.32, -0.12, 0),
  );

  // Under-wing micro-missile pylons peeking at the lower corners
  for (const sx of [-1, 1]) {
    addPart(recoilGroup, new THREE.CylinderGeometry(0.015, 0.017, 0.3, 10), gunMetal, sx * 0.32, -0.27, -0.72, Math.PI / 2, 0, 0);
    addPart(recoilGroup, new THREE.ConeGeometry(0.016, 0.05, 8), amberGlow, sx * 0.32, -0.27, -0.9, -Math.PI / 2, 0, 0);
    addPart(recoilGroup, new THREE.BoxGeometry(0.004, 0.05, 0.08), factionMat, sx * 0.32, -0.243, -0.68);
    addMuzzleFlash(recoilGroup, sx * 0.32, -0.27, -0.96, 1.2, 0x62f2ff);
  }
}

// ---------- Shahed loitering munition: seeker-head kamikaze feed ----------
function buildShahed(kit: VmKit): void {
  const { swayGroup, recoilGroup, mats, addPart, addMuzzleFlash, spinners, glowPulses, trackMat } = kit;
  const { darkMetal, lightAlloy, factionMat, glassTint, cyanGlow, amberGlow, redGlow } = mats;
  const matteWhite = getChassisMat("#c6cfd8", 0.56, 0.22);
  const matteSlate = getChassisMat("#7e8c9a", 0.52, 0.28);
  const crimsonPaint = getChassisMat("#cf2e24", 0.42, 0.36);

  // Minimal optical frame: thin top rail + corner brackets, nothing else blocks the dive
  addPart(swayGroup, new RoundedBoxGeometry(0.9, 0.02, 0.04, 1, 0.005), matteSlate, 0, 0.33, -0.44, 0.12, 0, 0);
  for (const sx of [-1, 1]) {
    addPart(swayGroup, new RoundedBoxGeometry(0.15, 0.02, 0.035, 1, 0.004), matteSlate, sx * 0.44, 0.32, -0.45);
    addPart(swayGroup, new RoundedBoxGeometry(0.02, 0.13, 0.035, 1, 0.004), matteSlate, sx * 0.5, 0.265, -0.45);
    // Swept matte-white cropped delta wing shoulders peeking low-left & low-right
    addPart(swayGroup, new RoundedBoxGeometry(0.28, 0.03, 0.44, 2, 0.008), matteWhite, sx * 0.4, -0.32, -0.74, 0.04, -sx * 0.48, sx * 0.06);
    addPart(swayGroup, new THREE.BoxGeometry(0.12, 0.034, 0.055), crimsonPaint, sx * 0.33, -0.315, -0.67, 0.04, -sx * 0.48, sx * 0.06);
    addPart(swayGroup, new THREE.BoxGeometry(0.08, 0.034, 0.065), factionMat, sx * 0.45, -0.315, -0.8, 0.04, -sx * 0.48, sx * 0.06);
  }

  // Exposed nose seeker ball riding at the chin — glass dome + burning amber iris
  const seeker = new THREE.Group();
  seeker.position.set(0, -0.3, -0.56);
  swayGroup.add(seeker);
  addPart(seeker, new THREE.SphereGeometry(0.052, 18, 14), glassTint, 0, 0, 0);
  addPart(seeker, new THREE.TorusGeometry(0.055, 0.006, 8, 22), matteSlate, 0, 0, -0.004);
  addPart(seeker, new THREE.SphereGeometry(0.011, 8, 8), darkMetal, 0, 0, -0.05); // pupil
  glowPulses.push(addPart(seeker, new THREE.SphereGeometry(0.022, 12, 10), amberGlow, 0, 0, -0.042));

  // Pusher prop tips whirling behind the top edge (rear motor seen over the nose)
  const propBlur = trackMat(
    new THREE.MeshBasicMaterial({ color: 0x141a20, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }),
  );
  addPart(swayGroup, new THREE.CylinderGeometry(0.028, 0.033, 0.05, 12), matteSlate, 0, 0.352, -0.54, Math.PI / 2 + 0.15, 0, 0);
  const prop = new THREE.Group();
  prop.position.set(0, 0.372, -0.565);
  prop.rotation.set(0.15, 0, 0);
  swayGroup.add(prop);
  addPart(prop, new THREE.CylinderGeometry(0.011, 0.013, 0.03, 10), darkMetal, 0, 0, 0, Math.PI / 2, 0, 0);
  addPart(prop, new THREE.BoxGeometry(0.27, 0.016, 0.004), darkMetal, 0, 0, 0);
  addPart(prop, new THREE.BoxGeometry(0.016, 0.27, 0.004), darkMetal, 0, 0, 0);
  const pDisc = addPart(prop, new THREE.CircleGeometry(0.145, 22), propBlur, 0, 0, 0.003);
  pDisc.renderOrder = 2;
  spinners.push({ obj: prop, axis: "z", speed: 38 });

  // Lower nose-cam lip + crimson ARMED strip + target-track brackets
  addPart(swayGroup, new RoundedBoxGeometry(0.56, 0.05, 0.13, 2, 0.01), matteSlate, 0, -0.345, -0.48, -0.22, 0, 0);
  glowPulses.push(
    addPart(swayGroup, new THREE.BoxGeometry(0.14, 0.011, 0.008), redGlow, 0, -0.302, -0.415, -0.32, 0, 0),
    addPart(swayGroup, new THREE.SphereGeometry(0.011, 10, 8), redGlow, -0.09, -0.302, -0.415),
    addPart(swayGroup, new THREE.SphereGeometry(0.011, 10, 8), redGlow, 0.09, -0.302, -0.415),
    addPart(swayGroup, new THREE.BoxGeometry(0.05, 0.007, 0.008), amberGlow, 0, 0.315, -0.43),
  );
  trackBrackets(kit, amberGlow, 0.14, 0.105, -0.415);
  addPart(swayGroup, new THREE.BoxGeometry(0.005, 0.005, 0.005), cyanGlow, 0, 0, -0.41); // seeker center dot

  // Sleek dark warhead nose tip + pitot probe + terminal flash
  addPart(recoilGroup, new THREE.ConeGeometry(0.05, 0.22, 12), darkMetal, 0, -0.34, -0.82, -Math.PI / 2, 0, 0);
  addPart(recoilGroup, new THREE.CylinderGeometry(0.006, 0.009, 0.24, 8), lightAlloy, 0.17, -0.29, -0.78, Math.PI / 2, 0, 0);
  addMuzzleFlash(recoilGroup, 0, -0.32, -0.94, 2.3, 0xff4c24);
}

// ---------- EW Jammer Drone: electronic-warfare spectrum pod ----------
function buildEwDrone(kit: VmKit): void {
  const { swayGroup, mats, addPart, spinners, glowPulses } = kit;
  const { darkMetal, factionMat, cyanGlow, amberGlow, redGlow, greenGlow } = mats;
  const ewTitanium = getChassisMat("#222b36", 0.34, 0.76);
  const purpleGlow = getGlowMat("#b45cff", 1.75);

  // Hex-beveled dark-titanium optical pod frame (6-segment bezel)
  addPart(swayGroup, new RoundedBoxGeometry(0.78, 0.028, 0.05, 2, 0.006), ewTitanium, 0, 0.335, -0.45, 0.14, 0, 0);
  addPart(swayGroup, new RoundedBoxGeometry(0.86, 0.05, 0.08, 2, 0.008), ewTitanium, 0, -0.335, -0.46, -0.24, 0, 0);
  for (const sx of [-1, 1]) {
    // Paired angled struts form the hex corners upper & lower
    addPart(swayGroup, new RoundedBoxGeometry(0.03, 0.3, 0.045, 1, 0.005), ewTitanium, sx * 0.48, 0.16, -0.45, 0, -sx * 0.18, sx * 0.28);
    addPart(swayGroup, new RoundedBoxGeometry(0.03, 0.3, 0.045, 1, 0.005), ewTitanium, sx * 0.48, -0.15, -0.45, 0, -sx * 0.18, -sx * 0.28);
    // Hex vertex nodes + faction ID strip
    addPart(swayGroup, new THREE.SphereGeometry(0.02, 8, 8), darkMetal, sx * 0.49, 0.005, -0.455);
    addPart(swayGroup, new THREE.BoxGeometry(0.012, 0.11, 0.015), factionMat, sx * 0.465, 0.01, -0.435);
    // Side jam antenna spars jutting outward with alternating emitter tips
    addPart(swayGroup, new THREE.CylinderGeometry(0.008, 0.011, 0.16, 8), ewTitanium, sx * 0.56, 0.19, -0.47, 0, 0, sx * 0.5);
    addPart(swayGroup, new THREE.CylinderGeometry(0.008, 0.011, 0.16, 8), ewTitanium, sx * 0.56, -0.18, -0.47, 0, 0, -sx * 0.5);
    glowPulses.push(
      addPart(swayGroup, new THREE.SphereGeometry(0.016, 10, 8), sx < 0 ? purpleGlow : cyanGlow, sx * 0.6, 0.23, -0.485),
      addPart(swayGroup, new THREE.SphereGeometry(0.016, 10, 8), sx < 0 ? cyanGlow : purpleGlow, sx * 0.6, -0.22, -0.485),
      // Forward dipole emitter prongs + hot tips
      addPart(swayGroup, new THREE.SphereGeometry(0.017, 10, 8), sx < 0 ? purpleGlow : cyanGlow, sx * 0.34, -0.27, -0.9),
    );
    addPart(swayGroup, new THREE.CylinderGeometry(0.009, 0.013, 0.34, 8), ewTitanium, sx * 0.33, -0.27, -0.74, Math.PI / 2, -sx * 0.08, 0);
    // Purple/cyan side emitter strips on the bezel
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.008, 0.065, 0.01), purpleGlow, sx * 0.45, 0.14, -0.43, 0, 0, sx * 0.28),
      addPart(swayGroup, new THREE.BoxGeometry(0.008, 0.065, 0.01), cyanGlow, sx * 0.45, -0.13, -0.43, 0, 0, -sx * 0.28),
    );
  }

  // RF-spectrum waterfall: two staggered rows of purple/cyan analyzer bars
  const specHeights = [0.016, 0.028, 0.02, 0.034, 0.022, 0.032, 0.018];
  for (let i = 0; i < specHeights.length; i++) {
    const bx = -0.24 + i * 0.024;
    const h = specHeights[i];
    const h2 = specHeights[specHeights.length - 1 - i] * 0.7;
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.013, h, 0.007), i % 2 === 0 ? purpleGlow : cyanGlow, bx, -0.295 + h * 0.25, -0.415, -0.24, 0, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.013, h2, 0.007), i % 2 === 0 ? cyanGlow : purpleGlow, bx, -0.318 + h2 * 0.25, -0.412, -0.24, 0, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.013, h, 0.007), i % 2 === 0 ? purpleGlow : cyanGlow, -bx, -0.295 + h * 0.25, -0.415, -0.24, 0, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.013, h2, 0.007), i % 2 === 0 ? cyanGlow : purpleGlow, -bx, -0.318 + h2 * 0.25, -0.412, -0.24, 0, 0),
    );
  }

  // Pulsing concentric phased-array emitter rings + jam-power core, lower center
  const ewRingOuter = addPart(swayGroup, new THREE.TorusGeometry(0.048, 0.005, 8, 28), purpleGlow, 0, -0.295, -0.43);
  const ewRingInner = addPart(swayGroup, new THREE.TorusGeometry(0.03, 0.004, 8, 24), cyanGlow, 0, -0.295, -0.428);
  glowPulses.push(
    ewRingOuter,
    ewRingInner,
    addPart(swayGroup, new THREE.SphereGeometry(0.012, 10, 8), purpleGlow, 0, -0.295, -0.425),
    addPart(swayGroup, new THREE.BoxGeometry(0.09, 0.008, 0.008), greenGlow, -0.4, -0.3, -0.42),
    addPart(swayGroup, new THREE.BoxGeometry(0.09, 0.008, 0.008), redGlow, 0.4, -0.3, -0.42),
    addPart(swayGroup, new THREE.BoxGeometry(0.05, 0.007, 0.008), amberGlow, 0, 0.318, -0.435),
  );
  spinners.push({ obj: ewRingOuter, axis: "z", speed: 2.6 }, { obj: ewRingInner, axis: "z", speed: -4.2 });
  // Upper frequency-calibration arc sweeping across the bezel
  addPart(swayGroup, new THREE.TorusGeometry(0.39, 0.0038, 6, 32, Math.PI * 0.38), purpleGlow, 0, -0.02, -0.46, 0, 0, Math.PI * 0.31);
}

// ---------- Valkyrie Interceptor: razor fighter cockpit ----------
function buildInterceptor(kit: VmKit): void {
  const { swayGroup, recoilGroup, mats, addPart, addMuzzleFlash, glowPulses } = kit;
  const { darkMetal, gunMetal, lightAlloy, cockpitTrim, factionMat, amberGlow, redGlow, greenGlow } = mats;
  kit.addAircraftCanopy(false, false);

  // Wingtip missile rails peeking at both canopy edges, amber seeker noses hot
  for (const sx of [-1, 1]) {
    addPart(recoilGroup, new RoundedBoxGeometry(0.05, 0.045, 0.5, 1, 0.006), gunMetal, sx * 0.42, -0.24, -0.58, 0.02, -sx * 0.06, 0);
    addPart(recoilGroup, new THREE.CylinderGeometry(0.02, 0.022, 0.42, 10), lightAlloy, sx * 0.42, -0.2, -0.6, Math.PI / 2, 0, 0);
    addPart(recoilGroup, new THREE.ConeGeometry(0.02, 0.09, 10), amberGlow, sx * 0.42, -0.2, -0.85, -Math.PI / 2, 0, 0);
    addPart(recoilGroup, new THREE.BoxGeometry(0.003, 0.036, 0.07), factionMat, sx * 0.42, -0.165, -0.48);
    addPart(recoilGroup, new THREE.BoxGeometry(0.036, 0.003, 0.07), factionMat, sx * 0.42, -0.2, -0.48);
    addMuzzleFlash(recoilGroup, sx * 0.42, -0.2, -0.94, 1.5, 0x9fe8ff);
  }

  // Radar-warning-receiver scope on the right dash: bezel + amber threat quadrants
  const rwr = new THREE.Group();
  rwr.position.set(0.27, -0.266, -0.408);
  rwr.rotation.set(-0.34, -0.12, 0);
  swayGroup.add(rwr);
  addPart(rwr, new THREE.CylinderGeometry(0.024, 0.026, 0.012, 18), darkMetal, 0, 0, 0, Math.PI / 2, 0, 0);
  addPart(rwr, new THREE.CircleGeometry(0.021, 18), cockpitTrim, 0, 0, 0.007);
  for (let q = 0; q < 4; q++) {
    // Four amber quadrant arcs — the classic RWR threat ring
    glowPulses.push(
      addPart(rwr, new THREE.TorusGeometry(0.0145, 0.0022, 6, 10, Math.PI * 0.32), amberGlow, 0, 0, 0.008, 0, 0, q * Math.PI * 0.5 + Math.PI * 0.09),
    );
  }
  glowPulses.push(addPart(rwr, new THREE.SphereGeometry(0.004, 8, 6), redGlow, 0, 0, 0.009)); // own-ship dot

  // Gunsight pipper ring + center dot + side ticks, projected center-low
  addPart(swayGroup, new THREE.TorusGeometry(0.024, 0.0026, 6, 26), greenGlow, 0, -0.196, -0.424, 0.18, 0, 0);
  glowPulses.push(addPart(swayGroup, new THREE.SphereGeometry(0.005, 8, 8), greenGlow, 0, -0.196, -0.422));
  addPart(swayGroup, new THREE.BoxGeometry(0.02, 0.003, 0.002), greenGlow, -0.04, -0.196, -0.423, 0.18, 0, 0);
  addPart(swayGroup, new THREE.BoxGeometry(0.02, 0.003, 0.002), greenGlow, 0.04, -0.196, -0.423, 0.18, 0, 0);
  addPart(swayGroup, new THREE.BoxGeometry(0.003, 0.02, 0.002), greenGlow, 0, -0.158, -0.419, 0.18, 0, 0);

  // Swept nose strake + twin nose cannons with cyan cannon flashes
  addPart(swayGroup, new RoundedBoxGeometry(0.18, 0.036, 0.42, 2, 0.008), factionMat, 0, -0.325, -0.74, 0.08, 0, 0);
  for (const sx of [-1, 1]) {
    addPart(recoilGroup, new THREE.CylinderGeometry(0.015, 0.018, 0.34, 10), lightAlloy, sx * 0.22, -0.27, -0.78, Math.PI / 2, 0, 0);
    addMuzzleFlash(recoilGroup, sx * 0.22, -0.27, -0.98, 1.35, 0x62f2ff);
  }
}

// ---------- Hornet Chopper: gunship helo cockpit ----------
function buildChopper(kit: VmKit): void {
  const { swayGroup, recoilGroup, mats, addPart, addMuzzleFlash, spinners, glowPulses, trackMat } = kit;
  const { darkMetal, gunMetal, lightAlloy, cockpitTrim, factionMat, cyanGlow, amberGlow, redGlow } = mats;
  kit.addAircraftCanopy(true, false);

  // Overhead rotor mast + translucent blade disc swiping across the top edge
  addPart(swayGroup, new THREE.CylinderGeometry(0.02, 0.026, 0.07, 12), gunMetal, 0, 0.4, -0.52, 0.14, 0, 0);
  const rotorHub = new THREE.Group();
  rotorHub.position.set(0, 0.42, -0.52);
  rotorHub.rotation.x = 0.13;
  swayGroup.add(rotorHub);
  const bladeMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0x10161d, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false }),
  );
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2;
    const blade = addPart(rotorHub, new THREE.BoxGeometry(0.98, 0.006, 0.05), bladeMat, 0, 0, 0, 0, ang, 0);
    blade.renderOrder = 2;
  }
  addPart(rotorHub, new THREE.CylinderGeometry(0.03, 0.03, 0.02, 12), darkMetal, 0, 0, 0);
  spinners.push({ obj: rotorHub, axis: "y", speed: 18.5 });

  // Cyclic stick rising between the knees, rubber boot + grip + trim hat
  const cyclic = new THREE.Group();
  cyclic.position.set(0.06, -0.375, -0.52);
  cyclic.rotation.set(-0.12, 0, -0.05); // neutral static tilt
  swayGroup.add(cyclic);
  addPart(cyclic, new RoundedBoxGeometry(0.09, 0.05, 0.09, 2, 0.012), cockpitTrim, 0, 0, 0);
  addPart(cyclic, new THREE.CylinderGeometry(0.011, 0.014, 0.14, 10), darkMetal, 0, 0.08, 0);
  addPart(cyclic, new RoundedBoxGeometry(0.034, 0.06, 0.042, 2, 0.008), gunMetal, 0, 0.16, -0.005, 0.24, 0, 0);
  addPart(cyclic, new THREE.BoxGeometry(0.016, 0.012, 0.016), redGlow, 0, 0.19, -0.012, 0.24, 0, 0); // pickle hat

  // Collective pitch lever on the left edge + throttle ring
  addPart(swayGroup, new RoundedBoxGeometry(0.05, 0.04, 0.2, 1, 0.006), cockpitTrim, -0.44, -0.32, -0.5, -0.1, 0.1, 0);
  addPart(swayGroup, new THREE.CylinderGeometry(0.009, 0.011, 0.12, 8), darkMetal, -0.44, -0.29, -0.55, Math.PI / 2 - 0.35, 0.1, 0);
  addPart(swayGroup, new RoundedBoxGeometry(0.026, 0.05, 0.036, 1, 0.006), factionMat, -0.435, -0.265, -0.6, 0.3, 0.1, 0);

  // Chin gatling gun + ammo drum, peeking low ahead
  addPart(recoilGroup, new THREE.CylinderGeometry(0.024, 0.026, 0.44, 10), gunMetal, -0.05, -0.31, -0.78, Math.PI / 2, 0.04, 0);
  addPart(recoilGroup, new RoundedBoxGeometry(0.09, 0.07, 0.14, 1, 0.01), darkMetal, -0.05, -0.295, -0.6, 0.04, 0, 0);
  addPart(recoilGroup, new THREE.CylinderGeometry(0.012, 0.012, 0.1, 8), lightAlloy, -0.05, -0.31, -1.02, Math.PI / 2, 0, 0);
  glowPulses.push(
    addPart(swayGroup, new THREE.BoxGeometry(0.07, 0.008, 0.008), amberGlow, -0.3, -0.27, -0.41, -0.3, 0.1, 0),
    addPart(swayGroup, new THREE.BoxGeometry(0.07, 0.008, 0.008), cyanGlow, 0.3, -0.27, -0.41, -0.3, -0.1, 0),
  );
  addMuzzleFlash(recoilGroup, -0.05, -0.31, -1.08, 1.4, 0xffc84a);
}

// ---------- A-10 Warthog: armored CAS cockpit + GAU-8 snout ----------
function buildA10(kit: VmKit): void {
  const { swayGroup, recoilGroup, mats, addPart, addMuzzleFlash, spinners, glowPulses, trackMat } = kit;
  const { darkMetal, gunMetal, lightAlloy, cockpitTrim, factionMat, amberGlow, redGlow, greenGlow } = mats;
  kit.addAircraftCanopy(false, false);
  const armorGray = getChassisMat("#38424d", 0.44, 0.64);
  const hudGreenMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0x3cff7a, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }),
  );
  const hudLineMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0x52ff8c, transparent: true, opacity: 0.88, blending: THREE.AdditiveBlending, depthWrite: false }),
  );

  // Big armored flat-windscreen frame outside the canopy struts (titanium bathtub feel)
  addPart(swayGroup, new RoundedBoxGeometry(0.06, 0.58, 0.09, 2, 0.008), armorGray, -0.5, 0.05, -0.46, -0.22, 0.26, -0.24);
  addPart(swayGroup, new RoundedBoxGeometry(0.06, 0.58, 0.09, 2, 0.008), armorGray, 0.5, 0.05, -0.46, -0.22, -0.26, 0.24);
  addPart(swayGroup, new RoundedBoxGeometry(0.9, 0.058, 0.09, 2, 0.008), armorGray, 0, 0.35, -0.47, 0.16, 0, 0);
  addPart(swayGroup, new THREE.BoxGeometry(0.014, 0.24, 0.02), factionMat, -0.465, 0.03, -0.44, -0.22, 0.26, -0.24);
  addPart(swayGroup, new THREE.BoxGeometry(0.014, 0.24, 0.02), factionMat, 0.465, 0.03, -0.44, -0.22, -0.26, 0.24);

  // Wing-root struts + slung ordnance tips peeking low at the edges
  for (const sx of [-1, 1]) {
    addPart(swayGroup, new RoundedBoxGeometry(0.2, 0.035, 0.4, 2, 0.008), armorGray, sx * 0.44, -0.33, -0.72, 0.03, -sx * 0.3, sx * 0.05);
    addPart(recoilGroup, new THREE.CylinderGeometry(0.016, 0.018, 0.2, 8), gunMetal, sx * 0.46, -0.315, -0.8, Math.PI / 2, 0, 0);
    addPart(recoilGroup, new THREE.ConeGeometry(0.016, 0.05, 8), factionMat, sx * 0.46, -0.315, -0.93, -Math.PI / 2, 0, 0);
  }

  // Dual TF34 throttle quadrant on the left console
  addPart(swayGroup, new RoundedBoxGeometry(0.16, 0.075, 0.16, 2, 0.01), darkMetal, -0.32, -0.285, -0.43, -0.2, 0.14, 0);
  addPart(swayGroup, new THREE.BoxGeometry(0.012, 0.008, 0.11), gunMetal, -0.345, -0.246, -0.425, -0.2, 0.14, 0);
  addPart(swayGroup, new THREE.BoxGeometry(0.012, 0.008, 0.11), gunMetal, -0.295, -0.246, -0.425, -0.2, 0.14, 0);
  for (const tx of [-0.345, -0.295]) {
    addPart(swayGroup, new THREE.CylinderGeometry(0.007, 0.008, 0.085, 8), lightAlloy, tx, -0.22, -0.435, -0.32, 0, 0);
    addPart(swayGroup, new RoundedBoxGeometry(0.034, 0.018, 0.022, 1, 0.004), cockpitTrim, tx, -0.184, -0.45, -0.22, 0, 0);
  }
  glowPulses.push(
    addPart(swayGroup, new THREE.BoxGeometry(0.022, 0.008, 0.008), greenGlow, -0.345, -0.268, -0.365),
    addPart(swayGroup, new THREE.BoxGeometry(0.022, 0.008, 0.008), greenGlow, -0.295, -0.268, -0.365),
    addPart(swayGroup, new THREE.BoxGeometry(0.042, 0.009, 0.008), redGlow, 0.11, -0.272, -0.408, -0.34, 0, 0),
    addPart(swayGroup, new THREE.BoxGeometry(0.088, 0.008, 0.008), amberGlow, 0.24, -0.282, -0.404, -0.34, -0.12, 0),
    addPart(swayGroup, new THREE.BoxGeometry(0.115, 0.012, 0.008), greenGlow, 0.24, -0.266, -0.406, -0.34, -0.12, 0),
  );
  addPart(swayGroup, new RoundedBoxGeometry(0.18, 0.052, 0.024, 1, 0.004), darkMetal, 0.24, -0.272, -0.42, -0.34, -0.12, 0);

  // Iconic green HUD combiner glass + gun cross + CCIP pipper + heading tape
  addPart(swayGroup, new THREE.BoxGeometry(0.01, 0.145, 0.016), lightAlloy, -0.125, -0.185, -0.43, 0.18, 0, 0);
  addPart(swayGroup, new THREE.BoxGeometry(0.01, 0.145, 0.016), lightAlloy, 0.125, -0.185, -0.43, 0.18, 0, 0);
  addPart(swayGroup, new THREE.BoxGeometry(0.26, 0.009, 0.014), lightAlloy, 0, -0.115, -0.418, 0.18, 0, 0);
  const hudPane = addPart(swayGroup, new THREE.PlaneGeometry(0.238, 0.132), hudGreenMat, 0, -0.184, -0.428, 0.18, 0, 0);
  hudPane.renderOrder = 3;
  // Gun cross: long vertical + horizontal hairlines meeting at the pipper ring
  addPart(swayGroup, new THREE.BoxGeometry(0.0028, 0.1, 0.002), hudLineMat, 0, -0.184, -0.424, 0.18, 0, 0);
  addPart(swayGroup, new THREE.BoxGeometry(0.15, 0.003, 0.002), hudLineMat, 0, -0.184, -0.424, 0.18, 0, 0);
  addPart(swayGroup, new THREE.TorusGeometry(0.022, 0.0024, 6, 24), greenGlow, 0, -0.184, -0.423, 0.18, 0, 0);
  glowPulses.push(addPart(swayGroup, new THREE.SphereGeometry(0.0045, 8, 8), greenGlow, 0, -0.184, -0.421));
  for (const sx of [-1, 1]) {
    addPart(swayGroup, new THREE.BoxGeometry(0.0036, 0.05, 0.002), hudLineMat, sx * 0.06, -0.184, -0.424, 0.18, 0, 0);
    addPart(swayGroup, new THREE.BoxGeometry(0.018, 0.0034, 0.002), hudLineMat, sx * 0.052, -0.159, -0.419, 0.18, 0, 0);
  }
  for (const hx of [-0.075, -0.045, -0.015, 0.015, 0.045, 0.075]) {
    addPart(swayGroup, new THREE.BoxGeometry(0.0026, 0.01, 0.002), hudLineMat, hx, -0.134, -0.417, 0.18, 0, 0);
  }

  // Protruding GAU-8/A 7-barrel rotary tip + triple brrrt flash cluster
  const gauGroup = new THREE.Group();
  gauGroup.position.set(0, -0.345, -0.84);
  recoilGroup.add(gauGroup);
  addPart(gauGroup, new THREE.CylinderGeometry(0.032, 0.036, 0.28, 12), gunMetal, 0, 0, 0.08, Math.PI / 2, 0, 0);
  addPart(gauGroup, new RoundedBoxGeometry(0.09, 0.05, 0.1, 1, 0.008), armorGray, 0, 0.01, 0.16);
  const gauCluster = new THREE.Group();
  gauCluster.position.set(0, 0, -0.12);
  gauGroup.add(gauCluster);
  for (let i = 0; i < 6; i++) {
    const ang = (i * Math.PI * 2) / 6;
    addPart(gauCluster, new THREE.CylinderGeometry(0.0065, 0.0065, 0.26, 8), darkMetal, Math.cos(ang) * 0.016, Math.sin(ang) * 0.016, 0, Math.PI / 2, 0, 0);
  }
  addPart(gauCluster, new THREE.CylinderGeometry(0.026, 0.026, 0.022, 12), lightAlloy, 0, 0, -0.08, Math.PI / 2, 0, 0);
  spinners.push({ obj: gauCluster, axis: "z", speed: 24 });
  // Three staggered flashes around the muzzle ring — the brrrt looks like a cone of fire
  addMuzzleFlash(gauGroup, 0, 0, -0.3, 2.45, 0xffb438);
  addMuzzleFlash(gauGroup, -0.028, 0.02, -0.27, 1.5, 0xff8a26);
  addMuzzleFlash(gauGroup, 0.028, -0.016, -0.27, 1.5, 0xffd24a);
}

// ---------- AC-130 Spectre: FLIR fire-control station + port gun train ----------
function buildAc130(kit: VmKit): void {
  const { swayGroup, recoilGroup, mats, addPart, addMuzzleFlash, spinners, glowPulses, trackMat } = kit;
  const { darkMetal, gunMetal, lightAlloy, cockpitTrim, factionMat, glassTint, cyanGlow, amberGlow } = mats;
  const flirObsidian = getChassisMat("#141920", 0.56, 0.44);
  const flirTickGlow = getGlowMat("#58ffa0", 1.7);
  const thermalHotGlow = getGlowMat("#ff9832", 1.65);
  const flirScreenMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0x2bff8e, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }),
  );

  // Thermal-scope perimeter bezel (keeps the field clear for fire control)
  addPart(swayGroup, new RoundedBoxGeometry(1.12, 0.055, 0.1, 2, 0.01), flirObsidian, 0, 0.345, -0.45, 0.12, 0, 0);
  addPart(swayGroup, new RoundedBoxGeometry(1.14, 0.075, 0.14, 2, 0.012), flirObsidian, 0, -0.345, -0.46, -0.22, 0, 0);
  for (const sx of [-1, 1]) {
    addPart(swayGroup, new RoundedBoxGeometry(0.056, 0.68, 0.1, 2, 0.01), flirObsidian, sx * 0.54, 0, -0.45, 0, -sx * 0.16, 0);
    for (const sy of [-1, 1]) {
      // Phosphor-green FLIR corner L-brackets
      addPart(swayGroup, new THREE.BoxGeometry(0.09, 0.0055, 0.006), flirTickGlow, sx * 0.4, sy * 0.262, -0.43);
      addPart(swayGroup, new THREE.BoxGeometry(0.0055, 0.075, 0.006), flirTickGlow, sx * 0.442, sy * 0.225, -0.43);
    }
    // Side elevation stadia ticks
    for (const ey of [-0.12, -0.06, 0, 0.06, 0.12]) {
      addPart(swayGroup, new THREE.BoxGeometry(ey === 0 ? 0.03 : 0.017, 0.0038, 0.004), flirTickGlow, sx * 0.44, ey, -0.43);
    }
  }
  // Upper azimuth tape + center lubber marker
  for (let i = -5; i <= 5; i++) {
    const major = i % 5 === 0;
    addPart(swayGroup, new THREE.BoxGeometry(major ? 0.005 : 0.003, major ? 0.02 : 0.011, 0.004), i === 0 ? cyanGlow : flirTickGlow, i * 0.052, 0.296, -0.43);
  }
  addPart(swayGroup, new THREE.BoxGeometry(0.58, 0.003, 0.004), flirTickGlow, 0, 0.308, -0.432);

  // Heavy side console: port gun train muzzles peeking lower-left (105 / 40 / 25mm)
  addPart(swayGroup, new RoundedBoxGeometry(0.3, 0.09, 0.2, 2, 0.012), flirObsidian, -0.4, -0.32, -0.52, -0.16, 0.12, 0);
  const gunTrain = new THREE.Group();
  gunTrain.position.set(-0.4, -0.3, -0.66);
  gunTrain.rotation.set(0.05, 0.16, 0.05); // trained slightly outboard-left like the real side-firing battery
  recoilGroup.add(gunTrain);
  // 105mm M102 howitzer — biggest tube + slotted brake collar
  addPart(gunTrain, new THREE.CylinderGeometry(0.034, 0.04, 0.5, 14), lightAlloy, 0, 0.035, -0.08, Math.PI / 2, 0, 0);
  addPart(gunTrain, new THREE.CylinderGeometry(0.047, 0.045, 0.09, 14), darkMetal, 0, 0.035, -0.35, Math.PI / 2, 0, 0);
  glowPulses.push(addPart(gunTrain, new THREE.TorusGeometry(0.042, 0.005, 8, 18), thermalHotGlow, 0, 0.035, -0.28));
  addMuzzleFlash(gunTrain, 0, 0.035, -0.46, 2.4, 0xffa634);
  // 40mm Bofors — mid tube below the howitzer
  addPart(gunTrain, new THREE.CylinderGeometry(0.019, 0.023, 0.42, 12), gunMetal, 0.075, -0.05, -0.04, Math.PI / 2, 0, 0);
  addMuzzleFlash(gunTrain, 0.075, -0.05, -0.3, 1.5, 0xffc64a);
  // 25mm Gatling — fast thin barrel, lowest
  addPart(gunTrain, new THREE.CylinderGeometry(0.011, 0.013, 0.34, 10), darkMetal, 0.14, -0.115, 0, Math.PI / 2, 0, 0);
  addMuzzleFlash(gunTrain, 0.14, -0.115, -0.22, 1.15, 0x9fe8ff);

  // Monochrome-green FLIR gunsight screen on the right console
  const screen = new THREE.Group();
  screen.position.set(0.3, -0.272, -0.415);
  screen.rotation.set(-0.34, -0.16, 0);
  swayGroup.add(screen);
  addPart(screen, new RoundedBoxGeometry(0.19, 0.115, 0.02, 1, 0.005), darkMetal, 0, 0, 0);
  addPart(screen, new THREE.BoxGeometry(0.168, 0.096, 0.006), cockpitTrim, 0, 0, 0.009);
  const pane = addPart(screen, new THREE.PlaneGeometry(0.16, 0.09), flirScreenMat, 0, 0, 0.013);
  pane.renderOrder = 3;
  // Gunsight crosshair + range ticks etched on the screen
  addPart(screen, new THREE.BoxGeometry(0.13, 0.0022, 0.002), flirTickGlow, 0, 0, 0.015);
  addPart(screen, new THREE.BoxGeometry(0.0022, 0.075, 0.002), flirTickGlow, 0, 0, 0.015);
  for (const ty of [-0.028, -0.014, 0.014, 0.028]) {
    addPart(screen, new THREE.BoxGeometry(0.014, 0.0018, 0.002), flirTickGlow, -0.062, ty, 0.015);
  }
  glowPulses.push(addPart(screen, new THREE.SphereGeometry(0.0035, 8, 6), thermalHotGlow, 0.02, -0.012, 0.016)); // hot target blip

  // Weapon-select indicator lamps ×3 (105/40/25) on the lower console
  addPart(swayGroup, new RoundedBoxGeometry(0.26, 0.032, 0.02, 1, 0.004), cockpitTrim, -0.02, -0.31, -0.415, -0.24, 0, 0);
  const lampMats = [thermalHotGlow, amberGlow, flirTickGlow];
  for (let i = 0; i < 3; i++) {
    const lx = -0.1 + i * 0.09;
    glowPulses.push(addPart(swayGroup, new THREE.BoxGeometry(0.032, 0.012, 0.008), lampMats[i], lx, -0.308, -0.405, -0.24, 0, 0));
    addPart(swayGroup, new THREE.BoxGeometry(0.024, 0.004, 0.006), lightAlloy, lx, -0.324, -0.41, -0.24, 0, 0); // caliber placard tick
  }
  // FLIR gimbal lock ring spinning beside the lamps + faction console tabs
  const lockRing = addPart(swayGroup, new THREE.TorusGeometry(0.02, 0.0035, 8, 24), flirTickGlow, 0.14, -0.308, -0.41);
  spinners.push({ obj: lockRing, axis: "z", speed: -1.8 });
  addPart(swayGroup, new RoundedBoxGeometry(0.12, 0.016, 0.024, 1, 0.003), factionMat, -0.3, -0.302, -0.425);
  addPart(swayGroup, new RoundedBoxGeometry(0.12, 0.016, 0.024, 1, 0.003), factionMat, 0.42, -0.302, -0.425);
  addPart(swayGroup, new THREE.BoxGeometry(0.2, 0.014, 0.02), glassTint, 0.0, -0.34, -0.44, -0.24, 0, 0); // lower console glass edge
}

// ---------- Tempest Bomber: Norden-style bombardier station ----------
function buildBomber(kit: VmKit): void {
  const { swayGroup, recoilGroup, mats, addPart, addMuzzleFlash, glowPulses } = kit;
  const { darkMetal, gunMetal, cockpitTrim, glassCyan, cyanGlow, amberGlow, redGlow, greenGlow, brassMat } = mats;
  kit.addAircraftCanopy(true, true);

  // Center armored windscreen divider + overhead annunciator
  addPart(swayGroup, new RoundedBoxGeometry(0.022, 0.24, 0.036, 1, 0.004), cockpitTrim, 0, 0.24, -0.45, 0.14, 0, 0);
  glowPulses.push(addPart(swayGroup, new THREE.BoxGeometry(0.05, 0.008, 0.008), amberGlow, 0, 0.315, -0.43));

  // Norden-style gyro-stabilized bombsight jutting up between the knees
  const sight = new THREE.Group();
  sight.position.set(0.02, -0.335, -0.55);
  sight.rotation.set(-0.1, 0, 0);
  recoilGroup.add(sight); // release jolt kicks the sight — period correct
  // Stabilized gyro base + U-mount yoke
  addPart(sight, new RoundedBoxGeometry(0.15, 0.06, 0.12, 2, 0.01), darkMetal, 0, 0, 0.02);
  addPart(sight, new THREE.TorusGeometry(0.052, 0.007, 8, 22), brassMat, 0, 0.045, 0.01, 0.4, 0, 0);
  // Vertical optics tube angled up toward the bombardier's eye + eyepiece hood
  addPart(sight, new THREE.CylinderGeometry(0.024, 0.03, 0.15, 12), brassMat, 0, 0.09, -0.015, 0.5, 0, 0);
  addPart(sight, new THREE.CylinderGeometry(0.032, 0.03, 0.025, 12), cockpitTrim, 0, 0.155, -0.05, 0.5, 0, 0);
  // Reticle projector glass at the tube base + etched crosshair
  addPart(sight, new THREE.CylinderGeometry(0.02, 0.02, 0.004, 16), glassCyan, 0, 0.028, -0.055, Math.PI / 2 - 0.42, 0, 0);
  addPart(sight, new THREE.BoxGeometry(0.03, 0.0018, 0.002), cyanGlow, 0, 0.028, -0.062, 0.42, 0, 0);
  addPart(sight, new THREE.BoxGeometry(0.0018, 0.03, 0.002), cyanGlow, 0, 0.028, -0.062, 0.42, 0, 0);
  // Brass rate/drift knobs on both flanks + leveling bubble
  for (const sx of [-1, 1]) {
    addPart(sight, new THREE.CylinderGeometry(0.014, 0.014, 0.03, 10), brassMat, sx * 0.085, 0.02, 0.0, 0, 0, Math.PI / 2);
    addPart(sight, new THREE.CylinderGeometry(0.008, 0.008, 0.02, 8), darkMetal, sx * 0.1, 0.02, 0.0, 0, 0, Math.PI / 2);
  }
  glowPulses.push(addPart(sight, new THREE.SphereGeometry(0.006, 8, 8), greenGlow, 0.045, 0.062, 0.03));

  // Bomb-bay status strip: armed cell ladder + door lamps across the dash
  addPart(swayGroup, new RoundedBoxGeometry(0.34, 0.04, 0.024, 1, 0.005), darkMetal, -0.1, -0.27, -0.415, -0.34, 0.06, 0);
  const bayLamps = [redGlow, redGlow, amberGlow, greenGlow, greenGlow, greenGlow];
  for (let i = 0; i < bayLamps.length; i++) {
    const lamp = addPart(swayGroup, new THREE.BoxGeometry(0.03, 0.01, 0.008), bayLamps[i], -0.22 + i * 0.048, -0.266, -0.402, -0.34, 0.06, 0);
    if (i === 2) glowPulses.push(lamp); // doors-transit lamp pulses
  }
  // Salvo release paddle on the right + tally lamps
  addPart(swayGroup, new RoundedBoxGeometry(0.07, 0.05, 0.05, 1, 0.008), gunMetal, 0.29, -0.28, -0.42, -0.3, -0.12, 0);
  addPart(swayGroup, new THREE.CylinderGeometry(0.009, 0.011, 0.05, 8), redGlow, 0.29, -0.245, -0.425, -0.4, 0, 0);
  glowPulses.push(
    addPart(swayGroup, new THREE.BoxGeometry(0.06, 0.014, 0.01), redGlow, -0.11, -0.248, -0.41),
    addPart(swayGroup, new THREE.BoxGeometry(0.06, 0.014, 0.01), redGlow, 0.11, -0.248, -0.41),
  );
  addMuzzleFlash(recoilGroup, 0, -0.32, -0.84, 1.7, 0xff8a30);
}

// ---------- B-21 Phantom: matte-obsidian flying-wing cockpit ----------
function buildStealthBomber(kit: VmKit): void {
  const { swayGroup, recoilGroup, mats, addPart, addMuzzleFlash, glowPulses, trackMat } = kit;
  const { darkMetal, factionMat, cyanGlow, amberGlow, redGlow, greenGlow, brassMat } = mats;
  const obsidianMat = getChassisMat("#11151b", 0.58, 0.38); // radar-absorbent matte

  // Faceted V-angled stealth canopy brow + swept A-pillars, all matte obsidian
  addPart(swayGroup, new RoundedBoxGeometry(0.56, 0.042, 0.075, 2, 0.006), obsidianMat, -0.24, 0.325, -0.45, 0.16, 0.06, 0.12);
  addPart(swayGroup, new RoundedBoxGeometry(0.56, 0.042, 0.075, 2, 0.006), obsidianMat, 0.24, 0.325, -0.45, 0.16, -0.06, -0.12);
  addPart(swayGroup, new RoundedBoxGeometry(0.052, 0.56, 0.075, 2, 0.008), obsidianMat, -0.51, 0.04, -0.45, -0.22, 0.28, -0.26);
  addPart(swayGroup, new RoundedBoxGeometry(0.052, 0.56, 0.075, 2, 0.008), obsidianMat, 0.51, 0.04, -0.45, -0.22, -0.28, 0.26);
  // Thin RAM-edge gold seal lines along the inner pillars
  addPart(swayGroup, new THREE.BoxGeometry(0.007, 0.42, 0.012), brassMat, -0.478, 0.04, -0.43, -0.22, 0.28, -0.26);
  addPart(swayGroup, new THREE.BoxGeometry(0.007, 0.42, 0.012), brassMat, 0.478, 0.04, -0.43, -0.22, -0.28, 0.26);
  // Faceted glareshield + low-observable dash, minimal reflections
  addPart(swayGroup, new RoundedBoxGeometry(0.94, 0.11, 0.24, 2, 0.014), obsidianMat, 0, -0.325, -0.48, -0.28, 0, 0);
  addPart(swayGroup, new RoundedBoxGeometry(0.16, 0.016, 0.05, 1, 0.003), factionMat, -0.3, -0.265, -0.44, -0.28, 0.12, 0);
  addPart(swayGroup, new RoundedBoxGeometry(0.16, 0.016, 0.05, 1, 0.003), factionMat, 0.3, -0.265, -0.44, -0.28, -0.12, 0);

  // Stealth-status green LED arc glowing softly along the glareshield edge
  for (let i = -3; i <= 3; i++) {
    const ax = i * 0.058;
    const ay = -0.261 - (i * i) * 0.0011; // gentle arc drooping at the edges
    glowPulses.push(addPart(swayGroup, new THREE.BoxGeometry(0.024, 0.006, 0.006), greenGlow, ax, ay, -0.404, -0.32, 0, 0));
  }
  // Bomb-bay door indicators: paired amber/green lamp clusters + placard
  addPart(swayGroup, new RoundedBoxGeometry(0.2, 0.042, 0.02, 1, 0.004), darkMetal, 0.24, -0.275, -0.415, -0.3, -0.14, 0);
  glowPulses.push(
    addPart(swayGroup, new THREE.BoxGeometry(0.03, 0.009, 0.007), amberGlow, 0.19, -0.27, -0.404, -0.3, -0.14, 0),
    addPart(swayGroup, new THREE.BoxGeometry(0.03, 0.009, 0.007), greenGlow, 0.24, -0.27, -0.404, -0.3, -0.14, 0),
    addPart(swayGroup, new THREE.BoxGeometry(0.03, 0.009, 0.007), amberGlow, 0.29, -0.27, -0.404, -0.3, -0.14, 0),
  );
  glowPulses.push(
    addPart(swayGroup, new THREE.BoxGeometry(0.075, 0.008, 0.007), cyanGlow, -0.2, -0.272, -0.408, -0.34, 0.1, 0),
    addPart(swayGroup, new THREE.BoxGeometry(0.075, 0.008, 0.007), redGlow, -0.2, -0.284, -0.406, -0.34, 0.1, 0),
  );

  // Dim low-glare stealth HUD combiner + bomb-drop chevrons
  const stealthHudMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0x38f2ff, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }),
  );
  const sPane = addPart(swayGroup, new THREE.PlaneGeometry(0.22, 0.088), stealthHudMat, 0, -0.205, -0.43, 0.16, 0, 0);
  sPane.renderOrder = 3;
  addPart(swayGroup, new THREE.BoxGeometry(0.068, 0.003, 0.002), cyanGlow, -0.055, -0.205, -0.425, 0.16, 0, 0);
  addPart(swayGroup, new THREE.BoxGeometry(0.068, 0.003, 0.002), cyanGlow, 0.055, -0.205, -0.425, 0.16, 0, 0);
  addPart(swayGroup, new THREE.BoxGeometry(0.014, 0.014, 0.002), greenGlow, -0.008, -0.19, -0.422, 0.16, 0, Math.PI / 4);
  addPart(swayGroup, new THREE.BoxGeometry(0.014, 0.014, 0.002), greenGlow, 0.008, -0.19, -0.422, 0.16, 0, Math.PI / 4);
  addMuzzleFlash(recoilGroup, 0, -0.34, -0.86, 1.65, 0x52f2ff);
}

// ---------- Mach-9 Hypersonic: armored scramjet dive sled ----------
function buildHypersonic(kit: VmKit): void {
  const { swayGroup, recoilGroup, mats, addPart, addMuzzleFlash, glowPulses } = kit;
  const { darkMetal, gunMetal, factionMat, cyanGlow, amberGlow, redGlow } = mats;
  const titaniumMat = getChassisMat("#323d4c", 0.24, 0.86);
  const visorMat = getChassisMat("#1a212c", 0.5, 0.55);

  // Narrow armored slit viewport: heavy brow + chin + cheek slabs leave one thin slit
  addPart(swayGroup, new RoundedBoxGeometry(1.16, 0.19, 0.13, 2, 0.02), titaniumMat, 0, 0.375, -0.42, 0.1, 0, 0);
  addPart(swayGroup, new RoundedBoxGeometry(1.16, 0.15, 0.14, 2, 0.02), titaniumMat, 0, -0.375, -0.42, -0.18, 0, 0);
  for (const sx of [-1, 1]) {
    addPart(swayGroup, new RoundedBoxGeometry(0.15, 0.54, 0.12, 2, 0.02), titaniumMat, sx * 0.55, 0, -0.42, 0, -sx * 0.14, 0);
    // Inner slit gasket seals
    addPart(swayGroup, new RoundedBoxGeometry(0.04, 0.5, 0.05, 1, 0.006), visorMat, sx * 0.49, 0, -0.43, 0, -sx * 0.1, 0);
    // Intake glow strips: superheated cyan core + amber edge along each cheek
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.011, 0.42, 0.008), cyanGlow, sx * 0.462, 0, -0.4, 0, -sx * 0.1, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.007, 0.3, 0.008), amberGlow, sx * 0.482, 0.02, -0.405, 0, -sx * 0.1, 0),
    );
  }
  // Slit lip seals + brow underglow strip
  addPart(swayGroup, new RoundedBoxGeometry(0.96, 0.032, 0.06, 1, 0.006), visorMat, 0, 0.29, -0.43, 0.1, 0, 0);
  addPart(swayGroup, new RoundedBoxGeometry(0.96, 0.032, 0.06, 1, 0.006), visorMat, 0, -0.305, -0.43, -0.18, 0, 0);
  glowPulses.push(addPart(swayGroup, new THREE.BoxGeometry(0.8, 0.009, 0.008), cyanGlow, 0, 0.272, -0.415, 0.1, 0, 0));

  // Mach-taper dash: narrow sloped console with tapering mach-ladder bars
  addPart(swayGroup, new RoundedBoxGeometry(0.4, 0.07, 0.16, 2, 0.01), darkMetal, 0, -0.34, -0.46, -0.22, 0, 0);
  const machLens = [0.3, 0.24, 0.18, 0.12];
  for (let i = 0; i < machLens.length; i++) {
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(machLens[i], 0.007, 0.007), i % 2 === 0 ? cyanGlow : amberGlow, 0, -0.315 - i * 0.012, -0.4 + i * 0.002, -0.22, 0, 0),
    );
  }
  // Terminal-dive armed bar + target-track brackets
  glowPulses.push(addPart(swayGroup, new THREE.BoxGeometry(0.14, 0.01, 0.008), redGlow, 0, 0.318, -0.425));
  trackBrackets(kit, amberGlow, 0.13, 0.1, -0.415);

  // Needle delta nose + superheated plasma tip + chine glow rails + release flashes
  addPart(swayGroup, new THREE.ConeGeometry(0.062, 0.66, 6), titaniumMat, 0, -0.325, -0.92, -Math.PI / 2, 0, 0);
  addPart(swayGroup, new RoundedBoxGeometry(0.13, 0.02, 0.4, 1, 0.004), factionMat, 0, -0.312, -0.78, 0.04, 0, 0);
  glowPulses.push(
    addPart(swayGroup, new THREE.ConeGeometry(0.03, 0.15, 8), amberGlow, 0, -0.325, -1.22, -Math.PI / 2, 0, 0),
  );
  for (const sx of [-1, 1]) {
    glowPulses.push(
      addPart(swayGroup, new THREE.BoxGeometry(0.011, 0.011, 0.44), cyanGlow, sx * 0.09, -0.315, -0.82, 0.04, -sx * 0.14, 0),
      addPart(swayGroup, new THREE.BoxGeometry(0.008, 0.008, 0.32), amberGlow, sx * 0.118, -0.312, -0.86, 0.04, -sx * 0.14, 0),
    );
    addPart(recoilGroup, new THREE.CylinderGeometry(0.012, 0.015, 0.24, 8), gunMetal, sx * 0.18, -0.29, -1.0, Math.PI / 2, -sx * 0.06, 0);
    addMuzzleFlash(recoilGroup, sx * 0.18, -0.29, -1.16, 2.0, 0xffaa38);
  }
  addMuzzleFlash(recoilGroup, 0, -0.32, -1.28, 2.45, 0x72f8ff);
}

// ---------- Leviathan Zeppelin: brass & leather airship gondola ----------
function buildZeppelin(kit: VmKit): void {
  const { swayGroup, recoilGroup, mats, addPart, addMuzzleFlash, spinners, glowPulses, trackMat } = kit;
  const { darkMetal, gunMetal, lightAlloy, factionMat, glassTint, amberGlow, redGlow, greenGlow, brassMat } = mats;
  // Riveted leather & dark-wood gondola trim — unique mats, auto-disposed via trackMat
  const leatherMat = trackMat(new THREE.MeshStandardMaterial({ color: 0x3a2818, roughness: 0.86, metalness: 0.06 }));
  const woodMat = trackMat(new THREE.MeshStandardMaterial({ color: 0x4c3722, roughness: 0.72, metalness: 0.1 }));
  const dialFaceMat = trackMat(new THREE.MeshStandardMaterial({ color: 0xe8ddc4, roughness: 0.5, metalness: 0.05 }));

  // Big riveted window frames left/right + brass mullions + top brow + sill
  for (const sx of [-1, 1]) {
    addPart(swayGroup, new RoundedBoxGeometry(0.05, 0.6, 0.07, 2, 0.008), brassMat, sx * 0.5, 0.03, -0.45, -0.16, sx * 0.18, sx * 0.12);
    addPart(swayGroup, new RoundedBoxGeometry(0.03, 0.3, 0.05, 1, 0.005), woodMat, sx * 0.24, 0.16, -0.45, 0.1, sx * 0.06, sx * 0.06);
    addPart(swayGroup, new RoundedBoxGeometry(0.03, 0.26, 0.05, 1, 0.005), woodMat, sx * 0.24, -0.18, -0.46, -0.16, sx * 0.06, -sx * 0.04);
    // Leather-wrapped side console edges
    addPart(swayGroup, new RoundedBoxGeometry(0.09, 0.3, 0.14, 2, 0.014), leatherMat, sx * 0.5, -0.25, -0.47, -0.14, sx * 0.1, 0);
    // Brass window rivet rows along outer pillars
    for (const ry of [-0.14, -0.02, 0.1, 0.22]) {
      addPart(swayGroup, new THREE.SphereGeometry(0.006, 6, 6), brassMat, sx * 0.485, ry, -0.42);
    }
  }
  addPart(swayGroup, new RoundedBoxGeometry(1.0, 0.055, 0.08, 2, 0.01), brassMat, 0, 0.345, -0.46, 0.14, 0, 0);
  addPart(swayGroup, new RoundedBoxGeometry(1.04, 0.09, 0.2, 2, 0.014), woodMat, 0, -0.335, -0.48, -0.24, 0, 0);
  // Center windscreen brass mullion + gas-bag pressure gauge pips above it
  addPart(swayGroup, new RoundedBoxGeometry(0.024, 0.5, 0.05, 1, 0.005), brassMat, 0, 0.1, -0.455, -0.06, 0, 0);
  glowPulses.push(
    addPart(swayGroup, new THREE.SphereGeometry(0.007, 8, 6), amberGlow, 0, 0.315, -0.43),
    addPart(swayGroup, new THREE.SphereGeometry(0.007, 8, 6), greenGlow, -0.02, 0.31, -0.43),
    addPart(swayGroup, new THREE.SphereGeometry(0.007, 8, 6), greenGlow, 0.02, 0.31, -0.43),
  );

  // Helm wheel bottom-center: wood rim + brass hub + spokes, slow idle drift
  const helm = new THREE.Group();
  helm.position.set(-0.12, -0.35, -0.56);
  helm.rotation.set(-0.42, 0.06, 0); // tilted back toward the pilot like a ship's wheel
  swayGroup.add(helm);
  addPart(helm, new THREE.TorusGeometry(0.078, 0.009, 8, 26), woodMat, 0, 0, 0);
  addPart(helm, new THREE.CylinderGeometry(0.018, 0.02, 0.03, 12), brassMat, 0, 0, 0.004, Math.PI / 2, 0, 0);
  for (let i = 0; i < 5; i++) {
    const ang = (i / 5) * Math.PI * 2;
    // Each spoke is a diameter bar through the hub (rz maps the Y axis to angle ang)
    addPart(helm, new THREE.CylinderGeometry(0.004, 0.005, 0.16, 6), brassMat, 0, 0, 0, 0, 0, ang + Math.PI / 2);
  }
  for (let i = 0; i < 10; i++) {
    const ang = (i / 10) * Math.PI * 2;
    // Ten handle pegs protruding past the rim, aligned with the spoke ends
    addPart(helm, new THREE.SphereGeometry(0.008, 6, 6), brassMat, Math.cos(ang) * 0.085, Math.sin(ang) * 0.085, 0);
  }
  spinners.push({ obj: helm, axis: "z", speed: 0.35 }); // lazy idle drift
  addPart(swayGroup, new THREE.CylinderGeometry(0.022, 0.028, 0.1, 10), brassMat, -0.12, -0.4, -0.52, 0.5, 0, 0); // pedestal

  // Altitude dial on the right console: brass bezel + enamel face + needle
  const dial = new THREE.Group();
  dial.position.set(0.16, -0.3, -0.44);
  dial.rotation.set(-0.34, -0.14, 0);
  swayGroup.add(dial);
  addPart(dial, new THREE.TorusGeometry(0.032, 0.006, 8, 22), brassMat, 0, 0, 0);
  addPart(dial, new THREE.CircleGeometry(0.029, 22), dialFaceMat, 0, 0, 0.002);
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    addPart(dial, new THREE.BoxGeometry(0.003, i % 2 === 0 ? 0.008 : 0.005, 0.002), darkMetal, Math.cos(ang) * 0.024, Math.sin(ang) * 0.024, 0.004, 0, 0, ang + Math.PI / 2);
  }
  // Needle parked at ~2 o'clock + brass center pin
  addPart(dial, new THREE.BoxGeometry(0.003, 0.022, 0.002), redGlow, 0.007, 0.006, 0.005, 0, 0, -0.9);
  addPart(dial, new THREE.CylinderGeometry(0.004, 0.004, 0.006, 8), brassMat, 0, 0, 0.005, Math.PI / 2, 0, 0);
  // Inclinometer tube beside it: curved glass + trapped bubble
  addPart(swayGroup, new THREE.TorusGeometry(0.05, 0.006, 6, 20, Math.PI * 0.5), glassTint, 0.3, -0.315, -0.43, 0, 0, Math.PI * 0.25);
  glowPulses.push(addPart(swayGroup, new THREE.SphereGeometry(0.007, 8, 8), greenGlow, 0.315, -0.29, -0.428));

  // Bomb-release brass telegraph lever + crimson release lamp
  addPart(swayGroup, new RoundedBoxGeometry(0.07, 0.05, 0.06, 1, 0.008), woodMat, -0.3, -0.29, -0.43, -0.24, 0.14, 0);
  addPart(swayGroup, new THREE.CylinderGeometry(0.007, 0.009, 0.07, 8), brassMat, -0.3, -0.25, -0.435, -0.4, 0, 0);
  addPart(swayGroup, new THREE.SphereGeometry(0.013, 8, 8), redGlow, -0.3, -0.218, -0.45);
  glowPulses.push(addPart(swayGroup, new THREE.BoxGeometry(0.22, 0.016, 0.01), redGlow, 0, -0.275, -0.415, -0.36, 0, 0));
  addPart(swayGroup, new RoundedBoxGeometry(0.14, 0.02, 0.03, 1, 0.004), factionMat, -0.42, -0.29, -0.42);
  addPart(swayGroup, new RoundedBoxGeometry(0.14, 0.02, 0.03, 1, 0.004), factionMat, 0.42, -0.29, -0.42);
  // Gondola keel + forward bomb-sight window ledge below the sill
  addPart(swayGroup, new RoundedBoxGeometry(0.5, 0.04, 0.3, 2, 0.01), darkMetal, 0, -0.385, -0.7, 0.06, 0, 0);
  addPart(swayGroup, new RoundedBoxGeometry(0.2, 0.016, 0.16, 1, 0.004), gunMetal, 0, -0.362, -0.72, 0.06, 0, 0);
  addPart(swayGroup, new THREE.CylinderGeometry(0.006, 0.006, 0.1, 8), lightAlloy, -0.09, -0.36, -0.78, Math.PI / 2, 0.2, 0); // drift sight wire
  addPart(swayGroup, new THREE.CylinderGeometry(0.006, 0.006, 0.1, 8), lightAlloy, 0.09, -0.36, -0.78, Math.PI / 2, -0.2, 0);
  addMuzzleFlash(recoilGroup, 0, -0.33, -0.82, 1.9, 0xff5a28);
}

// ---------- Registry ----------

export const AIR_VM: Partial<Record<UnitKind, (kit: VmKit) => void>> = {
  fpvdrone: buildFpvDrone,
  uav: buildUav,
  shahed: buildShahed,
  ewdrone: buildEwDrone,
  interceptor: buildInterceptor,
  chopper: buildChopper,
  a10: buildA10,
  ac130: buildAc130,
  bomber: buildBomber,
  stealthbomber: buildStealthBomber,
  hypersonic: buildHypersonic,
  zeppelin: buildZeppelin,
};
