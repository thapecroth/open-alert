import * as THREE from "three";
import type { EntSnap } from "../shared/protocol";
import type { EntVis } from "./models";
import { isBuildingKind } from "./util";

export interface AnimState {
  phase: number;
  speed: number;
  prevSpeed: number;
  moveBlend: number;
  prevX: number;
  prevY: number;
  prevHeading: number;
  bank: number;
  roll: number;
  pitch: number;
  recoil: number;
  hullKick: number;
  kickLocalYaw: number;
  turretWorldYaw: number;
  turretHold: number;
  buildAge: number;
  isNewBuilding: boolean;
  smokeCd: number;
  wakeCd: number;
  dustCd: number;
  contrailCd: number;
  subY: number;
  subAlpha: number;
  hitFlash: number;
  flashing: boolean;
  matMode: "normal" | "hit" | "holo";
}

const HIT_FLASH_MAT = new THREE.MeshStandardMaterial({
  color: 0xfff2e0,
  emissive: 0xffffff,
  emissiveIntensity: 0.62,
  roughness: 0.4,
  metalness: 0.2,
});

const HOLO_BUILD_MAT = new THREE.MeshStandardMaterial({
  color: 0x4ae0ff,
  emissive: 0x1eb8ff,
  emissiveIntensity: 0.85,
  roughness: 0.2,
  metalness: 0.35,
  transparent: true,
  opacity: 0.56,
  depthWrite: false,
});

export function createAnimState(e: EntSnap, animateConstruct: boolean): AnimState {
  const newBld = animateConstruct && isBuildingKind(e.k);
  return {
    phase: (e.id * 1.37) % (Math.PI * 2),
    speed: 0,
    prevSpeed: 0,
    moveBlend: 0,
    prevX: e.x,
    prevY: e.y,
    prevHeading: e.d / 10,
    bank: 0,
    roll: 0,
    pitch: 0,
    recoil: 0,
    hullKick: 0,
    kickLocalYaw: 0,
    turretWorldYaw: Math.PI / 2 - e.d / 10,
    turretHold: 0,
    buildAge: newBld ? 0 : 1,
    isNewBuilding: newBld,
    smokeCd: 0.4 + ((e.id * 0.13) % 0.6),
    wakeCd: 0.14 + ((e.id * 0.07) % 0.14),
    dustCd: 0.12 + ((e.id * 0.09) % 0.12),
    contrailCd: 0.05 + ((e.id * 0.03) % 0.05),
    subY: e.sub ? -0.18 : 0.06,
    subAlpha: e.sub ? (e.k === "stealthbomber" ? 0.38 : 0.42) : 1,
    hitFlash: 0,
    flashing: false,
    matMode: "normal",
  };
}

export function triggerHitFlash(st: AnimState) {
  st.hitFlash = 0.11;
}

