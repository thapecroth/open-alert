import * as THREE from "three";
import type { CrateSnap, EntSnap, GameEvent, OrderKind, PlayerState } from "../shared/protocol";
import {
  UNITS,
  SUPPLY_HUB_RADIUS,
  SUPPLY_TRUCK_RADIUS,
  type CrateKind,
  type UnitKind,
} from "../shared/gamedefs";
import { makeEntVis, makeCrateVis, setVetBadge, tagEntity, applyFacing, EntVis, CrateVis } from "./models";
import { createAnimState, stepEntityAnim, triggerFireAnim, triggerHitFlash, AnimState } from "./anim";
import { VfxSystem, WaypointOverlay } from "./vfx";
import { isBuildingKind } from "./util";
import { GameScene } from "./scene";

const INTERP_MS = 250; // 50ms WAN jitter cushion above 200ms (5 Hz) snapshot interval
const SNAP_KEEP = 8;
const MAX_EXTRAP_T = 1.38;
const EXTRAP_DAMP = 0.72;
const SNAP_JUMP_DIST_SQ = 16; // snap visual filter if jump > 4 tiles

const CRATE_POPUP_COLORS: Record<CrateKind, string> = {
  cash: "#ffd84d",
  vet: "#48ecff",
  heal: "#46f080",
  unit: "#ff6e45",
};

interface Snap {
  recv: number;
  ents: Map<number, EntSnap>;
}

interface LogBars {
  group: THREE.Group;
  barW: number;
  fuelBg: THREE.Sprite;
  fuelFg: THREE.Sprite;
  ammoBg: THREE.Sprite;
  ammoFg: THREE.Sprite;
}

interface Tracked {
  vis: EntVis;
  last: EntSnap;
  anim: AnimState;
  visX: number;
  visY: number;
  visYaw: number;
  holdInd?: THREE.Group;
  supplyAura?: THREE.Group;
  logBars?: LogBars;
  lastResupplyFxMs: number;
  isBuilding: boolean;
  isStaticBld: boolean;
  staticFrozen: boolean;
  lastLowPower: boolean;
}

function isStaticBuildingRig(vis: EntVis): boolean {
  const r = vis.rig;
  return !r.crane && !r.spin && !r.spin2 && !r.flag && !r.turret && !r.pulse?.length;
}

function freezeStaticBuilding(vis: EntVis): void {
  vis.rig.body.scale.set(1, 1, 1);
  vis.root.updateMatrix();
  vis.root.updateMatrixWorld(true);
  vis.root.matrixAutoUpdate = false;
  vis.rig.body.traverse((o) => {
    o.matrixAutoUpdate = false;
  });
}

// Shared Hold Position indicator assets (zero per-unit GPU leaks)
const holdRingGeo = new THREE.RingGeometry(0.46, 0.56, 8);
holdRingGeo.rotateX(-Math.PI / 2);
const holdRingMat = new THREE.MeshBasicMaterial({
  color: 0xffc83d,
  transparent: true,
  opacity: 0.82,
  side: THREE.DoubleSide,
  depthWrite: false,
});
let holdBadgeMat: THREE.SpriteMaterial | null = null;

function getHoldBadgeMat(): THREE.SpriteMaterial {
  if (holdBadgeMat) return holdBadgeMat;
  const S = 64;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, S, S);

  // Crisp tactical amber shield silhouette
  ctx.beginPath();
  ctx.moveTo(S * 0.5, S * 0.08);
  ctx.lineTo(S * 0.88, S * 0.22);
  ctx.lineTo(S * 0.82, S * 0.62);
  ctx.quadraticCurveTo(S * 0.5, S * 0.94, S * 0.5, S * 0.94);
  ctx.quadraticCurveTo(S * 0.5, S * 0.94, S * 0.18, S * 0.62);
  ctx.lineTo(S * 0.12, S * 0.22);
  ctx.closePath();
  ctx.fillStyle = "rgba(18, 22, 28, 0.92)";
  ctx.fill();
  ctx.lineWidth = 4.5;
  ctx.strokeStyle = "#ffc83d";
  ctx.stroke();

  // Bold 'H' hold-position glyph
  ctx.fillStyle = "#ffe28a";
  ctx.font = "900 30px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("H", S * 0.5, S * 0.52);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  holdBadgeMat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    opacity: 0.96,
    depthTest: false,
    depthWrite: false,
  });
  return holdBadgeMat;
}

function makeHoldIndicator(topY: number): THREE.Group {
  const g = new THREE.Group();
  g.userData.isBar = true;

  const ring = new THREE.Mesh(holdRingGeo, holdRingMat);
  ring.position.y = 0.062;
  ring.renderOrder = 6;
  ring.userData.isBar = true;
  g.add(ring);

  const badge = new THREE.Sprite(getHoldBadgeMat());
  badge.position.set(0, topY + 0.62, 0);
  badge.scale.set(0.32, 0.32, 1);
  badge.renderOrder = 23;
  badge.userData.isBar = true;
  g.userData.badge = badge;
  g.add(badge);

  return g;
}

// Shared Supply Aura assets for Forward Supply Hub & Mobile Supply Truck (zero per-entity GPU leaks)
const supplyHubAuraRingGeo = new THREE.RingGeometry(SUPPLY_HUB_RADIUS - 0.16, SUPPLY_HUB_RADIUS, 72);
supplyHubAuraRingGeo.rotateX(-Math.PI / 2);
const supplyHubAuraFillGeo = new THREE.CircleGeometry(SUPPLY_HUB_RADIUS - 0.16, 72);
supplyHubAuraFillGeo.rotateX(-Math.PI / 2);

