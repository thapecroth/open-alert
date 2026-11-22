import * as THREE from "three";
import type { EntSnap } from "../shared/protocol";
import type { EntVis } from "./models";
import { isBuildingKind } from "./util";

export interface AnimState {
  phase: number;
  speed: number;
  prevX: number;
  prevY: number;
  recoil: number;
  turretWorldYaw: number;
  turretHold: number;
  buildAge: number;
  isNewBuilding: boolean;
  smokeCd: number;
}

export function createAnimState(e: EntSnap, animateConstruct: boolean): AnimState {
  return {
    phase: (e.id * 1.37) % (Math.PI * 2),
    speed: 0,
    prevX: e.x,
    prevY: e.y,
    recoil: 0,
    turretWorldYaw: Math.PI / 2 - e.d / 10,
    turretHold: 0,
    buildAge: animateConstruct && isBuildingKind(e.k) ? 0 : 1,
    isNewBuilding: animateConstruct && isBuildingKind(e.k),
    smokeCd: 0.4 + ((e.id * 0.13) % 0.6),
  };
}

function angleDiff(a: number, b: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function triggerFireAnim(st: AnimState, fx: number, fy: number, tx: number, ty: number) {
  st.recoil = 1;
  const worldAngle = Math.PI / 2 - Math.atan2(ty - fy, tx - fx);
  st.turretWorldYaw = worldAngle;
  st.turretHold = 2.6;
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
) {
  const rig = vis.rig;
  const k = vis.kind;

  // Measure actual frame velocity for gait & suspension
  const dx = x - st.prevX;
  const dy = y - st.prevY;
  st.prevX = x;
  st.prevY = y;
  const instSpeed = dt > 0.0001 ? Math.hypot(dx, dy) / dt : 0;
  st.speed += (Math.min(6, instSpeed) - st.speed) * Math.min(1, dt * 12);
  const moving = st.speed > 0.12;

  // Decay recoil impulse smoothly
  if (st.recoil > 0.001) st.recoil = Math.max(0, st.recoil - dt * 5.2);
  else st.recoil = 0;

  // Construction rise-up for newly placed buildings
  if (st.isNewBuilding && st.buildAge < 1) {
    st.buildAge = Math.min(1, st.buildAge + dt * 2.2);
    const ease = 1 - Math.pow(1 - st.buildAge, 3);
    rig.body.scale.set(1, Math.max(0.08, ease), 1);
  } else if (isBuildingKind(k)) {
    rig.body.scale.set(1, 1, 1);
  }

  // ---------- Humanoid Infantry Animation ----------
  if (k === "infantry" || k === "engineer" || k === "rocket") {
    if (moving) {
      st.phase += dt * (7.5 + st.speed * 3.8);
      const s = Math.sin(st.phase);
      const stride = Math.min(1, st.speed * 0.9) * 0.7;
      if (rig.legL) rig.legL.rotation.x = s * stride;
      if (rig.legR) rig.legR.rotation.x = -s * stride;
      if (rig.armL) rig.armL.rotation.x = (k === "infantry" ? -0.45 : 0) - s * stride * 0.55;
      if (rig.armR) rig.armR.rotation.x = (k === "infantry" ? -0.55 : 0) + s * stride * 0.45;
      rig.body.position.y = Math.abs(Math.sin(st.phase)) * 0.055;
      rig.body.rotation.x = 0.1;
    } else {
      st.phase += dt * 2.2;
      const idle = Math.sin(st.phase) * 0.015;
      if (rig.legL) rig.legL.rotation.x *= Math.max(0, 1 - dt * 10);
      if (rig.legR) rig.legR.rotation.x *= Math.max(0, 1 - dt * 10);
      if (rig.armL) rig.armL.rotation.x += ((k === "infantry" ? -0.45 : 0) - rig.armL.rotation.x) * Math.min(1, dt * 8);
      if (rig.armR) rig.armR.rotation.x += ((k === "infantry" ? -0.55 : 0) - rig.armR.rotation.x) * Math.min(1, dt * 8);
      rig.body.position.y = idle;
      rig.body.rotation.x *= Math.max(0, 1 - dt * 8);
      if (rig.head) rig.head.rotation.y = Math.sin(st.phase * 0.6) * 0.25;
    }
    if (rig.recoil) {
      rig.recoil.position.z = (k === "infantry" ? 0.15 : 0) - st.recoil * 0.12;
    }
  }

  // ---------- Spider Drone 4-Leg Skitter Gait ----------
  else if (k === "spider" && rig.spiderLegs) {
    if (moving) {
      st.phase += dt * (11 + st.speed * 5.2);
      rig.body.position.y = 0.03 + Math.abs(Math.sin(st.phase * 2)) * 0.04;
    } else {
      st.phase += dt * 2.5;
      rig.body.position.y = Math.sin(st.phase) * 0.018;
    }
    const amp = moving ? 0.42 : 0.06;
    rig.spiderLegs.forEach((leg, idx) => {
      const diag = idx === 0 || idx === 3 ? 0 : Math.PI;
      const wave = Math.sin(st.phase + diag);
      leg.rotation.y = wave * amp;
      leg.rotation.z = Math.max(0, Math.cos(st.phase + diag)) * amp * 0.45 * (idx % 2 === 0 ? 1 : -1);
    });
    if (st.recoil > 0) {
      rig.body.position.z = st.recoil * 0.18;
    } else {
      rig.body.position.z = 0;
    }
  }

  // ---------- Tracked / Wheeled Vehicles ----------
  else if (k === "tank" || k === "heavy" || k === "arty" || k === "harvester") {
    if (moving) {
      st.phase += dt * (8 + st.speed * 3);
      rig.body.position.y = Math.abs(Math.sin(st.phase)) * 0.024;
      rig.body.rotation.x = -0.025 + Math.sin(st.phase * 0.5) * 0.015;
    } else {
      rig.body.position.y = Math.sin(nowSec * 6 + last.id) * 0.005; // engine idle hum
      rig.body.rotation.x *= Math.max(0, 1 - dt * 8);
    }

    // Independent turret yaw tracking (tanks & heavy tanks)
    if (rig.turret) {
      const hullYaw = Math.PI / 2 - headingRad;
      if (st.turretHold > 0) {
        st.turretHold -= dt;
      } else {
        st.turretWorldYaw = hullYaw;
      }
      const targetLocal = angleDiff(hullYaw, st.turretWorldYaw);
      const diff = angleDiff(rig.turret.rotation.y, targetLocal);
      rig.turret.rotation.y += diff * Math.min(1, dt * 10);
    }

    // Barrel / launcher recoil kickback
    if (rig.recoil) {
      if (k === "arty") {
        rig.recoil.position.z = -0.26 - st.recoil * 0.24;
      } else {
        const baseZ = k === "heavy" ? 0.42 : 0.35;
        rig.recoil.position.z = baseZ - st.recoil * 0.28;
      }
    }

    // Harvester rotating front ore scoop drum (spins faster while mining/moving)
    if (k === "harvester" && rig.spin) {
      const spinRate = moving ? 6.5 : (last.cargo ?? 0) > 0 && (last.cargo ?? 0) < 40 ? 9.0 : 1.8;
      rig.spin.rotation.x += dt * spinRate;
    }
  }

  // ---------- Buildings Idle Loops ----------
  else if (isBuildingKind(k)) {
    if (k === "turret" && rig.turret) {
      const targetYaw = Math.PI / 2 - headingRad;
      const diff = angleDiff(rig.turret.rotation.y, targetYaw);
      rig.turret.rotation.y += diff * Math.min(1, dt * 12);
      if (rig.recoil) rig.recoil.position.z = 0.26 - st.recoil * 0.16;
    }
    if (rig.spin) rig.spin.rotation.y += dt * (k === "techlab" ? 1.4 : 0.9);
    if (rig.spin2) rig.spin2.rotation.y -= dt * 1.9;
    if (rig.flag) {
      rig.flag.rotation.y = Math.sin(nowSec * 3.8 + last.id) * 0.22;
    }
    if (rig.crane) {
      if (k === "depot") rig.crane.position.x = Math.sin(nowSec * 1.1 + last.id) * 0.55;
      else rig.crane.rotation.y = Math.sin(nowSec * 0.65 + last.id) * 0.18;
    }
  }

  // Subtle energy core / beacon breathing pulse (relative to each mesh's authored baseScale)
  if (rig.pulse) {
    const s = 0.92 + 0.14 * Math.sin(nowSec * 3.6 + last.id);
    for (const p of rig.pulse) {
      const base = p.userData.baseScale as THREE.Vector3 | undefined;
      if (base) p.scale.set(base.x * s, base.y * s, base.z * s);
    }
  }

  // Damaged smoke & industrial exhaust emitter
  if (emitSmoke && rig.smokePos && vis.root.visible) {
    const damaged = last.hp < last.mhp * 0.55;
    const isStack = k === "factory" || k === "factory2" || k === "refinery" || k === "power";
    if (damaged || isStack) {
      st.smokeCd -= dt;
      if (st.smokeCd <= 0) {
        st.smokeCd = damaged ? 0.28 + Math.random() * 0.2 : 0.9 + Math.random() * 0.5;
        emitSmoke(x + rig.smokePos.x * 0.5, rig.smokePos.y, y + rig.smokePos.z * 0.5, damaged);
      }
    }
  }
}