function angleDiff(a: number, b: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function triggerFireAnim(st: AnimState, fx: number, fy: number, tx: number, ty: number) {
  st.recoil = 1;
  st.hullKick = 1;
  const worldAngle = Math.PI / 2 - Math.atan2(ty - fy, tx - fx);
  st.turretWorldYaw = worldAngle;
  st.turretHold = 2.6;
  const hullYaw = Math.PI / 2 - st.prevHeading;
  st.kickLocalYaw = angleDiff(hullYaw, worldAngle);
}

function setBodyMatMode(body: THREE.Group, st: AnimState, target: "normal" | "hit" | "holo") {
  if (st.matMode === target) return;
  if (target === "normal") {
    body.traverse((o) => {
      if (o instanceof THREE.Mesh && o.userData._origMat) {
        o.material = o.userData._origMat as THREE.Material | THREE.Material[];
        delete o.userData._origMat;
      }
    });
  } else {
    const override = target === "hit" ? HIT_FLASH_MAT : HOLO_BUILD_MAT;
    body.traverse((o) => {
      if (o instanceof THREE.Mesh && !o.userData.isBar) {
        if (!o.userData._origMat) o.userData._origMat = o.material;
        o.material = override;
      }
    });
  }
  st.matMode = target;
  st.flashing = target === "hit";
}

function getBaseRecoilZ(recoil: THREE.Group, fallback: number): number {
  if (recoil.userData.baseZ === undefined) {
    recoil.userData.baseZ = recoil.position.z || fallback;
  }
  return recoil.userData.baseZ as number;
}

function getBaseRecoilY(recoil: THREE.Group, fallback: number): number {
  if (recoil.userData.baseY === undefined) {
    recoil.userData.baseY = recoil.position.y || fallback;
  }
  return recoil.userData.baseY as number;
}

export function stepEntityAnim(
  vis: EntVis,
  st: AnimState,
  last: EntSnap,
  x: number,
  y: number,
  headingRad: number,
  dt: number,
  nowSec: number,
  emitSmoke?: (x: number, y: number, z: number, dark: boolean) => void,
  emitWake?: (x: number, z: number, scale?: number) => void,
  lowPower = false,
  emitDust?: (x: number, z: number, scale?: number) => void,
  emitContrail?: (x: number, y: number, z: number, scale?: number) => void,
) {
  const rig = vis.rig;
  const k = vis.kind;
  const safeDt = Math.max(0.0005, Math.min(0.1, dt));

  // Measure frame linear velocity, acceleration & heading angular velocity
  const dx = x - st.prevX;
  const dy = y - st.prevY;
  st.prevX = x;
  st.prevY = y;
  const dist = Math.hypot(dx, dy);
  const instSpeed = dist > 4 ? 0 : Math.min(7.5, dist / safeDt);
  st.prevSpeed = st.speed;
  // Asymmetric hysteresis: fast acceleration, gentle deceleration so brief WAN jitter
  // never causes mid-stride leg hitches
  const speedAlpha =
    instSpeed >= st.speed
      ? 1 - Math.exp(-14 * safeDt)
      : 1 - Math.exp(-4.8 * safeDt);
  st.speed += (instSpeed - st.speed) * speedAlpha;
  const accel = (st.speed - st.prevSpeed) / safeDt;

  // Continuous smoothstep idle <-> run blend (eliminates harsh moving/idle discontinuity)
  const targetMove = Math.min(1, Math.max(0, (st.speed - 0.14) / 0.65));
  const blendAlpha =
    targetMove >= st.moveBlend
      ? 1 - Math.exp(-12 * safeDt)
      : 1 - Math.exp(-5.5 * safeDt);
  st.moveBlend += (targetMove - st.moveBlend) * blendAlpha;
  const mb = st.moveBlend;
  const m = mb * mb * (3 - 2 * mb);
  const moving = m > 0.08;

  const dYaw = angleDiff(st.prevHeading, headingRad);
  st.prevHeading = headingRad;
  const yawRate = dYaw / safeDt;

  // Smoothly decay recoil & hull suspension kick impulses
  if (st.recoil > 0.001) st.recoil = Math.max(0, st.recoil - safeDt * 5.0);
  else st.recoil = 0;

  if (st.hullKick > 0.001) st.hullKick = Math.max(0, st.hullKick - safeDt * 3.1);
  else st.hullKick = 0;

  // Holographic rising construction animation for newly placed buildings
  let holoConstruct = false;
  if (st.isNewBuilding && st.buildAge < 1) {
    st.buildAge = Math.min(1, st.buildAge + safeDt * 1.9);
    const ease = 1 - Math.pow(1 - st.buildAge, 3);
    const pulseXZ = st.buildAge < 0.85 ? 1 + 0.015 * Math.sin(nowSec * 24) : 1;
    rig.body.scale.set(pulseXZ, Math.max(0.06, ease), pulseXZ);
    holoConstruct = st.buildAge < 0.86;
  } else if (isBuildingKind(k)) {
    rig.body.scale.set(1, 1, 1);
  }

  // ---------- 1. Humanoid Infantry Animation (Fluid Athletic Stride & Continuous Blend) ----------
  if (k === "infantry" || k === "engineer" || k === "rocket") {
    const baseArmL = k === "infantry" ? -0.45 : k === "rocket" ? -0.3 : 0;
    const baseArmR = k === "infantry" ? -0.58 : k === "rocket" ? -0.35 : 0;

    // Continuous stride frequency proportional to actual speed + independent idle breath clock
    st.phase += safeDt * (4.8 + st.speed * 5.2);
    const idleT = nowSec * 2.1 + last.id * 1.37;
    const breath = Math.sin(idleT);
    const idleBob = breath * 0.016;
    const idleLean = breath * 0.018;
    const idleScan = Math.sin(idleT * 0.55 + last.id) * 0.3;
    const idleHeadPitch = Math.sin(idleT * 0.35 + last.id) * 0.05;

    const s = Math.sin(st.phase);
    // Athletic asymmetric leg stride: crisp forward knee-lift (pow 0.85) + snappy rear push-off (pow 1.15)
    const strideL = s > 0 ? Math.pow(s, 0.85) : -Math.pow(-s, 1.15);
    const strideR = -s > 0 ? Math.pow(-s, 0.85) : -Math.pow(s, 1.15);

    if (rig.legL) rig.legL.rotation.x = -strideL * 0.78 * m;
    if (rig.legR) rig.legR.rotation.x = -strideR * 0.78 * m;

    // Arms pump naturally in opposition (rifleman keeps pulse rifle braced steadily with subtle stride rhythm)
    if (k === "infantry") {
      const rifleRhythm = Math.sin(st.phase * 2) * 0.05 * m;
      if (rig.armL) rig.armL.rotation.x = baseArmL + (s * 0.22 + rifleRhythm) * m;
      if (rig.armR) rig.armR.rotation.x = baseArmR + (-s * 0.14 - rifleRhythm) * m;
    } else if (k === "engineer") {
      if (rig.armL) rig.armL.rotation.x = baseArmL + s * 0.56 * m;
      if (rig.armR) rig.armR.rotation.x = baseArmR - s * 0.52 * m;
    } else {
      if (rig.armL) rig.armL.rotation.x = baseArmL + s * 0.48 * m;
      if (rig.armR) rig.armR.rotation.x = baseArmR - s * 0.48 * m;
    }

    // Smooth double-frequency athletic run bounce (peaks mid-flight, dips on foot plant) + natural counter-motion
    const runBounce = 0.042 + 0.048 * Math.sin(st.phase * 2 - Math.PI / 2);
    rig.body.position.y = idleBob * (1 - m) + runBounce * m;
    rig.body.rotation.x = idleLean * (1 - m) + 0.16 * m;
    rig.body.rotation.y = -s * 0.14 * m;
    rig.body.rotation.z = s * 0.065 * m;

    // Subtle head counter-stabilization keeps soldier's gaze locked ahead while sprinting
    if (rig.head) {
      rig.head.rotation.y = s * 0.08 * m + idleScan * (1 - m);
      rig.head.rotation.x = idleHeadPitch * (1 - m) - 0.07 * m;
    }

    // Sharp braced kickback on weapon fire
    if (st.recoil > 0) {
      const kick = Math.sin(st.recoil * Math.PI * 0.5);
      rig.body.rotation.x -= kick * 0.16;
      rig.body.position.z = -kick * 0.055;
      if (rig.armR) rig.armR.rotation.x -= kick * 0.22;
      if (rig.armL && k === "infantry") rig.armL.rotation.x -= kick * 0.14;
    } else {
      rig.body.position.z *= Math.exp(-14 * safeDt);
    }

    if (rig.recoil) {
      const baseZ = getBaseRecoilZ(rig.recoil, k === "infantry" ? 0.15 : 0);
      rig.recoil.position.z = baseZ - st.recoil * 0.13;
    }
  }

  // ---------- 2. Spider Drone 4-Leg Skitter Gait ----------
  else if (k === "spider" && rig.spiderLegs) {
    const idleT = nowSec * 2.6 + last.id * 1.37;
    st.phase += safeDt * (2.6 + m * (9.4 + st.speed * 5.4));
    const idleY = Math.sin(idleT) * 0.02;
    const skitterY = 0.036 + 0.038 * Math.sin(st.phase * 2 - Math.PI / 2);
    rig.body.position.y = idleY * (1 - m) + skitterY * m;
    rig.body.rotation.x = 0.075 * m;
    rig.body.rotation.z = Math.sin(st.phase) * 0.04 * m;
    const amp = 0.065 + (0.44 - 0.065) * m;
    for (let idx = 0; idx < rig.spiderLegs.length; idx++) {
      const leg = rig.spiderLegs[idx];
      const diag = idx === 0 || idx === 3 ? 0 : Math.PI;
      const wave = Math.sin(st.phase + diag);
      leg.rotation.y = wave * amp;
      leg.rotation.z = Math.max(0, Math.cos(st.phase + diag)) * amp * 0.48 * (idx % 2 === 0 ? 1 : -1);
    }
    rig.body.position.z = st.recoil > 0 ? st.recoil * 0.2 : 0;
  }

  // ---------- 3. Tracked / Wheeled Vehicles (Suspension, Hull Rock-Back & Dust Plumes) ----------
  else if (k === "tank" || k === "heavy" || k === "arty" || k === "harvester" || k === "himars" || k === "railtank") {
    const heavyScale = k === "heavy" || k === "railtank" ? 1.15 : k === "arty" || k === "himars" ? 1.08 : 1.0;

    // Suspension roll into turns & acceleration/braking pitch driven by jitter-free moveBlend
    const targetRoll = Math.max(-0.13, Math.min(0.13, yawRate * 0.055 * m));
    st.roll += (targetRoll - st.roll) * (1 - Math.exp(-9 * safeDt));

    const accelPitch = Math.max(-0.075, Math.min(0.085, -accel * 0.012));
    const cruisePitch = -0.022 * m;
    st.pitch += (accelPitch + cruisePitch - st.pitch) * (1 - Math.exp(-8 * safeDt));

    // Cannon-fire damped hull suspension rock-back (oriented along turret firing vector!)
    let firePitch = 0;
    let fireRoll = 0;
    if (st.hullKick > 0 && k !== "harvester") {
      // Damped oscillation: sharp kick back then quick spring settle
      const osc = Math.sin((1 - st.hullKick) * Math.PI * 1.45 + 0.35) * st.hullKick;
      const mag = (k === "heavy" || k === "railtank" ? 0.12 : k === "arty" || k === "himars" ? 0.135 : 0.095) * osc;
      firePitch = -Math.cos(st.kickLocalYaw) * mag;
      fireRoll = Math.sin(st.kickLocalYaw) * mag * 0.85;
    }

    st.phase += safeDt * (8.5 + st.speed * 3.4) * m;
    const rum = Math.sin(st.phase);
    const idleHumY = Math.sin(nowSec * 6.5 + last.id) * 0.005;
    const moveRumbleY = 0.013 + 0.013 * Math.sin(st.phase * 2 - Math.PI / 2);
    rig.body.position.y = idleHumY * (1 - m) + moveRumbleY * m + Math.abs(firePitch) * (0.14 - 0.02 * m);
    rig.body.rotation.x = st.pitch + rum * 0.014 * m + firePitch;
    rig.body.rotation.z = st.roll + Math.cos(st.phase * 0.7) * 0.012 * m + fireRoll;

    // Independent turret yaw tracking (tanks, heavy tanks, railtank, arty/himars)
    if (rig.turret) {
      const hullYaw = Math.PI / 2 - headingRad;
      if (st.turretHold > 0) {
        st.turretHold -= safeDt;
      } else {
        st.turretWorldYaw = hullYaw;
      }
      const targetLocal = angleDiff(hullYaw, st.turretWorldYaw);
      const diff = angleDiff(rig.turret.rotation.y, targetLocal);
      rig.turret.rotation.y += diff * (1 - Math.exp(-11 * safeDt));
    }

    // Crisp barrel / rocket-rack recoil kickback (preserves authored baseZ)
    if (rig.recoil) {
      const fallbackZ = k === "arty" || k === "himars" ? -0.26 : k === "heavy" || k === "railtank" ? 0.42 : 0.35;
      const baseZ = getBaseRecoilZ(rig.recoil, fallbackZ);
      const kickDist = k === "heavy" || k === "railtank" ? 0.34 : k === "arty" || k === "himars" ? 0.25 : 0.28;
      rig.recoil.position.z = baseZ - st.recoil * kickDist;
    }

    // Harvester rotating front ore scoop drum
    if (k === "harvester" && rig.spin) {
      const idleSpin = (last.cargo ?? 0) > 0 && (last.cargo ?? 0) < 40 ? 9.6 : 1.8;
      const spinRate = idleSpin * (1 - m) + 7.2 * m;
      rig.spin.rotation.x += safeDt * spinRate;
    }

    // Warm earth dust trail puffs kicked up behind moving tracked/wheeled vehicles
    if (emitDust && moving && vis.root.visible) {
      st.dustCd -= safeDt;
      if (st.dustCd <= 0) {
        st.dustCd = Math.max(0.09, 0.21 - st.speed * 0.025);
        const rearDist = k === "heavy" || k === "harvester" || k === "railtank" || k === "himars" ? 0.94 : 0.78;
        const treadHalf = k === "heavy" || k === "railtank" ? 0.62 : 0.48;
        const cosH = Math.cos(headingRad);
        const sinH = Math.sin(headingRad);
        const side = Math.random() > 0.5 ? treadHalf : -treadHalf;
        const dxW = x - cosH * rearDist + sinH * side;
        const dzW = y - sinH * rearDist - cosH * side;
        emitDust(dxW, dzW, heavyScale * (0.78 + Math.random() * 0.32));
      }
    }
  }

  // ---------- 4. Air Force (Smooth Banking, Hover Float, Stealth Cloak, Rotors & Wingtip Contrails) ----------
  else if (
    k === "interceptor" ||
    k === "chopper" ||
    k === "bomber" ||
    k === "zeppelin" ||
    k === "uav" ||
    k === "stealthbomber" ||
    k === "hypersonic"
  ) {
    const alt = rig.altitude ?? 3.2;
    let bob = 0;

    if (k === "interceptor") {
      bob = Math.sin(nowSec * 3.8 + last.id) * 0.09;
      rig.body.position.y = alt + bob;
      const targetBank = Math.max(-0.64, Math.min(0.64, yawRate * 0.2));
      st.bank += (targetBank - st.bank) * (1 - Math.exp(-9 * safeDt));
      rig.body.rotation.z = st.bank;
      const targetPitch = 0.02 * (1 - m) + (-0.04 + Math.abs(st.bank) * 0.06) * m;
      rig.body.rotation.x += (targetPitch - rig.body.rotation.x) * (1 - Math.exp(-7 * safeDt));
    } else if (k === "uav") {
      bob = Math.sin(nowSec * 3.4 + last.id) * 0.08;
      rig.body.position.y = alt + bob;
      const targetBank = Math.max(-0.52, Math.min(0.52, yawRate * 0.18));
      st.bank += (targetBank - st.bank) * (1 - Math.exp(-8.5 * safeDt));
      rig.body.rotation.z = st.bank;
      const targetPitch = 0.015 * (1 - m) + (-0.03 + Math.abs(st.bank) * 0.05) * m;
      rig.body.rotation.x += (targetPitch - rig.body.rotation.x) * (1 - Math.exp(-7 * safeDt));
      if (rig.spin) rig.spin.rotation.z += safeDt * 34; // Reaper UAV rear pusher propeller
    } else if (k === "stealthbomber") {
      bob = Math.sin(nowSec * 2.0 + last.id) * 0.07;
      rig.body.position.y = alt + bob;
      const targetBank = Math.max(-0.38, Math.min(0.38, yawRate * 0.14));
      st.bank += (targetBank - st.bank) * (1 - Math.exp(-6.2 * safeDt));
      rig.body.rotation.z = st.bank;
      const targetPitch = 0.008 * (1 - m) - 0.02 * m;
      rig.body.rotation.x += (targetPitch - rig.body.rotation.x) * (1 - Math.exp(-6 * safeDt));

      // Smooth stealth translucency (subMats opacity 0.38) when cloaked (e.sub === true)
      const targetAlpha = last.sub ? 0.38 : 1.0;
      st.subAlpha += (targetAlpha - st.subAlpha) * Math.min(1, safeDt * 5.5);
      if (rig.subMats && st.matMode === "normal") {
        const isTrans = st.subAlpha < 0.98;
        for (const subMat of rig.subMats) {
          if (subMat.transparent !== isTrans) {
            subMat.transparent = isTrans;
            subMat.needsUpdate = true;
          }
          subMat.opacity = st.subAlpha;
        }
      }
    } else if (k === "hypersonic") {
      bob = Math.sin(nowSec * 5.2 + last.id) * 0.06;
      rig.body.position.y = alt + bob;
      const targetBank = Math.max(-0.78, Math.min(0.78, yawRate * 0.24));
      st.bank += (targetBank - st.bank) * (1 - Math.exp(-11 * safeDt));
      rig.body.rotation.z = st.bank;
      const targetPitch = 0.01 * (1 - m) + (-0.06 + Math.abs(st.bank) * 0.07) * m;
      rig.body.rotation.x += (targetPitch - rig.body.rotation.x) * (1 - Math.exp(-8.5 * safeDt));
    } else if (k === "chopper") {
      bob = Math.sin(nowSec * 3.2 + last.id) * 0.1 + Math.cos(nowSec * 5.6 + last.id) * 0.025;
      rig.body.position.y = alt + bob;
      const targetPitch = 0.015 * (1 - m) + Math.min(0.22, 0.08 + st.speed * 0.04) * m;
      rig.body.rotation.x += (targetPitch - rig.body.rotation.x) * (1 - Math.exp(-6.5 * safeDt));
      const targetBank = Math.max(-0.34, Math.min(0.34, yawRate * 0.11));
      st.bank += (targetBank - st.bank) * (1 - Math.exp(-7.5 * safeDt));
      rig.body.rotation.z = st.bank;
      if (rig.spin) rig.spin.rotation.y += safeDt * 28; // ultra-smooth high-speed 4-blade main rotor
      if (rig.spin2) rig.spin2.rotation.x += safeDt * 38; // enclosed fenestron tail rotor
    } else if (k === "bomber") {
      bob = Math.sin(nowSec * 2.2 + last.id) * 0.085;
      rig.body.position.y = alt + bob;
      const targetBank = Math.max(-0.4, Math.min(0.4, yawRate * 0.15));
      st.bank += (targetBank - st.bank) * (1 - Math.exp(-6.5 * safeDt));
      rig.body.rotation.z = st.bank;
      const targetPitch = 0.01 * (1 - m) - 0.025 * m;
      rig.body.rotation.x += (targetPitch - rig.body.rotation.x) * (1 - Math.exp(-6 * safeDt));
    } else if (k === "zeppelin") {
      // Majestic armored dirigible sway & counter-rotating twin side propellers
      bob = Math.sin(nowSec * 1.35 + last.id) * 0.16;
      rig.body.position.y = alt + bob;
      rig.body.rotation.z = Math.sin(nowSec * 0.95 + last.id) * 0.052 + Math.max(-0.08, Math.min(0.08, yawRate * 0.05));
      rig.body.rotation.x = Math.cos(nowSec * 0.8 + last.id) * 0.028 + 0.03 * m;
      if (rig.spin) rig.spin.rotation.z += safeDt * 16;
      if (rig.spin2) rig.spin2.rotation.z -= safeDt * 16;
    }

    // Subtle ground shadow breathing tied to hover altitude
    if (rig.shadow && rig.shadow.userData.baseShadowScale) {
      const baseSh = rig.shadow.userData.baseShadowScale as THREE.Vector3;
      const shScale = 1 - bob * 0.12;
      rig.shadow.scale.set(baseSh.x * shScale, 1, baseSh.z * shScale);
    }

    // Crisp white-cyan wingtip jet contrails (extra blazing white-cyan contrails for Mach-9 hypersonic!)
    if (
      emitContrail &&
      (k === "interceptor" || k === "bomber" || k === "uav" || k === "stealthbomber" || k === "hypersonic") &&
      moving &&
      vis.root.visible
    ) {
      st.contrailCd -= safeDt;
      if (st.contrailCd <= 0) {
        st.contrailCd =
          k === "hypersonic"
            ? 0.022
            : k === "interceptor"
              ? 0.042
              : k === "bomber"
                ? 0.055
                : k === "stealthbomber"
                  ? 0.06
                  : 0.062;
        const span =
          k === "stealthbomber"
            ? 1.32
            : k === "bomber"
              ? 1.28
              : k === "interceptor"
                ? 0.92
                : k === "hypersonic"
                  ? 0.86
                  : 0.78;
        const trailZ =
          k === "hypersonic" ? -0.64 : k === "bomber" ? -0.44 : k === "stealthbomber" ? -0.38 : k === "uav" ? -0.35 : -0.5;
        const cosH = Math.cos(headingRad);
        const sinH = Math.sin(headingRad);
        const cosB = Math.cos(st.bank);
        const sinB = Math.sin(st.bank);
        const cScale =
          k === "hypersonic"
            ? 1.36
            : k === "bomber"
              ? 1.15
              : k === "stealthbomber"
                ? last.sub
                  ? 0.62
                  : 1.05
                : k === "uav"
                  ? 0.65
                  : 0.88;
        for (const sx of [-1, 1]) {
          const lx = sx * span * cosB;
          const ly = sx * span * sinB;
          const wx = x + lx * sinH + trailZ * cosH;
          const wy = rig.body.position.y + ly;
          const wz = y - lx * cosH + trailZ * sinH;
          emitContrail(wx, wy, wz, cScale);
        }
        // Extra blazing central Mach-9 scramjet shock-cone contrail for hypersonic strike craft!
        if (k === "hypersonic") {
          emitContrail(x - 0.92 * cosH, rig.body.position.y, y - 0.92 * sinH, 1.55);
        }
      }
    }
  }

  // ---------- 5. Navy (Organic Ocean Swells, Naval Turrets, Submarine Dive & Wakes) ----------
  else if (k === "gunboat" || k === "destroyer" || k === "sub" || k === "dreadnought" || k === "carrier") {
    const heavyShip = k === "dreadnought" || k === "carrier";
    const wavePitch =
      Math.sin(nowSec * 2.0 + last.id) * (heavyShip ? 0.018 : 0.032) +
      Math.sin(nowSec * 3.3 + last.id * 2.1) * (heavyShip ? 0.008 : 0.014);
    const waveRoll =
      Math.cos(nowSec * 1.55 + last.id * 1.3) * (heavyShip ? 0.022 : 0.04) +
      Math.sin(nowSec * 2.6 + last.id * 0.7) * (heavyShip ? 0.009 : 0.016);

    if (k === "sub") {
      const targetY = last.sub ? -0.2 : 0.06;
      const prevSubY = st.subY;
      st.subY += (targetY - st.subY) * Math.min(1, safeDt * 4.2);
      const diveVel = (st.subY - prevSubY) / safeDt;
      const divePitch = Math.max(-0.22, Math.min(0.22, -diveVel * 0.35));

      const bob = last.sub
        ? Math.sin(nowSec * 1.35 + last.id) * 0.012
        : Math.sin(nowSec * 2.1 + last.id) * 0.026;
      rig.body.position.y = st.subY + bob;
      rig.body.rotation.x = wavePitch * (last.sub ? 0.42 : 1) + divePitch;
      rig.body.rotation.z = waveRoll * (last.sub ? 0.42 : 1);
      if (rig.spin) rig.spin.rotation.z += safeDt * (5 + 14 * m);

      // Smooth submerged stealth translucency on per-instance cloned sub materials
      const targetAlpha = last.sub ? 0.44 : 1.0;
      st.subAlpha += (targetAlpha - st.subAlpha) * Math.min(1, safeDt * 5.0);
      if (rig.subMats && st.matMode === "normal") {
        const isTrans = st.subAlpha < 0.98;
        for (const subMat of rig.subMats) {
          if (subMat.transparent !== isTrans) {
            subMat.transparent = isTrans;
            subMat.needsUpdate = true;
          }
          subMat.opacity = st.subAlpha;
        }
      }
    } else {
      const heave =
        Math.sin(nowSec * 2.15 + last.id) * (heavyShip ? 0.024 : 0.036) +
        Math.cos(nowSec * 3.1 + last.id * 1.7) * 0.01;
      const turnHeel = Math.max(-0.1, Math.min(0.1, yawRate * (k === "gunboat" ? 0.065 : 0.03)));
      st.roll += (turnHeel - st.roll) * (1 - Math.exp(-6 * safeDt));

      // Naval cannon/missile firing recoil rock
      const fireRock = st.hullKick > 0 ? Math.sin((1 - st.hullKick) * Math.PI * 1.4) * st.hullKick * (heavyShip ? 0.05 : 0.035) : 0;

      rig.body.position.y = 0.08 + heave;
      rig.body.rotation.x = wavePitch + (k === "gunboat" ? -0.065 : -0.022) * m - fireRock;
      rig.body.rotation.z = waveRoll + st.roll;

      if (rig.turret) {
        const hullYaw = Math.PI / 2 - headingRad;
        if (st.turretHold > 0) st.turretHold -= safeDt;
        else st.turretWorldYaw = hullYaw;
        const targetLocal = angleDiff(hullYaw, st.turretWorldYaw);
        const diff = angleDiff(rig.turret.rotation.y, targetLocal);
        rig.turret.rotation.y += diff * Math.min(1, safeDt * 10);
      }

      if (rig.recoil) {
        if (k === "dreadnought") {
          const baseZ = getBaseRecoilZ(rig.recoil, 0.46);
          const baseY = getBaseRecoilY(rig.recoil, 0.68);
          rig.recoil.position.z = baseZ - st.recoil * 0.24;
          rig.recoil.position.y = baseY - st.recoil * 0.1;
        } else {
          const baseZ = getBaseRecoilZ(rig.recoil, k === "destroyer" ? 0.24 : 0.18);
          rig.recoil.position.z = baseZ - st.recoil * 0.22;
        }
      }
      if (rig.spin) {
        rig.spin.rotation.y += safeDt * (heavyShip ? 1.25 : 2.0);
      }
    }

    // Smooth ocean bow-wave & stern wakes behind sailing vessels
    if (emitWake && moving && vis.root.visible) {
      st.wakeCd -= safeDt;
      if (st.wakeCd <= 0) {
        st.wakeCd = k === "gunboat" ? 0.13 : heavyShip ? 0.24 : 0.18;
        const cosH = Math.cos(headingRad);
        const sinH = Math.sin(headingRad);
        const sternOff =
          k === "carrier" ? 1.65 : k === "dreadnought" ? 1.42 : k === "destroyer" ? 1.08 : k === "sub" ? 0.96 : 0.74;
        const wakeScale =
          k === "carrier"
            ? 1.72
            : k === "dreadnought"
              ? 1.5
              : k === "destroyer"
                ? 1.1
                : k === "sub"
                  ? last.sub
                    ? 0.52
                    : 0.84
                  : 0.8;
        emitWake(x - cosH * sternOff, y - sinH * sternOff, wakeScale);
        // Subtle bow-wave crest for fast surface warships
        if (k !== "sub") {
          const bowOff = k === "carrier" ? 1.75 : k === "dreadnought" ? 1.55 : k === "destroyer" ? 1.25 : 0.85;
          emitWake(x + cosH * bowOff, y + sinH * bowOff, wakeScale * 0.56);
        }
      }
    }
  }

  // ---------- 6. Buildings Idle Loops & Low-Power Dimming ----------
  else if (isBuildingKind(k)) {
    const offlineDef =
      lowPower && (k === "turret" || k === "arc" || k === "sam" || k === "irondome" || k === "lasertower" || k === "satlink");
    const powerSpeed = lowPower ? 0.28 : 1.0;

    if ((k === "turret" || k === "sam" || k === "irondome" || k === "lasertower" || k === "satlink") && rig.turret) {
      if (!offlineDef) {
        const targetYaw = Math.PI / 2 - headingRad;
        const diff = angleDiff(rig.turret.rotation.y, targetYaw);
        rig.turret.rotation.y += diff * Math.min(1, safeDt * 12);
      }
      if (rig.recoil) {
        const baseZ = getBaseRecoilZ(rig.recoil, 0.26);
        rig.recoil.position.z = baseZ - st.recoil * 0.18;
      }
    }
    if (rig.spin) {
      const rate =
        (k === "superweapon" || k === "satlink"
          ? 1.6 + 0.55 * Math.sin(nowSec * 0.9)
          : k === "techlab" || k === "airfield" || k === "airfield2" || k === "irondome"
            ? 1.5
            : k === "shipyard" || k === "shipyard2" || k === "sam"
              ? 1.3
              : 0.95) * powerSpeed;
      rig.spin.rotation.y += safeDt * rate;
    }
    if (rig.spin2) {
      const rate2 = (k === "superweapon" || k === "satlink" ? 2.8 + 0.85 * Math.sin(nowSec * 1.4) : 1.95) * powerSpeed;
      rig.spin2.rotation.y -= safeDt * rate2;
    }
    if (rig.flag) {
      rig.flag.rotation.y = Math.sin(nowSec * 3.8 + last.id) * 0.24;
    }
    if (rig.crane) {
      if (k === "depot") rig.crane.position.x = Math.sin(nowSec * 1.1 + last.id) * 0.55;
      else if (k === "shipyard" || k === "shipyard2") rig.crane.position.z = 0.1 + Math.sin(nowSec * 0.85 + last.id) * 0.68;
      else if (k === "derrick") {
        const pumpSpeed = last.o >= 0 ? 2.45 : 1.15;
        rig.crane.rotation.x = Math.sin(nowSec * pumpSpeed + last.id) * 0.28;
      } else {
        rig.crane.rotation.y = Math.sin(nowSec * 0.65 + last.id) * 0.2;
      }
    }

    // Visual low-power dimming & slow offline pulse for powered buildings/defenses
    if (rig.powerGlow && st.matMode === "normal") {
      const dimmed =
        offlineDef ||
        (lowPower && (k === "radar" || k === "superweapon" || k === "techlab" || k === "sam" || k === "irondome" || k === "lasertower" || k === "satlink"));
      const dimFactor = dimmed ? 0.18 + 0.08 * Math.sin(nowSec * 2.4 + last.id) : 1.0;
      for (const gm of rig.powerGlow) {
        const mat = gm.material;
        const origCol = gm.userData.origColor as THREE.Color | undefined;
        const origEm = gm.userData.origEmissive as THREE.Color | undefined;
        if (mat instanceof THREE.MeshBasicMaterial && origCol) {
          mat.color.copy(origCol).multiplyScalar(dimFactor);
        } else if (mat instanceof THREE.MeshStandardMaterial) {
          if (origEm) mat.emissive.copy(origEm).multiplyScalar(dimmed ? dimFactor * 0.45 : 1.0);
          if (origCol) mat.color.copy(origCol).multiplyScalar(dimmed ? 0.58 : 1.0);
        }
      }
    }
  }

  // ---------- 7. Pulsing Energy Cores, Afterburners & Navigation Beacons ----------
  if (rig.pulse) {
    const offlinePulse =
      lowPower && (k === "turret" || k === "arc" || k === "radar" || k === "sam" || k === "irondome" || k === "lasertower" || k === "satlink");
    const isJetBurner =
      k === "interceptor" || k === "bomber" || k === "uav" || k === "stealthbomber" || k === "hypersonic";
    const freq = isJetBurner ? 18.0 : k === "superweapon" || k === "satlink" ? 5.2 : 3.6;
    const amp = isJetBurner ? 0.16 : k === "superweapon" || k === "satlink" ? 0.18 : 0.14;
    const s = offlinePulse
      ? 0.78 + 0.04 * Math.sin(nowSec * 2.4 + last.id)
      : 0.94 + amp * Math.sin(nowSec * freq + last.id);
    for (const p of rig.pulse) {
      const base = p.userData.baseScale as THREE.Vector3 | undefined;
      if (base) p.scale.set(base.x * s, base.y * s, base.z * s);
    }
  }

  // ---------- 8. Unified Material Override (Hit-Flash > Holographic Construction > Normal) ----------
  if (st.hitFlash > 0) {
    st.hitFlash = Math.max(0, st.hitFlash - safeDt);
  }
  const desiredMode: "normal" | "hit" | "holo" =
    st.hitFlash > 0 ? "hit" : holoConstruct ? "holo" : "normal";
  setBodyMatMode(rig.body, st, desiredMode);

  // ---------- 9. Damaged Smoke & Industrial Exhaust Emitter ----------
  if (emitSmoke && rig.smokePos && vis.root.visible) {
    const damaged = last.hp < last.mhp * 0.55;
    const isStack = k === "factory" || k === "factory2" || k === "refinery" || k === "power" || k === "coalplant";
    if (damaged || isStack) {
      st.smokeCd -= safeDt;
      if (st.smokeCd <= 0) {
        st.smokeCd = damaged ? 0.28 + Math.random() * 0.2 : 0.9 + Math.random() * 0.5;
        emitSmoke(x + rig.smokePos.x * 0.5, rig.smokePos.y, y + rig.smokePos.z * 0.5, damaged);
      }
    }
  }
}