const supplyTruckAuraRingGeo = new THREE.RingGeometry(SUPPLY_TRUCK_RADIUS - 0.14, SUPPLY_TRUCK_RADIUS, 56);
supplyTruckAuraRingGeo.rotateX(-Math.PI / 2);
const supplyTruckAuraFillGeo = new THREE.CircleGeometry(SUPPLY_TRUCK_RADIUS - 0.14, 56);
supplyTruckAuraFillGeo.rotateX(-Math.PI / 2);

const supplyAuraRingMat = new THREE.MeshBasicMaterial({
  color: 0x3ef088,
  transparent: true,
  opacity: 0.42,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const supplyAuraFillMat = new THREE.MeshBasicMaterial({
  color: 0x22d46c,
  transparent: true,
  opacity: 0.075,
  side: THREE.DoubleSide,
  depthWrite: false,
});

function makeSupplyAura(kind: "supplyhub" | "supplytruck"): THREE.Group {
  const g = new THREE.Group();
  g.visible = false;
  g.userData.isBar = true;

  const isHub = kind === "supplyhub";
  const ring = new THREE.Mesh(isHub ? supplyHubAuraRingGeo : supplyTruckAuraRingGeo, supplyAuraRingMat);
  ring.position.y = 0.056;
  ring.renderOrder = 5;
  ring.userData.isBar = true;
  g.add(ring);

  const fill = new THREE.Mesh(isHub ? supplyHubAuraFillGeo : supplyTruckAuraFillGeo, supplyAuraFillMat);
  fill.position.y = 0.052;
  fill.renderOrder = 4;
  fill.userData.isBar = true;
  g.add(fill);

  return g;
}

// Shared Fuel / Ammo / Supply-Reserve micro-bar materials (zero per-entity GPU leaks)
const logBarBgMat = new THREE.SpriteMaterial({ color: 0x0b1016, transparent: true, opacity: 0.78, depthTest: false });
const logFuelOkMat = new THREE.SpriteMaterial({ color: 0xf4b63d, transparent: true, opacity: 0.94, depthTest: false });
const logFuelLowMat = new THREE.SpriteMaterial({ color: 0xff4938, transparent: true, opacity: 0.98, depthTest: false });
const logAmmoOkMat = new THREE.SpriteMaterial({ color: 0x45d8ff, transparent: true, opacity: 0.94, depthTest: false });
const logAmmoLowMat = new THREE.SpriteMaterial({ color: 0xff5a36, transparent: true, opacity: 0.98, depthTest: false });
const logCargoMat = new THREE.SpriteMaterial({ color: 0x38e882, transparent: true, opacity: 0.95, depthTest: false });

function makeLogBars(topY: number, barW: number): LogBars {
  const group = new THREE.Group();
  group.userData.isBar = true;

  const mk = (mat: THREE.SpriteMaterial, y: number, order: number) => {
    const s = new THREE.Sprite(mat);
    s.position.set(0, y, 0);
    s.scale.set(barW, 0.055, 1);
    s.renderOrder = order;
    s.visible = false;
    s.userData.isBar = true;
    group.add(s);
    return s;
  };

  const fuelBg = mk(logBarBgMat, topY + 0.27, 20);
  const fuelFg = mk(logFuelOkMat, topY + 0.27, 21);
  const ammoBg = mk(logBarBgMat, topY + 0.2, 20);
  const ammoFg = mk(logAmmoOkMat, topY + 0.2, 21);
  return { group, barW, fuelBg, fuelFg, ammoBg, ammoFg };
}

export class Renderer {
  tracked = new Map<number, Tracked>();
  crates = new Map<number, CrateSnap>();
  snaps: Snap[] = [];
  selection = new Set<number>();
  slotColors = new Map<number, string>();
  onOwnerLost?: (id: number) => void;

  private vfx: VfxSystem;
  private waypoints: WaypointOverlay;
  private crateVis = new Map<number, CrateVis>();
  private seen = new Set<number>();
  private hasInitialSnap = false;
  private swShakeTimers: ReturnType<typeof setTimeout>[] = [];
  private lastAllies?: Set<number>;
  private lastVisSlot = -1;
  private playerLowPower = new Map<number, boolean>();
  private hiddenEntityId: number | null = null;

  // Bound VFX emitter callbacks & scratch buffers (zero per-frame allocations)
  private readonly emitSmoke: (x: number, y: number, z: number, dark: boolean) => void;
  private readonly emitWake: (x: number, z: number, scale?: number) => void;
  private readonly emitDust: (x: number, z: number, scale?: number) => void;
  private readonly emitContrail: (x: number, y: number, z: number, scale?: number) => void;
  private readonly scratchVec = new THREE.Vector3();
  private readonly scratchPos = { x: 0, y: 0, d: 0 };
  private readonly scratchWin: { a: Snap | null; b: Snap | null; t: number } = { a: null, b: null, t: 0 };
  private readonly wpEntries: { x: number; y: number; wp: [number, number, OrderKind][] }[] = [];
  private readonly wpEntryPool: { x: number; y: number; wp: [number, number, OrderKind][] }[] = [];
  private readonly rallyEntries: { x: number; y: number; rx: number; ry: number }[] = [];
  private readonly rallyEntryPool: { x: number; y: number; rx: number; ry: number }[] = [];

  constructor(private gs: GameScene) {
    this.vfx = new VfxSystem(gs.scene);
    this.waypoints = new WaypointOverlay(gs.scene);
    this.emitSmoke = (x, y, z, dark) => this.vfx.spawnSmoke(x, y, z, dark);
    this.emitWake = (x, z, scale) => this.vfx.spawnWake(x, z, scale);
    this.emitDust = (x, z, scale) => this.vfx.spawnDust(x, z, scale);
    this.emitContrail = (x, y, z, scale) => this.vfx.spawnContrail(x, y, z, scale);
  }

  setPlayerPower(players: Record<number, PlayerState>): void {
    this.playerLowPower.clear();
    for (const [key, p] of Object.entries(players)) {
      if (!p) continue;
      this.playerLowPower.set(p.slot ?? Number(key), Boolean(p.lowPower));
    }
  }

  private disposeVis(vis: EntVis) {
    if (vis.rig.subMats) {
      for (const m of vis.rig.subMats) m.dispose();
    }
    if (vis.rig.powerGlow) {
      for (const gm of vis.rig.powerGlow) {
        const m = (gm.userData._origMat as THREE.Material | THREE.Material[] | undefined) ?? gm.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m.dispose();
      }
    }
    (vis.ring.material as THREE.Material).dispose();
    (vis.barBg.material as THREE.Material).dispose();
    (vis.barFg.material as THREE.Material).dispose();
    (vis.vetBadge.material as THREE.Material).dispose();
  }

  reset() {
    const scene = this.gs.scene;
    for (const t of this.tracked.values()) {
      scene.remove(t.vis.root);
      this.disposeVis(t.vis);
    }
    this.tracked.clear();
    for (const cv of this.crateVis.values()) {
      scene.remove(cv.root);
      (cv.ring.material as THREE.Material).dispose();
      (cv.beacon.material as THREE.Material).dispose();
    }
    this.crateVis.clear();
    this.crates.clear();
    this.gs.pickables.length = 0;
    this.snaps = [];
    this.selection.clear();
    this.seen.clear();
    this.hasInitialSnap = false;
    this.lastAllies = undefined;
    this.lastVisSlot = -1;
    this.hiddenEntityId = null;
    this.playerLowPower.clear();
    for (const tm of this.swShakeTimers) clearTimeout(tm);
    this.swShakeTimers = [];
    this.vfx.clear();
    this.waypoints.clear();
    this.gs.resetFog();
    this.gs.setBuildZones(null);
  }

  pushSnap(ents: EntSnap[], crates?: CrateSnap[]) {
    const map = new Map<number, EntSnap>();
    for (const e of ents) map.set(e.id, e);
    this.snaps.push({ recv: performance.now(), ents: map });
    if (this.snaps.length > SNAP_KEEP) this.snaps.shift();

    const scene = this.gs.scene;
    // Remove gone entities
    for (const [id, t] of this.tracked) {
      if (!map.has(id)) {
        scene.remove(t.vis.root);
        this.disposeVis(t.vis);
        const i = this.gs.pickables.indexOf(t.vis.root);
        if (i >= 0) this.gs.pickables.splice(i, 1);
        this.tracked.delete(id);
        this.selection.delete(id);
      }
    }
    // Create new entities
    for (const e of ents) {
      if (this.tracked.has(e.id)) continue;
      const color = this.slotColors.get(e.o) ?? "#888888";
      const vis = makeEntVis(e.k, color, scene);
      const isBuilding = isBuildingKind(e.k);
      vis.root.position.set(e.x, 0, e.y);
      if (!isBuilding) applyFacing(vis.root, e.d / 10);
      setVetBadge(vis, e.vet ?? 0);
      tagEntity(vis.root, e.id);
      if (e.id === this.hiddenEntityId) vis.root.visible = false;
      scene.add(vis.root);
      this.gs.pickables.push(vis.root);
      const anim = createAnimState(e, this.hasInitialSnap);
      const isStaticBld = isBuilding && isStaticBuildingRig(vis);
      let supplyAura: THREE.Group | undefined;
      if (e.k === "supplyhub" || e.k === "supplytruck") {
        supplyAura = makeSupplyAura(e.k);
        vis.root.add(supplyAura);
      }
      this.tracked.set(e.id, {
        vis,
        last: e,
        anim,
        visX: e.x,
        visY: e.y,
        visYaw: e.d / 10,
        supplyAura,
        lastResupplyFxMs: 0,
        isBuilding,
        isStaticBld,
        staticFrozen: false,
        lastLowPower: false,
      });
    }
    this.hasInitialSnap = true;

    // Sync battlefield supply crates (backward compatible when omitted)
    if (crates !== undefined) {
      const nextCrates = new Map<number, CrateSnap>();
      for (const c of crates) nextCrates.set(c.id, c);

      for (const [id, cv] of this.crateVis) {
        if (!nextCrates.has(id)) {
          scene.remove(cv.root);
          (cv.ring.material as THREE.Material).dispose();
          (cv.beacon.material as THREE.Material).dispose();
          this.crateVis.delete(id);
          this.crates.delete(id);
        }
      }
      for (const c of crates) {
        this.crates.set(c.id, c);
        if (!this.crateVis.has(c.id)) {
          const cv = makeCrateVis(c.kind);
          cv.root.position.set(c.x, 0, c.y);
          scene.add(cv.root);
          this.crateVis.set(c.id, cv);
        } else {
          this.crateVis.get(c.id)!.root.position.set(c.x, 0, c.y);
        }
      }
    }

    // Prune selection to living entities
    for (const id of this.selection) if (!this.tracked.has(id)) this.selection.delete(id);
    this.updateBars(map);
  }

  private updateLogBars(t: Tracked, e: EntSnap, selected: boolean) {
    if (t.isBuilding) return;
    const isSupplyTruck = e.k === "supplytruck";
    const hasFuel = e.fl !== undefined;
    const hasAmmo = e.am !== undefined;
    if (!isSupplyTruck && !hasFuel && !hasAmmo) {
      if (t.logBars) t.logBars.group.visible = false;
      return;
    }

    if (!t.logBars) {
      const w = (t.vis.barFg.userData.w as number | undefined) ?? 0.96;
      t.logBars = makeLogBars(t.vis.topY, w);
      t.vis.root.add(t.logBars.group);
    }

    const lb = t.logBars;
    const w = lb.barW;

    if (isSupplyTruck) {
      const cap = UNITS.supplytruck.capacity ?? 500;
      const frac = Math.max(0, Math.min(1, (e.cargo ?? 0) / Math.max(1, cap)));
      const showCargo = selected || frac < 0.99;
      lb.group.visible = showCargo;
      lb.fuelBg.visible = showCargo;
      lb.fuelFg.visible = showCargo;
      lb.ammoBg.visible = false;
      lb.ammoFg.visible = false;
      if (showCargo) {
        lb.fuelFg.material = frac <= 0.15 ? logFuelLowMat : logCargoMat;
        lb.fuelFg.scale.x = Math.max(0.02, frac * w);
      }
      return;
    }

    const fuel = e.fl ?? 100;
    const ammo = e.am ?? 100;
    const showFuel = hasFuel && (selected || fuel <= 25);
    const showAmmo = hasAmmo && (selected || ammo <= 20);
    lb.group.visible = showFuel || showAmmo;

    lb.fuelBg.visible = showFuel;
    lb.fuelFg.visible = showFuel;
    if (showFuel) {
      const frac = Math.max(0, Math.min(1, fuel / 100));
      lb.fuelFg.material = fuel <= 25 ? logFuelLowMat : logFuelOkMat;
      lb.fuelFg.scale.x = Math.max(0.02, frac * w);
    }

    lb.ammoBg.visible = showAmmo;
    lb.ammoFg.visible = showAmmo;
    if (showAmmo) {
      const frac = Math.max(0, Math.min(1, ammo / 100));
      const yPos = showFuel ? t.vis.topY + 0.2 : t.vis.topY + 0.27;
      lb.ammoBg.position.y = yPos;
      lb.ammoFg.position.y = yPos;
      lb.ammoFg.material = ammo <= 20 ? logAmmoLowMat : logAmmoOkMat;
      lb.ammoFg.scale.x = Math.max(0.02, frac * w);
    }
  }

  private updateBars(map: Map<number, EntSnap>) {
    const nowMs = performance.now();
    for (const [id, t] of this.tracked) {
      const e = map.get(id);
      if (!e) continue;
      const ownerChanged = t.last.o !== e.o;
      const kindChanged = t.last.k !== e.k;
      const prevLast = t.last;
      if (ownerChanged || kindChanged) {
        // Ownership changed (capture) OR kind changed (factory -> factory2 upgrade) — rebuild visual!
        const scene = this.gs.scene;
        const wasVisible = t.vis.root.visible;
        scene.remove(t.vis.root);
        this.disposeVis(t.vis);
        const i = this.gs.pickables.indexOf(t.vis.root);
        if (i >= 0) this.gs.pickables.splice(i, 1);
        const color = this.slotColors.get(e.o) ?? "#888888";
        const vis = makeEntVis(e.k, color, scene);
        vis.root.position.copy(t.vis.root.position);
        vis.root.rotation.y = t.vis.root.rotation.y;
        vis.root.visible = id === this.hiddenEntityId ? false : wasVisible;
        tagEntity(vis.root, e.id);
        scene.add(vis.root);
        this.gs.pickables.push(vis.root);
        t.vis = vis;
        t.holdInd = undefined;
        t.logBars = undefined;
        t.supplyAura = undefined;
        if (e.k === "supplyhub" || e.k === "supplytruck") {
          t.supplyAura = makeSupplyAura(e.k);
          vis.root.add(t.supplyAura);
        }
        t.anim.flashing = false;
        t.anim.hitFlash = 0;
        t.anim.matMode = "normal";
        t.isBuilding = isBuildingKind(e.k);
        t.isStaticBld = t.isBuilding && isStaticBuildingRig(vis);
        t.staticFrozen = false;
        t.lastLowPower = false;
        if (ownerChanged) {
          this.selection.delete(id);
          this.onOwnerLost?.(id);
        } else {
          // Keep selection ring & supply aura active across upgrade
          const sel = this.selection.has(id);
          t.vis.ring.visible = sel;
          if (t.supplyAura) t.supplyAura.visible = sel;
        }
      } else if (t.vis.root.visible && nowMs - t.lastResupplyFxMs >= 1350) {
        // Trigger subtle emerald resupply shimmer when fuel, ammo, or convoy cargo refills
        const fuelGain = (e.fl ?? 100) - (prevLast.fl ?? 100);
        const ammoGain = (e.am ?? 100) - (prevLast.am ?? 100);
        const truckGain = e.k === "supplytruck" ? (e.cargo ?? 0) - (prevLast.cargo ?? 0) : 0;
        if (fuelGain >= 6 || ammoGain >= 10 || truckGain >= 25) {
          this.vfx.spawnResupplyPulse(t.visX, t.visY, t.isBuilding ? 1.4 : 0.88);
          t.lastResupplyFxMs = nowMs;
        }
      }
      t.last = e;
      const selected = this.selection.has(id);
      const frac = Math.max(0, e.hp / e.mhp);
      t.vis.barFg.scale.x = Math.max(0.02, frac * t.vis.barFg.userData.w);
      const c = frac > 0.6 ? 0x26e050 : frac > 0.3 ? 0xf0cc26 : 0xe52626;
      (t.vis.barFg.material as THREE.SpriteMaterial).color.setHex(c);
      const show = frac < 1 || selected;
      t.vis.barBg.visible = show;
      t.vis.barFg.visible = show;
      setVetBadge(t.vis, e.vet ?? 0);
      if (t.vis.bin) {
        const cap = !t.isBuilding ? (UNITS[e.k as UnitKind]?.capacity ?? 45) : 45;
        t.vis.bin.scale.y = Math.max(0.05, Math.min(1, (e.cargo ?? 0) / Math.max(1, cap)));
      }
      if (t.supplyAura) {
        t.supplyAura.visible = selected;
      }
      this.updateLogBars(t, e, selected);

      // Hold Position stance indicator (ground amber anchor ring + centered shield badge)
      const holding = Boolean(e.hold) && !t.isBuilding;
      if (holding && !t.holdInd) {
        t.holdInd = makeHoldIndicator(t.vis.topY);
        t.vis.root.add(t.holdInd);
      }
      if (t.holdInd) {
        t.holdInd.visible = holding;
        const badge = t.holdInd.userData.badge as THREE.Sprite | undefined;
        if (badge) badge.position.y = t.vis.topY + ((e.vet ?? 0) > 0 ? 0.86 : 0.62);
      }
    }
  }

  setSelected(ids: Set<number>) {
    this.selection = ids;
    for (const [id, t] of this.tracked) {
      const sel = ids.has(id);
      t.vis.ring.visible = sel;
      if (t.supplyAura) t.supplyAura.visible = sel;
      this.updateLogBars(t, t.last, sel);
    }
  }

  setHiddenEntity(id: number | null): void {
    const prev = this.hiddenEntityId;
    this.hiddenEntityId = id;
    if (prev !== null && prev !== id) {
      const prevT = this.tracked.get(prev);
      if (prevT) prevT.vis.root.visible = true;
    }
    if (id !== null) {
      const nextT = this.tracked.get(id);
      if (nextT) nextT.vis.root.visible = false;
    }
    if (this.lastVisSlot >= 0) {
      this.applyVisibility(this.lastVisSlot, this.lastAllies);
    }
  }

  getEntityWorldPos(id: number): { x: number; y: number; d: number } | null {
    const t = this.tracked.get(id);
    if (t) return { x: t.visX, y: t.visY, d: t.visYaw };
    return this.framePos(id);
  }

  private resolveInterpWindow(nowMs: number): boolean {
    const n = this.snaps.length;
    if (n === 0) return false;
    const win = this.scratchWin;
    if (n === 1) {
      win.a = this.snaps[0];
      win.b = this.snaps[0];
      win.t = 0;
      return true;
    }
    const rt = nowMs - INTERP_MS;
    if (rt <= this.snaps[0].recv) {
      win.a = this.snaps[0];
      win.b = this.snaps[1];
      win.t = 0;
      return true;
    }
    let a = this.snaps[0];
    let b = this.snaps[1];
    for (let i = n - 1; i > 0; i--) {
      if (this.snaps[i - 1].recv <= rt) {
        a = this.snaps[i - 1];
        b = this.snaps[i];
        break;
      }
    }
    const span = Math.max(1, b.recv - a.recv);
    const rawT = (rt - a.recv) / span;
    win.a = a;
    win.b = b;
    // Smoothly extrapolate with velocity damping if the latest snapshot is slightly late over WAN
    win.t =
      rawT <= 0
        ? 0
        : rawT <= 1
          ? rawT
          : Math.min(MAX_EXTRAP_T, 1 + (rawT - 1) * EXTRAP_DAMP);
    return true;
  }

  private framePosInto(
    id: number,
    a: Snap,
    b: Snap,
    interpT: number,
    out: { x: number; y: number; d: number },
  ): boolean {
    const ea = a.ents.get(id);
    const eb = b.ents.get(id);
    if (!ea && !eb) return false;
    if (!ea) {
      out.x = eb!.x;
      out.y = eb!.y;
      out.d = eb!.d / 10;
      return true;
    }
    if (!eb) {
      out.x = ea.x;
      out.y = ea.y;
      out.d = ea.d / 10;
      return true;
    }
    const dx = eb.x - ea.x;
    const dy = eb.y - ea.y;
    const moveT = interpT > 1 && dx * dx + dy * dy > SNAP_JUMP_DIST_SQ ? 1 : interpT;
    const dirT = Math.min(1, interpT);
    let dd = eb.d - ea.d;
    if (dd > Math.PI * 10) dd -= Math.PI * 20;
    if (dd < -Math.PI * 10) dd += Math.PI * 20;
    out.x = ea.x + dx * moveT;
    out.y = ea.y + dy * moveT;
    out.d = (ea.d + dd * dirT) / 10;
    return true;
  }

  private framePos(id: number): { x: number; y: number; d: number } | null {
    if (!this.resolveInterpWindow(performance.now())) return null;
    const win = this.scratchWin;
    const out = { x: 0, y: 0, d: 0 };
    return this.framePosInto(id, win.a!, win.b!, win.t, out) ? out : null;
  }

  update(dt = 0.016) {
    const nowMs = performance.now();
    const nowSec = nowMs / 1000;
    const safeDt = Math.max(0.0005, Math.min(0.1, dt));

    this.wpEntries.length = 0;
    this.rallyEntries.length = 0;

    // Resolve snapshot interpolation/extrapolation window ONCE per frame instead of per entity
    const hasWindow = this.resolveInterpWindow(nowMs);
    const snapA = hasWindow ? this.scratchWin.a : null;
    const snapB = hasWindow ? this.scratchWin.b : null;
    const interpT = hasWindow ? this.scratchWin.t : 0;

    // Frame-rate independent exponential visual smoothing gains
    const posAlpha = 1 - Math.exp(-22 * safeDt);
    const yawAlpha = 1 - Math.exp(-16 * safeDt);

    const pos = this.scratchPos;

    if (snapA && snapB) {
      for (const [id, t] of this.tracked) {
        const lowPwr = this.playerLowPower.get(t.last.o) === true;

        // Fast-path & static matrix freezing for settled buildings with no moving sub-parts
        let px: number;
        let py: number;
        if (
          t.isStaticBld &&
          (!t.anim.isNewBuilding || t.anim.buildAge >= 1) &&
          t.anim.hitFlash <= 0 &&
          t.anim.matMode === "normal"
        ) {
          px = t.last.x;
          py = t.last.y;
          t.visX = px;
          t.visY = py;
          t.visYaw = t.last.d / 10;
          if (!t.staticFrozen) {
            t.vis.root.position.set(px, 0, py);
            freezeStaticBuilding(t.vis);
            t.staticFrozen = true;
          } else if (t.vis.root.position.x !== px || t.vis.root.position.z !== py) {
            t.vis.root.position.set(px, 0, py);
            t.vis.root.updateMatrix();
            t.vis.root.updateMatrixWorld(true);
          }

          const hasPowerGlow = Boolean(t.vis.rig.powerGlow?.length);
          if (hasPowerGlow && (lowPwr || t.lastLowPower)) {
            stepEntityAnim(
              t.vis,
              t.anim,
              t.last,
              px,
              py,
              t.visYaw,
              dt,
              nowSec,
              this.emitSmoke,
              this.emitWake,
              lowPwr,
              this.emitDust,
              this.emitContrail,
            );
          } else {
            // Only tick smoke stack / battle-damage smoke timer on settled static buildings
            const rig = t.vis.rig;
            if (rig.smokePos && t.vis.root.visible) {
              const k = t.last.k;
              const damaged = t.last.hp < t.last.mhp * 0.55;
              const isStack = k === "factory" || k === "factory2" || k === "refinery" || k === "power" || k === "coalplant";
              if (damaged || isStack) {
                t.anim.smokeCd -= safeDt;
                if (t.anim.smokeCd <= 0) {
                  t.anim.smokeCd = damaged ? 0.28 + Math.random() * 0.2 : 0.9 + Math.random() * 0.5;
                  this.vfx.spawnSmoke(
                    px + rig.smokePos.x * 0.5,
                    rig.smokePos.y,
                    py + rig.smokePos.z * 0.5,
                    damaged,
                  );
                }
              }
            }
          }
          t.lastLowPower = lowPwr;
        } else {
          if (!this.framePosInto(id, snapA, snapB, interpT, pos)) continue;
          const dxVis = pos.x - t.visX;
          const dyVis = pos.y - t.visY;
          if (dxVis * dxVis + dyVis * dyVis > SNAP_JUMP_DIST_SQ) {
            t.visX = pos.x;
            t.visY = pos.y;
          } else {
            t.visX += dxVis * posAlpha;
            t.visY += dyVis * posAlpha;
          }
          let dYaw = pos.d - t.visYaw;
          while (dYaw > Math.PI) dYaw -= Math.PI * 2;
          while (dYaw < -Math.PI) dYaw += Math.PI * 2;
          t.visYaw += dYaw * yawAlpha;
          if (t.visYaw > Math.PI) t.visYaw -= Math.PI * 2;
          else if (t.visYaw < -Math.PI) t.visYaw += Math.PI * 2;

          px = t.visX;
          py = t.visY;
          if (t.staticFrozen) {
            if (t.vis.root.position.x !== px || t.vis.root.position.z !== py) {
              t.vis.root.position.set(px, 0, py);
              t.vis.root.updateMatrix();
              t.vis.root.updateMatrixWorld(true);
            }
          } else {
            t.vis.root.position.x = px;
            t.vis.root.position.z = py;
          }
          if (!t.isBuilding) {
            applyFacing(t.vis.root, t.visYaw);
          }
          stepEntityAnim(
            t.vis,
            t.anim,
            t.last,
            px,
            py,
            t.visYaw,
            dt,
            nowSec,
            this.emitSmoke,
            this.emitWake,
            lowPwr,
            this.emitDust,
            this.emitContrail,
          );
          t.lastLowPower = lowPwr;
        }

        if (this.selection.has(id) && t.vis.root.visible) {
          if (t.last.wp?.length) {
            const wi = this.wpEntries.length;
            let entry = this.wpEntryPool[wi];
            if (!entry) {
              entry = { x: px, y: py, wp: t.last.wp };
              this.wpEntryPool[wi] = entry;
            } else {
              entry.x = px;
              entry.y = py;
              entry.wp = t.last.wp;
            }
            this.wpEntries.push(entry);
          }
          if (
            t.last.rally &&
            (t.last.k === "barracks" ||
              t.last.k === "barracks2" ||
              t.last.k === "factory" ||
              t.last.k === "factory2" ||
              t.last.k === "airfield" ||
              t.last.k === "airfield2" ||
              t.last.k === "shipyard" ||
              t.last.k === "shipyard2")
          ) {
            const ri = this.rallyEntries.length;
            let rEntry = this.rallyEntryPool[ri];
            if (!rEntry) {
              rEntry = { x: px, y: py, rx: t.last.rally[0], ry: t.last.rally[1] };
              this.rallyEntryPool[ri] = rEntry;
            } else {
              rEntry.x = px;
              rEntry.y = py;
              rEntry.rx = t.last.rally[0];
              rEntry.ry = t.last.rally[1];
            }
            this.rallyEntries.push(rEntry);
          }
        }
      }
    }

    // Animate hovering supply crates & pulsing beacon rings
    for (const [id, cv] of this.crateVis) {
      const phase = nowSec * 3.1 + id * 1.7;
      cv.box.position.y = 0.48 + Math.sin(phase) * 0.1;
      cv.box.rotation.y += dt * 1.45;
      const rPulse = 0.7 + Math.sin(phase * 1.35) * 0.14;
      cv.ring.scale.setScalar(rPulse);
      (cv.ring.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.35 * Math.sin(phase * 1.35);
      (cv.beacon.material as THREE.MeshBasicMaterial).opacity = 0.14 + 0.08 * Math.sin(phase * 1.35);
    }

    // Subtle breathing pulse on selected supply hub / supply truck coverage aura rings
    supplyAuraRingMat.opacity = 0.36 + 0.08 * Math.sin(nowSec * 2.6);

    this.waypoints.update(this.wpEntries, nowSec, this.rallyEntries);
    this.vfx.update();
  }

  applyEvents(events: GameEvent[], mySlot = -1) {
    for (const ev of events) {
      if (ev.e === "shot") {
        const shooter = ev.src != null ? this.tracked.get(ev.src) : undefined;
        const isSatLaser = shooter?.last.k === "satlink" && ev.w === "laser";
        this.vfx.spawnShot(
          ev.fx,
          ev.fy,
          ev.tx,
          ev.ty,
          ev.w ?? "bullet",
          ev.vet ?? 0,
          isSatLaser ? 24 : shooter?.vis.rig.altitude,
          shooter?.last.k,
        );
        if (shooter) triggerFireAnim(shooter.anim, ev.fx, ev.fy, ev.tx, ev.ty);
      } else if (ev.e === "intercept") {
        this.vfx.spawnIntercept(ev.fx, ev.fy, ev.tx, ev.ty);
      } else if (ev.e === "boom") {
        this.vfx.spawnBoom(ev.x, ev.y, ev.r);
        if (ev.r >= 1.5) {
          this.gs.shake(Math.min(0.75, ev.r * 0.24));
        }
      } else if (ev.e === "ore") {
        this.gs.setOreCells(ev.cells);
      } else if (ev.e === "hit") {
        const hitEnt = this.tracked.get(ev.id);
        if (hitEnt) triggerHitFlash(hitEnt.anim);
      } else if (ev.e === "superweapon") {
        this.vfx.spawnSuperweapon(ev.x, ev.y);
        this.gs.shake(0.75);
        const tm = setTimeout(() => {
          this.gs.shake(1.85);
          const idx = this.swShakeTimers.indexOf(tm);
          if (idx >= 0) this.swShakeTimers.splice(idx, 1);
        }, 450);
        this.swShakeTimers.push(tm);
      } else if (ev.e === "income") {
        if (mySlot < 0 || ev.slot === mySlot) {
          this.vfx.spawnPopup(ev.x, ev.y, `+$${ev.amt.toLocaleString()}`, "#ffd84d");
        }
      } else if (ev.e === "promote") {
        if (mySlot < 0 || ev.slot === mySlot || this.isVisible(ev.id)) {
          const label = ev.vet >= 3 ? "★★★ HEROIC!" : ev.vet === 2 ? "★★ ELITE!" : "★ VETERAN!";
          const color = ev.vet >= 3 ? "#ff5a36" : ev.vet === 2 ? "#ffd038" : "#f2e496";
          this.vfx.spawnPopup(ev.x, ev.y, label, color);
        }
      } else if (ev.e === "crate") {
        if (mySlot < 0 || ev.slot === mySlot) {
          const col = CRATE_POPUP_COLORS[ev.kind] ?? "#ffd84d";
          this.vfx.spawnPopup(ev.x, ev.y, ev.text || "SUPPLY CRATE!", col);
        }
      } else if (ev.e === "cap") {
        this.vfx.spawnPopup(ev.x, ev.y, "CAPTURED!", "#48eeff");
      } else if (ev.e === "recon") {
        this.vfx.spawnRecon(ev.x, ev.y, ev.r);
        this.vfx.spawnPopup(ev.x, ev.y, "RECON SCAN", "#4ad8ff");
        if (mySlot < 0 || ev.slot === mySlot || this.lastAllies?.has(ev.slot)) {
          this.gs.addReconReveal(ev.x, ev.y, ev.r, 10000);
          if (this.lastVisSlot >= 0) {
            this.applyVisibility(this.lastVisSlot, this.lastAllies);
          }
        }
      }
    }
  }

  mySelectableIds(mySlot: number): number[] {
    const out: number[] = [];
    for (const [id, t] of this.tracked) if (t.last.o === mySlot && !isBuildingKind(t.last.k)) out.push(id);
    return out;
  }

  pickCrateAt(wx: number, wz: number): CrateSnap | null {
    let best: CrateSnap | null = null;
    let bestD2 = 1.2 * 1.2;
    for (const c of this.crates.values()) {
      const dx = c.x - wx;
      const dz = c.y - wz;
      const d2 = dx * dx + dz * dz;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = c;
      }
    }
    return best;
  }

  // Live Fog of War + Fog-lite entity reveal: allied forces & active recon scans share sight,
  // enemy buildings remain visible once scouted, and spectators see everything.
  applyVisibility(mySlot: number, allies?: Set<number>) {
    this.lastAllies = allies;
    this.lastVisSlot = mySlot;
    if (mySlot < 0) {
      for (const [id, t] of this.tracked) {
        const show = id !== this.hiddenEntityId;
        if (t.vis.root.visible !== show) t.vis.root.visible = show;
      }
      for (const cv of this.crateVis.values()) cv.root.visible = true;
      this.gs.updateFog(-1, []);
      return;
    }

    const isFriendly = (o: number) => o === mySlot || (allies?.has(o) ?? false);
    let hasSatlink = false;
    for (const t of this.tracked.values()) {
      if (isFriendly(t.last.o) && t.last.k === "satlink") {
        hasSatlink = true;
        break;
      }
    }
    const visionMult = hasSatlink ? 1.4 : 1.0;

    const visionSources: { x: number; y: number; r: number; subDetectR: number; stealthAirDetectR: number }[] = [];
    for (const t of this.tracked.values()) {
      if (isFriendly(t.last.o)) {
        const k = t.last.k;
        const baseR = t.isBuilding
          ? k === "radar" || k === "superweapon" || k === "satlink"
            ? 17
            : k === "supplyhub"
              ? 15
              : 14
          : (UNITS[k as UnitKind]?.vision ?? 9);
        const r = baseR * visionMult;
        const subDetectR = k === "gunboat" || k === "destroyer" || k === "sub" || k === "carrier" ? 9 : 5.5;
        const stealthAirDetectR =
          k === "radar" ||
          k === "sam" ||
          k === "irondome" ||
          k === "satlink" ||
          k === "interceptor" ||
          k === "uav"
            ? 11
            : 6.5;
        visionSources.push({ x: t.last.x, y: t.last.y, r, subDetectR, stealthAirDetectR });
      }
    }
    const reconZones = this.gs.getActiveReconReveals();

    for (const [id, t] of this.tracked) {
      if (id === this.hiddenEntityId) {
        if (t.vis.root.visible) t.vis.root.visible = false;
        continue;
      }
      const e = t.last;
      if (isFriendly(e.o) || e.o < 0) {
        if (!t.vis.root.visible) t.vis.root.visible = true;
        continue;
      }
      const isStealthedSub = e.k === "sub" && Boolean(e.sub);
      const isStealthedAir = e.k === "stealthbomber" && Boolean(e.sub);
      let vis = false;
      for (const m of visionSources) {
        const dx = m.x - e.x;
        const dy = m.y - e.y;
        const lim = isStealthedSub ? m.subDetectR : isStealthedAir ? m.stealthAirDetectR : m.r;
        if (dx * dx + dy * dy <= lim * lim) {
          vis = true;
          break;
        }
      }
      if (!vis) {
        for (const z of reconZones) {
          const dx = z.x - e.x;
          const dy = z.y - e.y;
          if (dx * dx + dy * dy <= z.r * z.r) {
            vis = true;
            break;
          }
        }
      }
      if (vis) this.seen.add(id);
      const show = vis || (t.isBuilding && this.seen.has(id));
      if (t.vis.root.visible !== show) t.vis.root.visible = show;
    }

    this.gs.updateFog(mySlot, visionSources);
  }

  isVisible(id: number) {
    return this.tracked.get(id)?.vis.root.visible ?? false;
  }

  entScreenPos(id: number): { x: number; y: number } | null {
    const t = this.tracked.get(id);
    if (!t || !t.vis.root.visible) return null;
    const v = this.scratchVec.copy(t.vis.root.position);
    // Air units project at an averaged mid-height between ground ring & flying hull for reliable drag-box selection
    v.y = t.vis.rig.altitude ? t.vis.rig.altitude * 0.42 : 0.5;
    v.project(this.gs.camera);
    // Reject entities behind or clipped outside camera frustum
    if (v.z < -1 || v.z > 1) return null;
    return {
      x: (v.x * 0.5 + 0.5) * this.gs.canvas.clientWidth,
      y: (-v.y * 0.5 + 0.5) * this.gs.canvas.clientHeight,
    };
  }
}
